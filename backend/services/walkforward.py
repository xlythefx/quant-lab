"""
Walk-Forward Optimization (WFA) service.

Roll a fixed-size IS/OOS window across history (sklearn.TimeSeriesSplit),
search params on each IS window with Optuna, evaluate the best on the
following OOS window, then stitch all OOS results into one consolidated
report (equity curve, trades, stats, analytics) shaped exactly like a
normal backtest result — so the existing Analytics page renders it for
free.

One job at a time. Starting a new job cancels the prior one. Runs on a
threading.Thread; progress is emitted via event_bus as `wf_*` socket
events.
"""
from __future__ import annotations

import logging
import math
import multiprocessing as mp
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Any, Optional

import numpy as np
import optuna
from optuna.samplers import TPESampler
from sklearn.model_selection import TimeSeriesSplit

try:
    import psutil   # CPU/utilization sampling for the live run monitor
except ImportError:
    psutil = None

from services import assets, backtest_engine, event_bus, market_data, risk_config, quant_metrics
from services.monte_carlo import _bars_per_year

_BOOTSTRAP_ITERS = 500
_BOOTSTRAP_PCTILES = (2.5, 97.5)


def _fold_extras(df, oos_idx, oos_result, rng, bars_per_year, oos_start_ts=None):
    """Per-fold benchmark + realized vol + bootstrap CI on OOS Sharpe.

    Computed on underlying close (vol, B&H) and strategy equity (Sharpe CI).
    Returns a dict of optional fields to merge into the per-window summary.
    `oos_start_ts`: drop warm-up equity points (flat at starting capital)
    before this epoch so the bootstrap isn't diluted with zero returns.
    """
    out: dict[str, Any] = {}
    if len(oos_idx) >= 2:
        close = df["close"].to_numpy()[oos_idx]
        # B&H — pure close-to-close on the OOS slice.
        if close[0] > 0:
            out["bh_return_pct"] = float((close[-1] / close[0] - 1.0) * 100.0)
        # Annualized realized vol of underlying log returns. Captures regime
        # in a strategy-agnostic way (used by the Regime tab).
        if bars_per_year > 0 and (close > 0).all():
            logret = np.diff(np.log(close))
            if logret.size > 1:
                std = float(np.std(logret, ddof=1))
                out["oos_realized_vol"] = std * math.sqrt(bars_per_year)

    # Nonparametric bootstrap CI on the OOS Sharpe of the *strategy* equity.
    eq_pts = oos_result.get("equity") or []
    if oos_start_ts is not None:
        eq_pts = [p for p in eq_pts if int(p.get("time") or 0) >= int(oos_start_ts)]
    if len(eq_pts) >= 3 and bars_per_year > 0:
        eq = np.asarray([float(p.get("equity") or 0.0) for p in eq_pts], dtype=float)
        if (eq > 0).all():
            r = np.diff(eq) / eq[:-1]
            n = r.size
            if n >= 2:
                sharpes = np.empty(_BOOTSTRAP_ITERS, dtype=float)
                ann = math.sqrt(bars_per_year)
                for i in range(_BOOTSTRAP_ITERS):
                    idx = rng.integers(0, n, size=n)
                    sample = r[idx]
                    mean = float(sample.mean())
                    std = float(sample.std(ddof=1))
                    sharpes[i] = (mean / std) * ann if std > 0 else 0.0
                lo, hi = np.percentile(sharpes, _BOOTSTRAP_PCTILES)
                out["oos_sharpe_ci_low"] = float(lo)
                out["oos_sharpe_ci_high"] = float(hi)
    return out

log = logging.getLogger(__name__)

# Quiet Optuna's per-trial INFO chatter.
optuna.logging.set_verbosity(optuna.logging.WARNING)


def _window_stats(result: dict, window_start_ts: int) -> dict:
    """Recompute engine stats over only the in-window slice of a warm-started run.

    Warm-up bars are flat at starting capital (entries are masked), but leaving
    them in the equity series dilutes per-bar Sharpe by roughly
    sqrt(window / (window + warmup)). The flat prefix also means the engine's
    running peak at window start equals starting capital, so slicing here is
    exactly equivalent to a window-only run with valid indicators.
    """
    pts = [p for p in (result.get("equity") or [])
           if int(p.get("time") or 0) >= int(window_start_ts)]
    if len(pts) < 2:
        return result["stats"]
    eq = np.asarray([p["equity"] for p in pts], dtype=float)
    dd = np.asarray([p["drawdown_dollars"] for p in pts], dtype=float)
    ts = np.asarray([p["time"] for p in pts], dtype=np.int64)
    sc = float(result["stats"]["starting_capital"])
    return backtest_engine._compute_stats(
        result.get("trades") or [], float(result["stats"]["final_equity"]),
        dd, ts, sc, eq,
    )


# ---------------------------------------------------------------------------
# Job registry (one job at a time)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_current_job: Optional["WalkForwardJob"] = None
_last_result: Optional[dict] = None


def get_status() -> dict:
    with _lock:
        job = _current_job
    if job is None:
        return {"state": "idle", "result": _last_result}
    return job.snapshot()


def get_last_result() -> Optional[dict]:
    return _last_result


def cancel_current() -> bool:
    with _lock:
        job = _current_job
    if job is None or job.state not in ("running", "starting"):
        return False
    job.request_cancel()
    return True


def start(spec: dict) -> str:
    """Cancel any running job and start a new one. Returns the new job_id."""
    global _current_job
    with _lock:
        prev = _current_job
    if prev is not None and prev.state in ("running", "starting"):
        prev.request_cancel()
        prev.join(timeout=5.0)

    job = WalkForwardJob(spec)
    with _lock:
        _current_job = job
    job.start()
    return job.job_id


# ---------------------------------------------------------------------------
# Spec normalization
# ---------------------------------------------------------------------------

_METRIC_KEYS = {
    "sharpe": "sharpe",
    "profit_factor": "profit_factor",
    "total_return": "total_return_pct",
}


# Profit factor is capped so a "no losing trades" window (PF undefined → was
# +inf) can't dominate Optuna: a single lucky IS trade used to beat every
# finite-PF configuration. 10 is comfortably above any robust real PF.
_PF_SCORE_CAP = 10.0


def _score_from_stats(stats: dict, metric: str) -> float:
    key = _METRIC_KEYS[metric]
    v = stats.get(key)
    if v is None:
        # profit_factor is None when there are no losses (and >0 profit) or no trades.
        if metric == "profit_factor":
            gp = float(stats.get("gross_profit") or 0.0)
            return _PF_SCORE_CAP if gp > 0 else 0.0
        return 0.0
    if not math.isfinite(float(v)):
        return 0.0
    if metric == "profit_factor":
        return min(float(v), _PF_SCORE_CAP)
    return float(v)


def _normalize_spec(spec: dict) -> dict:
    out = {
        "strategy_id": str(spec["strategy_id"]).strip(),
        "symbol": str(spec["symbol"]).strip(),
        "timeframe": str(spec["timeframe"]).strip(),
        "start_time": int(spec["start_time"]) if spec.get("start_time") is not None else None,
        "end_time": int(spec["end_time"]) if spec.get("end_time") is not None else None,
        "base_params": dict(spec.get("base_params") or {}),
        "search_space": list(spec.get("search_space") or []),
        "is_bars": int(spec.get("is_bars") or 500),
        "oos_bars": int(spec.get("oos_bars") or 100),
        "n_trials": max(1, int(spec.get("n_trials") or 50)),
        "n_workers": max(1, min(64, int(spec.get("n_workers") or 1))),
        "metric": str(spec.get("metric") or "sharpe"),
        "seed": int(spec.get("seed") or 42),
        # Gap between IS and OOS folds — prevents micro-leakage when indicators
        # have lookbacks that straddle the boundary. Bailey/López de Prado.
        "embargo_bars": max(0, int(spec.get("embargo_bars") or 0)),
        # Purged CV: drop the rightmost `purge_radius` IS bars so that trades
        # opened on the IS boundary (which would exit inside OOS) can't bias
        # the in-sample optimization. Purges bars, not trades.
        "purge_radius": max(0, int(spec.get("purge_radius") or 0)),
        # Indicator warm-up: each IS/OOS window's engine run is fed this many
        # extra bars BEFORE the window (signals there are masked off via
        # trade_start_time) so rolling indicators are valid from the window's
        # first bar instead of NaN. Without it, every window started cold and
        # strategies with lookback >= oos_bars produced no OOS signals at all.
        "warmup_bars": max(0, int(spec["warmup_bars"]) if spec.get("warmup_bars") is not None else 200),
        # Minimum IS trades for a trial to be eligible. Default 1 is a bug fix,
        # not a policy: `_score_from_stats` maps a missing stat to 0.0, and a
        # config that never trades has sharpe=None (flat equity → zero vol), so
        # it scored 0.0 — beating every LOSING config. On a bad IS window the
        # optimizer's argmax was therefore "params that don't fire", and that set
        # is what got recommended. Trials below this are PRUNED (not scored), so
        # they also stay out of the plateau / deflated-Sharpe statistics.
        #
        # 1 only stops the "never fires" pathology. It does NOT stop selection on
        # a handful of lucky trades — measured on OPUSDT 15m / vwma_reversion,
        # the median winning config was chosen on 9 IS trades and 82/100 windows
        # picked on fewer than 20. Set this to ~30 if you want each window's pick
        # to rest on a real sample; windows that then report no eligible config
        # are telling you the truth rather than inventing a winner.
        "min_trades": max(0, int(spec["min_trades"]) if spec.get("min_trades") is not None else 1),
    }
    if not out["strategy_id"]:
        raise ValueError("strategy_id is required")
    if out["metric"] not in _METRIC_KEYS:
        raise ValueError(f"unknown metric: {out['metric']}")
    if out["is_bars"] < 10:
        raise ValueError("is_bars must be >= 10")
    if out["oos_bars"] < 1:
        raise ValueError("oos_bars must be >= 1")
    if out["embargo_bars"] >= out["oos_bars"]:
        raise ValueError("embargo_bars must be < oos_bars")
    if out["purge_radius"] >= out["is_bars"]:
        raise ValueError("purge_radius must be < is_bars")
    for entry in out["search_space"]:
        if entry.get("type") not in ("int", "float"):
            raise ValueError(f"search_space entry {entry.get('name')!r} has bad type")
        if entry.get("low") is None or entry.get("high") is None:
            raise ValueError(f"search_space entry {entry.get('name')!r} missing low/high")
        if float(entry["high"]) < float(entry["low"]):
            raise ValueError(f"search_space entry {entry.get('name')!r}: high < low")
    return out


# ---------------------------------------------------------------------------
# Per-window optimization (module-level so it's picklable for ProcessPoolExecutor)
# ---------------------------------------------------------------------------

def _optimize_window_pure(spec: dict, is_warm_start: int, is_start: int, is_end: int,
                          on_trial=None, cancel_check=None):
    """Run one window's Optuna study. Pure function (no job/socket state) so it can
    run in a worker process. `on_trial(trial_idx, score, best_score)` reports
    progress; `cancel_check()->bool` stops the study early. Trials are sequential
    within a window (n_jobs=1) — window-level parallelism comes from running many
    of these across processes, which keeps each window's result reproducible.

    Returns (best_params, best_score, trial_records, audit). `best_score` is None
    when no trial cleared `min_trades` — an honest "this window had no eligible
    config" rather than a manufactured winner.
    """
    s = spec
    track = {"i": 0, "best": None}

    def objective(trial: optuna.Trial) -> float:
        if cancel_check and cancel_check():
            raise optuna.TrialPruned()
        params = dict(s["base_params"])
        for entry in s["search_space"]:
            name = entry["name"]
            low = float(entry["low"]); high = float(entry["high"])
            step = entry.get("step")
            log_scale = bool(entry.get("log", False))
            if entry["type"] == "int":
                params[name] = trial.suggest_int(
                    name, int(low), int(high), step=int(step) if step else 1, log=log_scale)
            else:
                if step:
                    params[name] = trial.suggest_float(name, low, high, step=float(step))
                else:
                    params[name] = trial.suggest_float(name, low, high, log=log_scale)
        result = backtest_engine.run(
            s["strategy_id"], s["symbol"], s["timeframe"],
            params, start_time=is_warm_start, end_time=is_end, trade_start_time=is_start)
        w_stats = _window_stats(result, is_start)
        score = _score_from_stats(w_stats, s["metric"])
        n_trades = int(w_stats.get("trades") or 0)
        eligible = n_trades >= int(s.get("min_trades") or 0)
        track["i"] += 1
        if eligible and (track["best"] is None or score > track["best"]):
            track["best"] = score
        if on_trial:
            # Report the score either way so the progress bar reflects real work;
            # eligibility decides whether the trial can WIN, not whether it ran.
            on_trial(track["i"], score, track["best"])
        if not eligible:
            # Pruned, not scored — keeps a do-nothing config out of both the
            # argmax and the trial-value statistics downstream.
            raise optuna.TrialPruned()
        # How thin a sample this score rests on. Carried to the window summary so
        # the UI can say "chosen on N trades" instead of letting an annualized
        # Sharpe imply the number came from a real sample.
        trial.set_user_attr("n_trades", n_trades)
        return score

    def stop_if_cancelled(study: optuna.Study, _trial) -> None:
        if cancel_check and cancel_check():
            study.stop()

    study = optuna.create_study(direction="maximize", sampler=TPESampler(seed=s["seed"]))
    try:
        study.optimize(objective, n_trials=s["n_trials"], n_jobs=1,
                       callbacks=[stop_if_cancelled], show_progress_bar=False, gc_after_trial=False)
    except optuna.TrialPruned:
        pass

    # Read the winner off the COMPLETE trials rather than `study.best_trial`,
    # which RAISES when every trial was pruned (all below min_trades, or a
    # cancelled study) instead of returning None.
    completed = [t for t in study.trials
                 if t.state == optuna.trial.TrialState.COMPLETE and t.value is not None]
    n_pruned = sum(1 for t in study.trials if t.state == optuna.trial.TrialState.PRUNED)
    if not completed:
        return (dict(s["base_params"]), None, [],
                {"n_eligible": 0, "n_pruned": n_pruned, "best_trades": None})
    best_trial = max(completed, key=lambda t: float(t.value))
    best_params = dict(s["base_params"])
    best_params.update(best_trial.params)
    trial_records = [{"params": t.params, "value": float(t.value)} for t in completed]
    audit = {
        "n_eligible": len(completed),
        "n_pruned": n_pruned,
        "best_trades": best_trial.user_attrs.get("n_trades"),
    }
    return best_params, float(best_trial.value), trial_records, audit


def _task_payload(spec: dict, w: dict) -> dict:
    """Plain, picklable args for one window task (NumPy index arrays stay in the
    parent — the OOS evaluation only needs boundary timestamps)."""
    return {
        "spec": spec, "w_idx": w["w_idx"],
        "is_warm_start": w["is_warm_start"], "is_start": w["is_start"], "is_end": w["is_end"],
        "oos_warm_start": w["oos_warm_start"], "oos_start": w["oos_start"], "oos_end": w["oos_end"],
    }


def _eval_oos(spec: dict, params: dict, payload: dict) -> dict:
    """Run one window's OOS slice with a given param set (warm-started, entries
    before oos_start masked)."""
    return backtest_engine.run(
        spec["strategy_id"], spec["symbol"], spec["timeframe"], params,
        start_time=payload["oos_warm_start"], end_time=payload["oos_end"],
        trade_start_time=payload["oos_start"])


def _optimize_and_eval_task(payload: dict, progress_q, cancel_event) -> dict:
    """Worker entrypoint: optimize a window's params then evaluate the best on its
    OOS slice. Returns plain data the parent stitches. Runs in its own process."""
    spec = payload["spec"]
    w_idx = payload["w_idx"]

    def on_trial(i, score, best):
        try:
            progress_q.put({"type": "trial", "w_idx": w_idx, "trial_idx": i,
                            "score": score, "best_score": best})
        except Exception:
            pass

    def cancel_check():
        try:
            return cancel_event.is_set()
        except Exception:
            return False

    best_params, is_score, optuna_trials, audit = _optimize_window_pure(
        spec, payload["is_warm_start"], payload["is_start"], payload["is_end"],
        on_trial=on_trial, cancel_check=cancel_check)
    if cancel_check():
        return {"w_idx": w_idx, "cancelled": True}
    oos_result = _eval_oos(spec, best_params, payload)
    # Control arm: the SAME window traded with the untuned base params. One extra
    # backtest per window (against n_trials for the search) buys the only honest
    # answer to "did tuning help?" — see WalkForwardJob._tuning_value.
    control_result = _eval_oos(spec, dict(spec["base_params"]), payload)
    return {"w_idx": w_idx, "best_params": best_params, "is_score": is_score,
            "optuna_trials": optuna_trials, "oos_result": oos_result,
            "control_result": control_result, "audit": audit}


# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------

class WalkForwardJob:
    def __init__(self, spec: dict):
        self.spec = _normalize_spec(spec)
        self.job_id = uuid.uuid4().hex[:12]
        self.state = "starting"  # starting | running | done | cancelled | error
        self.cancel_flag = False
        self.started_at = time.time()
        self.error: Optional[str] = None

        # Progress
        self.total_windows = 0
        self.window_idx = 0
        self.trial_idx = 0
        self.current_best_score: Optional[float] = None
        self.window_summaries: list[dict] = []

        # Live run monitor — CPU utilization + how many window-processes are busy.
        self.cpu_percent: float = 0.0
        self.cpu_percent_percore: list[float] = []
        self.active_workers: int = 0
        self.n_workers_effective: int = 1

        # When False, suppress socket events + the global last-result write. The
        # robustness runner drives many inner jobs this way and reads `self.result`.
        self.emit_enabled: bool = True
        self.result: Optional[dict] = None

        self._thread = threading.Thread(target=self._run, name=f"wf-{self.job_id}", daemon=True)

    # ---- public ------------------------------------------------------------

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: Optional[float] = None) -> None:
        self._thread.join(timeout=timeout)

    def is_alive(self) -> bool:
        return self._thread.is_alive()

    def request_cancel(self) -> None:
        self.cancel_flag = True

    def _eta(self) -> Optional[float]:
        # Wall-clock time per completed window already reflects parallel
        # throughput (more workers → windows complete faster → smaller `per`),
        # so the linear estimate is parallel-aware. Null until the first window
        # finishes (a full first wave is still in flight).
        if self.state == "running" and self.window_idx > 0 and self.total_windows > 0:
            per = (time.time() - self.started_at) / self.window_idx
            return max(0.0, per * (self.total_windows - self.window_idx))
        return None

    def snapshot(self) -> dict:
        return {
            "state": self.state,
            "job_id": self.job_id,
            "spec": {k: self.spec[k] for k in (
                "strategy_id", "symbol", "timeframe", "is_bars", "oos_bars",
                "n_trials", "metric", "min_trades",
            )},
            "window_idx": self.window_idx,
            "total_windows": self.total_windows,
            "trial_idx": self.trial_idx,
            "current_best_score": self.current_best_score,
            "elapsed_seconds": time.time() - self.started_at,
            "eta_seconds": self._eta(),
            "cpu_percent": self.cpu_percent,
            "cpu_percent_percore": self.cpu_percent_percore,
            "active_workers": self.active_workers,
            "n_workers": self.n_workers_effective,
            "windows": self.window_summaries,
            "error": self.error,
        }

    # ---- thread ------------------------------------------------------------

    def _emit(self, event: str, payload: dict) -> None:
        if not self.emit_enabled:
            return
        event_bus.emit(event, {"job_id": self.job_id, **payload})

    def _resource_sampler(self, stop_event: threading.Event) -> None:
        """Background thread: every ~1s push CPU utilization (overall + per-core),
        how many window-processes are busy, elapsed, and ETA to the UI."""
        if psutil is None:
            return
        try:
            psutil.cpu_percent(None)               # prime the overall counter
            psutil.cpu_percent(None, percpu=True)   # prime the per-core counters
        except Exception:
            return
        while not stop_event.wait(1.0):
            try:
                self.cpu_percent = float(psutil.cpu_percent(None))
                self.cpu_percent_percore = [float(x) for x in psutil.cpu_percent(None, percpu=True)]
            except Exception:
                continue
            self._emit("wf_resources", {
                "cpu_percent": self.cpu_percent,
                "cpu_percent_percore": self.cpu_percent_percore,
                "active_workers": self.active_workers,
                "n_workers": self.n_workers_effective,
                "elapsed_seconds": time.time() - self.started_at,
                "eta_seconds": self._eta(),
            })

    def _run(self) -> None:
        stop_sampler = threading.Event()
        sampler = threading.Thread(target=self._resource_sampler, args=(stop_sampler,),
                                   name=f"wf-cpu-{self.job_id}", daemon=True)
        sampler.start()
        try:
            self.state = "running"
            self._do_run()
            if self.cancel_flag:
                self.state = "cancelled"
                self._emit("wf_cancelled", {})
            else:
                self.state = "done"
        except Exception as e:
            log.exception("walk-forward job failed")
            self.error = str(e)
            self.state = "error"
            self._emit("wf_error", {"message": str(e)})
        finally:
            stop_sampler.set()
            self.active_workers = 0

    def _do_run(self) -> None:
        s = self.spec
        df = market_data.load_parquet(s["symbol"], s["timeframe"])
        if s["start_time"] is not None:
            df = df[df["time"] >= int(s["start_time"])]
        if s["end_time"] is not None:
            df = df[df["time"] <= int(s["end_time"])]
        df = df.reset_index(drop=True)

        total = len(df)
        # sklearn TimeSeriesSplit requires n_splits >= 2 (at least 2 folds).
        # min_bars: is_bars (for IS window) + embargo (gap) + oos_bars (test fold)
        # + oos_bars (stride for fold 2) + purge_radius (dropped from IS edge).
        min_bars = s["is_bars"] + 2 * s["oos_bars"] + s["embargo_bars"] + s["purge_radius"]
        if total < min_bars:
            raise ValueError(
                f"not enough bars for walk-forward: have {total}, need at least "
                f"is_bars + 2*oos_bars + embargo + purge = {min_bars}"
            )

        # How many full IS+OOS windows fit, stepping by oos_bars after the
        # initial IS chunk. Embargo eats into the effective stride.
        effective_step = s["oos_bars"]
        n_splits = max(2, (total - s["is_bars"] - s["embargo_bars"]) // effective_step)
        splitter = TimeSeriesSplit(
            n_splits=n_splits,
            max_train_size=s["is_bars"],
            test_size=s["oos_bars"],
            gap=s["embargo_bars"],
        )
        self.total_windows = n_splits

        rc = risk_config.get()
        starting_capital = float(rc["starting_capital"])

        # Fixed-contract futures (same detection as backtest_engine ~L220) do
        # NOT compound — `contracts` is constant regardless of equity, so each
        # window's P&L is an absolute dollar amount. Stitch those additively;
        # multiplicative rebasing would invent compounding the sizing model
        # can't deliver. Crypto %-of-equity sizing keeps the multiplicative
        # stitch (a window's return really would have applied to the carried
        # equity).
        _wf_broker = market_data.broker_for(s["symbol"], s["timeframe"]) or market_data.BROKER_DEFAULT
        _wf_meta = assets.get(s["symbol"], _wf_broker)
        contract_sized = (_wf_meta.asset_class in ("equity_index_future", "futures")
                          and _wf_meta.contract_size > 1.0)

        # Aggregation state — chained OOS equity / trades / dd
        stitched_equity_pts: list[dict] = []     # {time, equity, value, drawdown, drawdown_dollars}
        stitched_trades: list[dict] = []
        carry_equity = starting_capital
        peak_eq = starting_capital
        time_a_all: list[int] = []
        equity_arr_all: list[float] = []
        dd_dollars_arr_all: list[float] = []

        time_col = df["time"].to_numpy()
        if len(time_col) >= 2 and not np.all(np.diff(time_col) > 0):
            raise ValueError("time column is not monotonically increasing — data may be corrupt or unsorted")
        bars_per_year = _bars_per_year(time_col)
        rng = np.random.default_rng(s["seed"])
        # Use a dummy X with same length as df — TimeSeriesSplit only needs len.
        dummy = np.zeros(total)

        # ---- Build every window's boundaries up front (cheap) ----
        windows: list[dict] = []
        for w_idx, (is_idx, oos_idx) in enumerate(splitter.split(dummy)):
            # Purged CV: drop the rightmost `purge_radius` IS bars. Trades opened
            # on those bars could exit inside OOS, biasing IS optimization toward
            # params that exploit lookahead.
            if s["purge_radius"] > 0:
                is_idx = is_idx[:-s["purge_radius"]]
            # Warm-up: feed the engine extra history before each window so rolling
            # indicators are valid at the window start; pre-window entries are
            # masked via trade_start_time.
            warm = s["warmup_bars"]
            windows.append({
                "w_idx": w_idx,
                "is_idx": is_idx, "oos_idx": oos_idx,
                "is_start": int(time_col[is_idx[0]]),
                "is_end": int(time_col[is_idx[-1]]),
                "oos_start": int(time_col[oos_idx[0]]),
                "oos_end": int(time_col[oos_idx[-1]]),
                "is_warm_start": int(time_col[max(0, int(is_idx[0]) - warm)]),
                "oos_warm_start": int(time_col[max(0, int(oos_idx[0]) - warm)]),
            })
        self.total_windows = len(windows)

        # ---- Optimize + OOS-evaluate every window (parallel across CPUs) ----
        # The heavy part (Optuna study + OOS backtest) is independent per window,
        # so we farm windows out to separate processes — real cores, no GIL. Each
        # window is seeded independently, so results are reproducible regardless of
        # how many workers run. The cheap, order-dependent stitch happens after, in
        # the parent. With 1 worker (or 1 window) we run inline to skip the
        # process-spawn overhead.
        n_workers = min(int(s["n_workers"]), len(windows))
        self.n_workers_effective = max(1, n_workers)
        if n_workers <= 1:
            results = self._run_windows_sequential(windows, df, bars_per_year)
        else:
            results = self._run_windows_parallel(windows, df, bars_per_year, n_workers)

        if self.cancel_flag:
            return

        # Workers may finish out of order — restore window order for the report.
        self.window_summaries.sort(key=lambda x: x["window_idx"])

        # ---- Stitch each window's OOS curve onto the running aggregate (in order) ----
        for w in windows:
            r = results.get(w["w_idx"])
            if not r or "oos_result" not in r:
                continue  # window failed or was cancelled before finishing
            w_idx = w["w_idx"]
            oos_start = w["oos_start"]
            oos_result = r["oos_result"]

            sub_run_capital = float(oos_result["stats"]["starting_capital"])  # Always == global starting_capital
            # Futures fixed-contract trades are absolute dollars — never scale.
            multiplier_carry = (1.0 if contract_sized
                                else carry_equity / sub_run_capital if sub_run_capital > 0 else 1.0)

            # Skip the first IN-WINDOW equity point of every window after the
            # first: it's the pre-trade `starting_capital` of the sub-run, which
            # after rebase equals the *previous* window's last point exactly.
            # Keeping it produces a duplicate bar at the boundary and injects a
            # 0% return into the per-bar return series — that depresses the
            # stitched equity-return std and inflates the aggregate Sharpe by
            # ~1-2%. Warm-up points (time < oos_start, flat at starting capital
            # by construction) are dropped entirely.
            first_kept = True
            for pt in oos_result["equity"]:
                if int(pt.get("time") or 0) < oos_start:
                    continue  # warm-up bar — not part of this OOS window
                if first_kept:
                    first_kept = False
                    if w_idx > 0:
                        continue
                # Validate equity point schema; skip malformed points with warning.
                if not isinstance(pt.get("equity"), (int, float)) or not isinstance(pt.get("time"), (int, float)):
                    log.warning(f"window {w_idx+1}: malformed equity point skipped: {pt}")
                    continue
                if contract_sized:
                    # Rebase additively: carry + window's dollar P&L so far.
                    eq = carry_equity + (float(pt["equity"]) - sub_run_capital)
                else:
                    # Rebase this point onto the running equity (preserve % shape).
                    local_mult = pt["equity"] / sub_run_capital if sub_run_capital > 0 else 1.0
                    eq = carry_equity * local_mult
                # Guard against window ruin: if equity hit ≤ 0, clip to 0 and log.
                if eq <= 0:
                    log.warning(f"window {w_idx+1}: equity hit zero at time {pt['time']} — clipping")
                    eq = 0.0
                peak_eq = max(peak_eq, eq)
                dd_dollars = eq - peak_eq
                stitched_equity_pts.append({
                    "time": int(pt["time"]),
                    "equity": float(eq),
                    "value": float(eq / starting_capital * 100.0),
                    "drawdown": float(dd_dollars / starting_capital * 100.0),
                    "drawdown_dollars": float(dd_dollars),
                })
                time_a_all.append(int(pt["time"]))
                equity_arr_all.append(float(eq))
                dd_dollars_arr_all.append(float(dd_dollars))

            for tr in oos_result["trades"]:
                # pnl_dollars is scaled to the stitched portfolio size. pnl_pct_equity
                # is defined as pnl_dollars / starting_capital * 100, so it scales in
                # lockstep: a trade that was 10% of $1000 becomes 10% of $1500 (via
                # scaled pnl_dollars / same starting_capital constant).
                # Futures: multiplier_carry is pinned to 1.0 — fixed-contract
                # dollars (and their fees) pass through unscaled.
                stitched_trades.append({
                    **tr,
                    "pnl_dollars":    float(tr["pnl_dollars"]) * multiplier_carry,
                    "fees":           float(tr.get("fees", 0.0)) * multiplier_carry,
                    "pnl_pct_equity": float(tr.get("pnl_pct_equity", 0.0)) * multiplier_carry,
                })

            # Carry forward.
            if oos_result["equity"]:
                last_pt = oos_result["equity"][-1]
                if contract_sized:
                    carry_equity = carry_equity + (float(last_pt["equity"]) - sub_run_capital)
                else:
                    local_mult_last = (last_pt["equity"] / sub_run_capital) if sub_run_capital > 0 else 1.0
                    carry_equity = carry_equity * local_mult_last

        if self.cancel_flag:
            return

        # Aggregate stats + analytics from the stitched curve.
        from services.strategy_registry import get_strategy_class
        strategy_cls = get_strategy_class(s["strategy_id"])
        # Use the LAST window's best_params for the analytics-strategy stub
        # (only used to read its sessions config for session classification).
        ref_params = (
            self.window_summaries[-1]["best_params"] if self.window_summaries else s["base_params"]
        )
        strategy = strategy_cls(ref_params)
        # Minimal sig_df with `time` column for exposure_pct calc.
        import pandas as pd
        sig_df = pd.DataFrame({"time": time_a_all}) if time_a_all else pd.DataFrame({"time": []})

        equity_arr = np.asarray(equity_arr_all, dtype=float)
        dd_dollars_arr = np.asarray(dd_dollars_arr_all, dtype=float)
        time_a = np.asarray(time_a_all, dtype=float)

        # Bundle Optuna trial history + per-window IS/OOS scores so the
        # quant_metrics module can compute parameter stability, deflated
        # Sharpe, and walk-forward efficiency.
        all_trials: list[dict] = []
        per_window_trials: list[list] = []
        window_picks: list[dict] = []
        window_pairs: list[dict] = []
        best_oos_sharpe: Optional[float] = None
        for w in self.window_summaries:
            w_trials = w.get("optuna_trials") or []
            all_trials.extend(w_trials)
            window_picks.append(dict(w.get("best_params") or {}))
            # Grouped per window as well: the parameter-plateau score measures
            # flatness AROUND EACH WINDOW'S OWN WINNER, which the pooled list
            # can't express (trials from different windows aren't comparable —
            # scores depend on that window's market regime, not just its params).
            per_window_trials.append(w_trials)
            oos_stats = w.get("oos_stats") or {}
            # Preserve None (window Sharpe not computable) — coercing to 0.0
            # would count the window as "flat" in robustness denominators.
            _s = oos_stats.get("sharpe")
            oos_sharpe = float(_s) if _s is not None and math.isfinite(float(_s)) else None
            window_pairs.append({
                "is_score": w.get("is_score"),
                "oos_sharpe": oos_sharpe,
                "oos_return_pct": float(oos_stats.get("total_return_pct") or 0.0),
            })
            if oos_sharpe is not None and (best_oos_sharpe is None or oos_sharpe > best_oos_sharpe):
                best_oos_sharpe = oos_sharpe
        wf_trials = {
            "optuna_trials": all_trials,
            "window_trials": per_window_trials,
            "search_space": s["search_space"],
            "window_picks": window_picks,
            "window_pairs": window_pairs,
            "best_sharpe_oos": best_oos_sharpe,
            # The IS optimization metric — deflated Sharpe / WFE are only
            # computed downstream when this is "sharpe" (unit-commensurable).
            "metric": s["metric"],
        }

        if len(equity_arr) > 0:
            stats = backtest_engine._compute_stats(
                stitched_trades, float(equity_arr[-1]), dd_dollars_arr,
                time_a, starting_capital, equity_arr,
            )
            analytics = backtest_engine._compute_analytics(
                stitched_trades, stitched_equity_pts, sig_df, strategy, starting_capital,
                wf_trials=wf_trials,
                # No sessions_cfg override: the WF page no longer carries a
                # hand-maintained session config. _compute_analytics falls back
                # to the strategy's own `sessions` param, so any session
                # breakdown it produces describes what actually traded rather
                # than a label set that could drift out of sync.
            )
        else:
            _empty = backtest_engine._empty_result(s["strategy_id"], s["symbol"], s["timeframe"], rc)
            stats = _empty["stats"]
            analytics = _empty["analytics"]

        # Trading-cost attribution over the stitched OOS trades: how much of the
        # net PnL went to commissions vs slippage. Net comes from the equity
        # curve (stats); slippage is estimated from the configured bps.
        costs = quant_metrics.cost_attribution(
            stitched_trades, stats.get("total_return_dollars", 0.0),
            rc.get("slippage_bps", 0.0),
        )

        deploy_candidate = self._build_deploy_candidate(windows)
        tuning_value = self._tuning_value()

        result = {
            "strategy_id": s["strategy_id"],
            "symbol": s["symbol"],
            "timeframe": s["timeframe"],
            "risk_config": rc,
            "params": ref_params,
            "deploy_candidate": deploy_candidate,
            "tuning_value": tuning_value,
            "wf_spec": {
                "is_bars": s["is_bars"],
                "oos_bars": s["oos_bars"],
                "n_trials": s["n_trials"],
                "metric": s["metric"],
                "search_space": s["search_space"],
                "base_params": s["base_params"],
                "start_time": s["start_time"],
                "end_time": s["end_time"],
                "embargo_bars": s["embargo_bars"],
                "purge_radius": s["purge_radius"],
                "min_trades": s["min_trades"],
                "warmup_bars": s["warmup_bars"],
            },
            "windows": self.window_summaries,
            # Empty candles/overlays: WFA result reuses analytics UI, not the
            # candle chart. Keep keys for shape parity with backtest results.
            "candles": [],
            "overlays": [],
            "trades": stitched_trades,
            "equity": stitched_equity_pts,
            "stats": stats,
            "analytics": analytics,
            "costs": costs,
        }

        self.result = result
        if self.emit_enabled:
            global _last_result
            _last_result = result
        self._emit("wf_complete", {"result": result})

    # ---- did tuning beat NOT tuning? --------------------------------------

    def _tuning_value(self) -> Optional[dict]:
        """The control experiment, run inline: per window, the OOS result of the
        TUNED pick against the SAME window traded with the untuned base_params.

        This is the one number that says whether the optimization step earns its
        keep. Everything else in the report — stitched curve, WFE, green rate,
        deflated Sharpe — is measured only on the tuned arm, so all of it looks
        identical whether the search found a real optimum or sampled noise.

        Measured on OPUSDT 15m / vwma_reversion (100 windows, IS=2000, OOS=500,
        50 trials): the tuned arm compounded to -2.84% while the untouched
        defaults made +1.43%, the tuned arm produced zero trades in 26 windows
        against 0 for the defaults, and corr(IS score, OOS Sharpe) was -0.058.
        The search was actively harmful and nothing else in the report showed it.

        Returns None when no window carried a control arm.
        """
        rows = [w for w in self.window_summaries if w.get("control_stats")]
        if not rows:
            return None

        def _side(key: str) -> dict:
            stats = [(w["oos_stats"] if key == "tuned" else w["control_stats"]) for w in rows]
            compounded = 1.0
            for st in stats:
                compounded *= (1.0 + float(st.get("total_return_pct") or 0.0) / 100.0)
            sharpes = [float(st["sharpe"]) for st in stats
                       if st.get("sharpe") is not None and math.isfinite(float(st["sharpe"]))]
            return {
                "compounded_return_pct": (compounded - 1.0) * 100.0,
                "windows_green": sum(1 for st in stats
                                     if float(st.get("total_return_pct") or 0.0) > 0),
                "windows_zero_trade": sum(1 for st in stats if int(st.get("trades") or 0) == 0),
                # Averaged only over windows that actually traded — the two arms
                # skip different windows, so this is NOT a like-for-like compare.
                # `compounded_return_pct` and the zero-trade counts are.
                "mean_sharpe": float(np.mean(sharpes)) if sharpes else None,
                "n_sharpe": len(sharpes),
            }

        # Does a high in-sample score predict the next window at all? ~0 means the
        # tuning carries no information about what happens next.
        pairs = [(w.get("is_score"), (w.get("oos_stats") or {}).get("sharpe")) for w in rows]
        pairs = [(float(a), float(b)) for a, b in pairs
                 if a is not None and b is not None
                 and math.isfinite(float(a)) and math.isfinite(float(b))]
        corr = None
        if len(pairs) >= 4:
            a = np.asarray([p[0] for p in pairs]); b = np.asarray([p[1] for p in pairs])
            if a.std() > 1e-12 and b.std() > 1e-12:
                corr = float(np.corrcoef(a, b)[0, 1])

        # How thin a sample each window's winner was chosen on.
        picked_on = [int(w["best_trades"]) for w in rows
                     if isinstance(w.get("best_trades"), (int, float))]

        tuned = _side("tuned")
        control = _side("control")
        return {
            "n_windows": len(rows),
            "tuned": tuned,
            "control": control,
            "tuning_edge_pct": tuned["compounded_return_pct"] - control["compounded_return_pct"],
            "is_oos_correlation": corr,
            "median_is_trades_behind_pick": (float(np.median(picked_on)) if picked_on else None),
            "windows_picked_on_thin_sample": sum(1 for n in picked_on if n < 20),
            "n_picked_on_known": len(picked_on),
        }

    # ---- deploy candidate --------------------------------------------------

    def _build_deploy_candidate(self, windows: list) -> Optional[dict]:
        """One fixed parameter set you could actually deploy — with its real number.

        Walk-forward validates a PROCEDURE ("re-optimize every N bars and trade
        the result"). Its stitched OOS curve, WFE and per-window green rate are
        evidence about that procedure, not about any single parameter set. So
        naming one set "recommended" on the strength of those numbers is a
        category error — and the set previously named that way was the worst
        possible choice: the argmax of one in-sample window, never validated.

        Instead: take the MEDIAN of each tuned param across every window (a value
        the windows agree on, rather than one window's lucky pick), then BACKTEST
        that set over the combined out-of-sample span and report what it actually
        did. Two contrasts sit beside it on the same span — the last window's pick
        (what this box used to recommend) and the untuned baseline (what you'd get
        by not running any of this).

        Caveat the box cannot fix: the median is taken per-parameter and
        independently, so on a strategy whose params interact it can synthesize a
        combination no window ever chose. `agreement[*].spread` is the tell — a
        spread near 0.289 is what UNIFORM RANDOM draws over the range produce, so
        at or above that the windows agreed on nothing and the median is an
        average of noise.

        Honesty note carried to the UI: this span is out-of-sample relative to
        each window's tuning, but it is not virgin data — you have now looked at
        it. The locked holdout is still the only untouched test.

        Returns None when there is nothing to summarize; never raises.
        """
        s = self.spec
        summaries = self.window_summaries
        tuned = [e["name"] for e in (s["search_space"] or [])]
        if not summaries or not tuned:
            return None
        try:
            types = {e["name"]: e.get("type") for e in s["search_space"]}
            # Search range per param — the denominator that makes a spread
            # comparable across params measured in different units.
            spans = {}
            for e in s["search_space"]:
                width = float(e["high"]) - float(e["low"])
                spans[e["name"]] = width if width > 0 else None
            warm_by_start = {w["oos_start"]: w["oos_warm_start"] for w in windows}

            consensus = dict(s["base_params"])
            agreement: dict[str, dict] = {}
            for name in tuned:
                vals = [w["best_params"][name] for w in summaries
                        if isinstance(w.get("best_params", {}).get(name), (int, float))
                        and not isinstance(w["best_params"][name], bool)]
                if not vals:
                    continue
                med = float(np.median(vals))
                consensus[name] = int(round(med)) if types.get(name) == "int" else med
                span = spans.get(name)
                agreement[name] = {
                    "value": consensus[name],
                    "picks": vals,
                    "min": float(min(vals)),
                    "max": float(max(vals)),
                    # Spread of the windows' picks as a fraction of the search
                    # range: 0 = every window landed on the same value, so the
                    # median is a value the data agrees on. 0.289 is the value a
                    # UNIFORM RANDOM draw produces — at or above it, the search
                    # found nothing.
                    "spread": (float(np.std(vals)) / span) if span else None,
                }

            oos_start = int(summaries[0]["oos_start"])
            oos_end = int(summaries[-1]["oos_end"])
            warm_start = int(warm_by_start.get(oos_start, oos_start))

            def _evaluate(params: dict) -> Optional[dict]:
                res = backtest_engine.run(
                    s["strategy_id"], s["symbol"], s["timeframe"], params,
                    start_time=warm_start, end_time=oos_end, trade_start_time=oos_start)
                return _window_stats(res, oos_start)

            last_params = dict(summaries[-1].get("best_params") or {})
            return {
                "params": consensus,
                "tuned": {n: consensus[n] for n in tuned if n in consensus},
                "stats": _evaluate(consensus),
                "agreement": agreement,
                "oos_start": oos_start,
                "oos_end": oos_end,
                "n_windows": len(summaries),
                # The old "recommended" set, scored on the same span for contrast.
                "last_window": {
                    "window_idx": summaries[-1].get("window_idx"),
                    "params": last_params,
                    "tuned": {n: last_params[n] for n in tuned if n in last_params},
                    "stats": _evaluate(last_params) if last_params else None,
                },
                # The untuned baseline on the same span. If this beats both of the
                # sets above, the whole search cost you money.
                "baseline": {
                    "params": dict(s["base_params"]),
                    "tuned": {n: s["base_params"][n] for n in tuned if n in s["base_params"]},
                    "stats": _evaluate(dict(s["base_params"])),
                },
            }
        except Exception:
            # A deploy candidate is a nice-to-have summary — never let it take
            # down a walk-forward run that otherwise completed.
            log.exception("deploy candidate evaluation failed")
            return None

    # ---- window execution -------------------------------------------------

    def _finalize_window(self, w: dict, r: dict, df, bars_per_year: float) -> None:
        """Build a window's summary from its worker result (parent-side: needs the
        OOS index slice for benchmark/vol). Safe to call as windows finish out of
        order — summaries are sorted by window_idx before the final report."""
        s = self.spec
        oos_result = r["oos_result"]
        # Per-window seeded RNG so the bootstrap Sharpe CI is reproducible no
        # matter which order the windows complete in.
        rng_w = np.random.default_rng(s["seed"] + int(w["w_idx"]))
        extras = _fold_extras(df, w["oos_idx"], oos_result, rng_w, bars_per_year,
                              oos_start_ts=w["oos_start"])
        is_score = r["is_score"]
        audit = r.get("audit") or {}
        summary = {
            "window_idx": w["w_idx"] + 1,
            "is_start": w["is_start"],
            "is_end": w["is_end"],
            "oos_start": w["oos_start"],
            "oos_end": w["oos_end"],
            "best_params": r["best_params"],
            "is_score": float(is_score) if is_score is not None and math.isfinite(is_score) else None,
            # In-window stats only (warm-up bars excluded — see _window_stats).
            "oos_stats": _window_stats(oos_result, w["oos_start"]),
            "optuna_trials": r["optuna_trials"],
            # How many IS trades the winning config was chosen on, plus how many
            # trials never cleared min_trades. A pick resting on a handful of
            # trades is noise no matter how good its annualized Sharpe looks.
            "best_trades": audit.get("best_trades"),
            "n_eligible_trials": audit.get("n_eligible"),
            "n_pruned_trials": audit.get("n_pruned"),
            **extras,
        }
        control = r.get("control_result")
        if control is not None:
            # Same window, untuned params — the control arm for _tuning_value.
            summary["control_stats"] = _window_stats(control, w["oos_start"])
        self.window_summaries.append(summary)
        self._emit("wf_window_done", {"window": summary})

    def _run_windows_sequential(self, windows: list, df, bars_per_year: float) -> dict:
        """One window at a time, in the job thread. Used for 1 worker / 1 window —
        keeps the live per-trial progress bar and avoids process-spawn overhead."""
        s = self.spec
        results: dict[int, dict] = {}
        for w in windows:
            if self.cancel_flag:
                break
            self.active_workers = 1
            self.window_idx = w["w_idx"] + 1
            self.trial_idx = 0

            def on_trial(i, score, best):
                self.trial_idx = i
                if best is not None:
                    self.current_best_score = best
                self._emit("wf_progress", {
                    "window_idx": self.window_idx,
                    "total_windows": self.total_windows,
                    "trial_idx": i,
                    "n_trials": s["n_trials"],
                    "current_score": score,
                })

            best_params, is_score, optuna_trials, audit = _optimize_window_pure(
                s, w["is_warm_start"], w["is_start"], w["is_end"],
                on_trial=on_trial, cancel_check=lambda: self.cancel_flag)
            if self.cancel_flag:
                break
            payload = _task_payload(s, w)
            oos_result = _eval_oos(s, best_params, payload)
            control_result = _eval_oos(s, dict(s["base_params"]), payload)
            r = {"w_idx": w["w_idx"], "best_params": best_params, "is_score": is_score,
                 "optuna_trials": optuna_trials, "oos_result": oos_result,
                 "control_result": control_result, "audit": audit}
            results[w["w_idx"]] = r
            self._finalize_window(w, r, df, bars_per_year)
        self.active_workers = 0
        return results

    def _run_windows_parallel(self, windows: list, df, bars_per_year: float, n_workers: int) -> dict:
        """Optimize windows across `n_workers` processes (true multi-core). A
        background thread drains per-trial progress from a shared queue and keeps
        the UI bar moving; a shared cancel Event lets the Stop button reach the
        workers. Summaries are finalized in the parent as each window returns."""
        s = self.spec
        results: dict[int, dict] = {}
        ctx = mp.get_context("spawn")

        with ctx.Manager() as mgr:
            q = mgr.Queue()
            cancel_event = mgr.Event()
            drain_stop = threading.Event()

            def drain():
                while not drain_stop.is_set():
                    if self.cancel_flag:
                        try: cancel_event.set()
                        except Exception: pass
                    try:
                        msg = q.get(timeout=0.2)
                    except Exception:
                        continue
                    if msg.get("type") == "trial":
                        self.trial_idx = msg["trial_idx"]
                        if msg.get("best_score") is not None:
                            self.current_best_score = msg["best_score"]
                        self._emit("wf_progress", {
                            "window_idx": self.window_idx,
                            "total_windows": self.total_windows,
                            "trial_idx": msg["trial_idx"],
                            "n_trials": s["n_trials"],
                            "current_score": msg.get("score"),
                        })

            dt = threading.Thread(target=drain, name=f"wf-drain-{self.job_id}", daemon=True)
            dt.start()
            try:
                with ProcessPoolExecutor(max_workers=n_workers, mp_context=ctx) as ex:
                    futs = {
                        ex.submit(_optimize_and_eval_task, _task_payload(s, w), q, cancel_event): w
                        for w in windows
                    }
                    self.active_workers = min(n_workers, len(windows))
                    completed = 0
                    for fut in as_completed(futs):
                        if self.cancel_flag:
                            try: cancel_event.set()
                            except Exception: pass
                        w = futs[fut]
                        try:
                            r = fut.result()
                        except Exception:
                            log.exception("walk-forward window %s failed", w["w_idx"])
                            continue
                        if r.get("cancelled"):
                            continue
                        results[w["w_idx"]] = r
                        completed += 1
                        self.window_idx = completed
                        # Saturated pool runs min(workers, remaining) at once.
                        self.active_workers = min(n_workers, len(windows) - completed)
                        self._finalize_window(w, r, df, bars_per_year)
            finally:
                drain_stop.set()
        return results
