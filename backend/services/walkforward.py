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
import threading
import time
import uuid
from typing import Any, Optional

import numpy as np
import optuna
from optuna.samplers import TPESampler
from sklearn.model_selection import TimeSeriesSplit

from services import backtest_engine, event_bus, market_data, risk_config
from services.monte_carlo import _bars_per_year

_BOOTSTRAP_ITERS = 500
_BOOTSTRAP_PCTILES = (2.5, 97.5)


def _fold_extras(df, oos_idx, oos_result, rng, bars_per_year):
    """Per-fold benchmark + realized vol + bootstrap CI on OOS Sharpe.

    Computed on underlying close (vol, B&H) and strategy equity (Sharpe CI).
    Returns a dict of optional fields to merge into the per-window summary.
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


def _score_from_stats(stats: dict, metric: str) -> float:
    key = _METRIC_KEYS[metric]
    v = stats.get(key)
    if v is None:
        # profit_factor is None when there are no losses (and >0 profit) or no trades.
        if metric == "profit_factor":
            gp = float(stats.get("gross_profit") or 0.0)
            return float("inf") if gp > 0 else 0.0
        return 0.0
    if not math.isfinite(float(v)):
        return 0.0
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

        self._thread = threading.Thread(target=self._run, name=f"wf-{self.job_id}", daemon=True)

    # ---- public ------------------------------------------------------------

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: Optional[float] = None) -> None:
        self._thread.join(timeout=timeout)

    def request_cancel(self) -> None:
        self.cancel_flag = True

    def snapshot(self) -> dict:
        elapsed = time.time() - self.started_at
        eta = None
        if self.state == "running" and self.window_idx > 0 and self.total_windows > 0:
            per = elapsed / self.window_idx
            eta = max(0.0, per * (self.total_windows - self.window_idx))
        return {
            "state": self.state,
            "job_id": self.job_id,
            "spec": {k: self.spec[k] for k in (
                "strategy_id", "symbol", "timeframe", "is_bars", "oos_bars",
                "n_trials", "metric",
            )},
            "window_idx": self.window_idx,
            "total_windows": self.total_windows,
            "trial_idx": self.trial_idx,
            "current_best_score": self.current_best_score,
            "elapsed_seconds": elapsed,
            "eta_seconds": eta,
            "windows": self.window_summaries,
            "error": self.error,
        }

    # ---- thread ------------------------------------------------------------

    def _emit(self, event: str, payload: dict) -> None:
        event_bus.emit(event, {"job_id": self.job_id, **payload})

    def _run(self) -> None:
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

    def _do_run(self) -> None:
        s = self.spec
        df = market_data.load_parquet(s["symbol"], s["timeframe"])
        if s["start_time"] is not None:
            df = df[df["time"] >= int(s["start_time"])]
        if s["end_time"] is not None:
            df = df[df["time"] <= int(s["end_time"])]
        df = df.reset_index(drop=True)

        total = len(df)
        # sklearn TimeSeriesSplit requires n_splits >= 2.
        # Need extra room for embargo (between IS and OOS) and purge (off IS edge).
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

        # Aggregation state — chained OOS equity / trades / dd
        stitched_equity_pts: list[dict] = []     # {time, equity, value, drawdown, drawdown_dollars}
        stitched_trades: list[dict] = []
        carry_equity = starting_capital
        peak_eq = starting_capital
        time_a_all: list[int] = []
        equity_arr_all: list[float] = []
        dd_dollars_arr_all: list[float] = []

        time_col = df["time"].to_numpy()
        bars_per_year = _bars_per_year(time_col)
        rng = np.random.default_rng(s["seed"])
        # Use a dummy X with same length as df — TimeSeriesSplit only needs len.
        dummy = np.zeros(total)

        for w_idx, (is_idx, oos_idx) in enumerate(splitter.split(dummy)):
            if self.cancel_flag:
                break

            # Purged CV: drop the rightmost `purge_radius` IS bars. Trades
            # opened on those bars could exit inside OOS, so they'd bias the
            # in-sample optimization toward parameters that exploit lookahead.
            if s["purge_radius"] > 0:
                is_idx = is_idx[:-s["purge_radius"]]

            self.window_idx = w_idx + 1
            is_start = int(time_col[is_idx[0]])
            is_end = int(time_col[is_idx[-1]])
            oos_start = int(time_col[oos_idx[0]])
            oos_end = int(time_col[oos_idx[-1]])

            best_params, is_score, optuna_trials = self._optimize_window(
                is_start, is_end
            )

            if self.cancel_flag:
                break

            # Evaluate best params on OOS window.
            oos_result = backtest_engine.run(
                s["strategy_id"], s["symbol"], s["timeframe"],
                best_params, start_time=oos_start, end_time=oos_end,
            )

            # Stitch this window's OOS curve onto the running aggregate.
            window_start_cap = float(oos_result["stats"]["starting_capital"])
            multiplier_carry = carry_equity / window_start_cap if window_start_cap > 0 else 1.0

            # Skip the first equity point of every window after the first: it's
            # the pre-trade `starting_capital` of the sub-run, which after rebase
            # equals the *previous* window's last point exactly. Keeping it
            # produces a duplicate bar at the boundary and injects a 0% return
            # into the per-bar return series — that depresses the stitched
            # equity-return std and inflates the aggregate Sharpe by ~1-2%.
            skip_first_pt = w_idx > 0

            for i, pt in enumerate(oos_result["equity"]):
                if skip_first_pt and i == 0:
                    continue
                # Rebase this point onto the running equity (preserve % shape).
                local_mult = pt["equity"] / window_start_cap if window_start_cap > 0 else 1.0
                eq = carry_equity * local_mult
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
                # pnl_pct_equity must rescale in lockstep with pnl_dollars so
                # the per-trade distribution histogram reflects the stitched
                # portfolio, not the per-window local capital.
                stitched_trades.append({
                    **tr,
                    "pnl_dollars":    float(tr["pnl_dollars"]) * multiplier_carry,
                    "fees":           float(tr.get("fees", 0.0)) * multiplier_carry,
                    "pnl_pct_equity": float(tr.get("pnl_pct_equity", 0.0)) * multiplier_carry,
                })

            # Carry forward.
            if oos_result["equity"]:
                last_pt = oos_result["equity"][-1]
                local_mult_last = (last_pt["equity"] / window_start_cap) if window_start_cap > 0 else 1.0
                carry_equity = carry_equity * local_mult_last

            # Per-window summary + per-fold extras (B&H, realized vol, Sharpe CI).
            extras = _fold_extras(df, oos_idx, oos_result, rng, bars_per_year)
            summary = {
                "window_idx": w_idx + 1,
                "is_start": is_start,
                "is_end": is_end,
                "oos_start": oos_start,
                "oos_end": oos_end,
                "best_params": best_params,
                "is_score": float(is_score) if is_score is not None and math.isfinite(is_score) else None,
                "oos_stats": oos_result["stats"],
                "optuna_trials": optuna_trials,
                **extras,
            }
            self.window_summaries.append(summary)
            self._emit("wf_window_done", {"window": summary})

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
        window_pairs: list[dict] = []
        best_oos_sharpe: Optional[float] = None
        for w in self.window_summaries:
            for tr in (w.get("optuna_trials") or []):
                all_trials.append(tr)
            oos_stats = w.get("oos_stats") or {}
            oos_sharpe = float(oos_stats.get("sharpe") or 0.0)
            window_pairs.append({
                "is_score": w.get("is_score"),
                "oos_sharpe": oos_sharpe,
                "oos_return_pct": float(oos_stats.get("total_return_pct") or 0.0),
            })
            if best_oos_sharpe is None or oos_sharpe > best_oos_sharpe:
                best_oos_sharpe = oos_sharpe
        wf_trials = {
            "optuna_trials": all_trials,
            "window_pairs": window_pairs,
            "best_sharpe_oos": best_oos_sharpe,
        }

        if len(equity_arr) > 0:
            stats = backtest_engine._compute_stats(
                stitched_trades, float(equity_arr[-1]), dd_dollars_arr,
                time_a, starting_capital, equity_arr,
            )
            analytics = backtest_engine._compute_analytics(
                stitched_trades, stitched_equity_pts, sig_df, strategy, starting_capital,
                wf_trials=wf_trials,
                sessions_cfg_override=s.get("sessions_cfg"),
            )
        else:
            stats = backtest_engine._empty_result(s["strategy_id"], s["symbol"], s["timeframe"], rc)["stats"]
            analytics = backtest_engine._empty_result(s["strategy_id"], s["symbol"], s["timeframe"], rc)["analytics"]

        result = {
            "strategy_id": s["strategy_id"],
            "symbol": s["symbol"],
            "timeframe": s["timeframe"],
            "risk_config": rc,
            "params": ref_params,
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
        }

        global _last_result
        _last_result = result
        self._emit("wf_complete", {"result": result})

    # ---- per-window optimization ------------------------------------------

    def _optimize_window(self, is_start: int, is_end: int):
        s = self.spec
        self.trial_idx = 0  # reset per window so progress bar resets

        def objective(trial: optuna.Trial) -> float:
            if self.cancel_flag:
                # Stops the study cleanly via the callback below; raising
                # TrialPruned avoids logging a failed trial.
                raise optuna.TrialPruned()
            params = dict(s["base_params"])
            for entry in s["search_space"]:
                name = entry["name"]
                low = float(entry["low"])
                high = float(entry["high"])
                step = entry.get("step")
                log_scale = bool(entry.get("log", False))
                if entry["type"] == "int":
                    params[name] = trial.suggest_int(
                        name, int(low), int(high),
                        step=int(step) if step else 1,
                        log=log_scale,
                    )
                else:
                    if step:
                        params[name] = trial.suggest_float(name, low, high, step=float(step))
                    else:
                        params[name] = trial.suggest_float(name, low, high, log=log_scale)
            result = backtest_engine.run(
                s["strategy_id"], s["symbol"], s["timeframe"],
                params, start_time=is_start, end_time=is_end,
            )
            score = _score_from_stats(result["stats"], s["metric"])
            self.trial_idx += 1
            # Throttle progress events: every trial is fine, payload is tiny.
            self._emit("wf_progress", {
                "window_idx": self.window_idx,
                "total_windows": self.total_windows,
                "trial_idx": self.trial_idx,
                "n_trials": s["n_trials"],
                "current_score": score,
            })
            return score

        def stop_if_cancelled(study: optuna.Study, _trial) -> None:
            if self.cancel_flag:
                study.stop()
            else:
                self.current_best_score = float(study.best_value) if study.best_trial else None

        study = optuna.create_study(
            direction="maximize",
            sampler=TPESampler(seed=s["seed"]),
        )
        # n_trials may run a bit short if cancelled mid-study.
        try:
            study.optimize(
                objective,
                n_trials=s["n_trials"],
                n_jobs=s.get("n_workers", 1),
                callbacks=[stop_if_cancelled],
                show_progress_bar=False,
                gc_after_trial=False,
            )
        except optuna.TrialPruned:
            pass

        if not study.trials or study.best_trial is None:
            # No usable trial — fall back to base params with a NaN score.
            return dict(s["base_params"]), None, []

        best_params = dict(s["base_params"])
        best_params.update(study.best_params)
        trial_records = [
            {"params": t.params, "value": (float(t.value) if t.value is not None else None)}
            for t in study.trials
            if t.state == optuna.trial.TrialState.COMPLETE
        ]
        return best_params, study.best_value, trial_records
