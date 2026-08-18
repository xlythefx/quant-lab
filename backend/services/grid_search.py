"""
Grid Search service.

Exhaustively backtests every combination of user-supplied parameter values
across a single date range (no IS/OOS split). Returns per-combo stats so the
UI can show a sortable table, a 1D line chart, or a 2D heatmap.

One job at a time. Starting a new job cancels the prior one. Runs on a
threading.Thread; progress is emitted via event_bus as `gs_*` socket events.
"""
from __future__ import annotations

import itertools
import logging
import math
import multiprocessing as mp
import os
import threading
import time
import uuid
from concurrent.futures import ProcessPoolExecutor, as_completed
from typing import Any, Optional

from services import assets, backtest_engine, event_bus, market_data, risk_config

try:
    import psutil   # CPU/utilization sampling for the live run monitor
except Exception:   # pragma: no cover - optional dep
    psutil = None

log = logging.getLogger(__name__)

# Hard cap — refuse to start jobs above this. Soft warn (~500) is enforced
# client-side via the /estimate endpoint.
MAX_COMBOS = 5000


# ---------------------------------------------------------------------------
# Parallel combo execution (module-level so it's picklable for
# ProcessPoolExecutor under the Windows "spawn" start method)
# ---------------------------------------------------------------------------

# Per-worker state, populated once by the pool initializer so each combo task
# only ships its own param overrides across the wire — not the whole DataFrame.
_WORKER: dict = {}


def _combo_worker_init(strategy_id, symbol, timeframe, broker,
                       start_time, end_time, base_params, risk_snapshot):
    """Runs once per worker process: load the dataset a single time and stash the
    shared run() args. Without this, every combo would re-read the parquet from
    disk (load_parquet does not cache in-process)."""
    global _WORKER
    df = market_data.load_parquet(symbol, timeframe, broker=broker)
    _WORKER = {
        "strategy_id": strategy_id, "symbol": symbol, "timeframe": timeframe,
        "broker": broker, "start_time": start_time, "end_time": end_time,
        "base_params": base_params, "risk": risk_snapshot, "df": df,
    }


def _combo_task(combo_idx: int, names: list, combo_values: tuple):
    """Run one combo's backtest inside a worker. Returns (combo_idx, params, stats).
    A backtest is deterministic given (params, data, costs), so grid results are
    identical at any worker count — only the wall-clock changes."""
    w = _WORKER
    params = dict(w["base_params"])
    for name, value in zip(names, combo_values):
        params[name] = value
    result = backtest_engine.run(
        w["strategy_id"], w["symbol"], w["timeframe"], params,
        start_time=w["start_time"], end_time=w["end_time"],
        df=w["df"], broker=w["broker"], risk_overrides=w["risk"], stats_only=True,
    )
    return combo_idx, {n: v for n, v in zip(names, combo_values)}, (result.get("stats") or {})


# ---------------------------------------------------------------------------
# Job registry (one job at a time)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_current_job: Optional["GridSearchJob"] = None
_last_result: Optional[dict] = None
_last_avg_per_combo_sec: Optional[float] = None  # used for /estimate


def get_status() -> dict:
    with _lock:
        job = _current_job
    if job is None:
        return {"state": "idle", "result": _last_result}
    return job.snapshot()


def get_last_result() -> Optional[dict]:
    return _last_result


def get_last_avg_seconds() -> Optional[float]:
    return _last_avg_per_combo_sec


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

    job = GridSearchJob(spec)
    with _lock:
        _current_job = job
    job.start()
    return job.job_id


# ---------------------------------------------------------------------------
# Spec helpers
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
        if metric == "profit_factor":
            gp = float(stats.get("gross_profit") or 0.0)
            return float("inf") if gp > 0 else 0.0
        return 0.0
    if not math.isfinite(float(v)):
        return 0.0
    return float(v)


def _resolve_broker(symbol: str, explicit) -> Optional[str]:
    """Which broker namespace to load the dataset from.

    An explicit broker (if the caller ever passes one) always wins. Otherwise,
    futures symbols are pinned to databento — the canonical CME feed these grids
    run against — so a symbol cached under multiple brokers can't silently load a
    different dataset than the Dashboard. Non-futures (crypto) keep broker=None
    auto-discovery, so this change doesn't touch them."""
    if explicit:
        return str(explicit).strip()
    meta = assets.lookup(symbol, "databento")
    if meta is not None and meta.asset_class == "futures":
        return "databento"
    return None


def _normalize_spec(spec: dict) -> dict:
    grid_params = []
    for entry in (spec.get("grid_params") or []):
        if entry.get("type") not in ("int", "float"):
            raise ValueError(f"grid_param {entry.get('name')!r} has bad type")
        name = str(entry.get("name") or "").strip()
        if not name:
            raise ValueError("grid_param missing name")
        raw_values = entry.get("values") or []
        if not isinstance(raw_values, (list, tuple)) or len(raw_values) == 0:
            raise ValueError(f"grid_param {name!r} needs at least one value")
        # Coerce + dedupe (preserve user order otherwise).
        seen = set()
        values: list[Any] = []
        for v in raw_values:
            try:
                num = int(v) if entry["type"] == "int" else float(v)
            except (TypeError, ValueError):
                raise ValueError(f"grid_param {name!r} has non-numeric value: {v!r}")
            if num in seen:
                continue
            seen.add(num)
            values.append(num)
        grid_params.append({"name": name, "type": entry["type"], "values": values})

    if not grid_params:
        raise ValueError("grid_params must include at least one param with values")

    total = 1
    for gp in grid_params:
        total *= len(gp["values"])
    # Interactive callers stay at MAX_COMBOS (5000); the Overnight Run passes an
    # explicit max_combos (up to the hard ceiling of 10000) since it runs
    # unattended. HARD_CEILING caps everything regardless of caller.
    HARD_CEILING = 10000
    cap = min(int(spec.get("max_combos") or MAX_COMBOS), HARD_CEILING)
    if total > cap:
        raise ValueError(
            f"grid would produce {total} combos (limit: {cap}). "
            f"Narrow your values or sweep fewer params."
        )

    # Optional early-stop: stop the sweep as soon as a combo's trade count is
    # within ±tolerance of this target. None => exhaustive (full grid).
    target_trades = spec.get("target_trades")
    if target_trades in ("", None):
        target_trades = None
    else:
        try:
            target_trades = int(target_trades)
        except (TypeError, ValueError):
            raise ValueError(f"target_trades must be an integer, got {target_trades!r}")
        if target_trades < 0:
            raise ValueError("target_trades must be >= 0")
    try:
        target_trades_tol = int(spec.get("target_trades_tol") or 0)
    except (TypeError, ValueError):
        raise ValueError("target_trades_tol must be an integer")
    if target_trades_tol < 0:
        raise ValueError("target_trades_tol must be >= 0")

    try:
        n_workers = int(spec.get("n_workers") or 1)
    except (TypeError, ValueError):
        n_workers = 1
    n_workers = max(1, min(64, os.cpu_count() or 1, n_workers))

    symbol = str(spec["symbol"]).strip()
    out = {
        "strategy_id": str(spec["strategy_id"]).strip(),
        "symbol": symbol,
        "timeframe": str(spec["timeframe"]).strip(),
        "broker": _resolve_broker(symbol, spec.get("broker")),
        "start_time": int(spec["start_time"]) if spec.get("start_time") is not None else None,
        "end_time": int(spec["end_time"]) if spec.get("end_time") is not None else None,
        "base_params": dict(spec.get("base_params") or {}),
        "grid_params": grid_params,
        "metric": str(spec.get("metric") or "sharpe"),
        "target_trades": target_trades,
        "target_trades_tol": target_trades_tol,
        "n_workers": n_workers,
        # Optional frozen cost snapshot (Overnight Run passes one so every asset
        # is costed identically across a multi-hour batch). None => read live.
        "risk_snapshot": spec.get("risk_snapshot"),
    }
    if not out["strategy_id"]:
        raise ValueError("strategy_id is required")
    if out["metric"] not in _METRIC_KEYS:
        raise ValueError(f"unknown metric: {out['metric']}")
    return out


def estimate(spec: dict) -> dict:
    """Project combo count + duration for a candidate spec. Read-only; no
    job is started. Returns {combos, projected_seconds, warn, refuse, error?}."""
    try:
        grid_params = []
        for entry in (spec.get("grid_params") or []):
            if entry.get("type") not in ("int", "float"):
                continue
            raw_values = entry.get("values") or []
            if not isinstance(raw_values, (list, tuple)) or len(raw_values) == 0:
                continue
            count = len({float(v) for v in raw_values if isinstance(v, (int, float))})
            if count > 0:
                grid_params.append(count)
        if not grid_params:
            return {"combos": 0, "projected_seconds": 0.0, "warn": False, "refuse": False}
        total = 1
        for k in grid_params:
            total *= k
        avg = _last_avg_per_combo_sec or 1.0  # 1s/combo is a conservative cold-cache guess
        try:
            nw = max(1, int(spec.get("n_workers") or 1))
        except (TypeError, ValueError):
            nw = 1
        return {
            "combos": total,
            # Projected wall-clock: combos share out across workers (the caller
            # sends n_workers=1 when early-stop is on, since that stays serial).
            "projected_seconds": float(total) * float(avg) / nw,
            "warn": total > 500,
            "refuse": total > MAX_COMBOS,
        }
    except Exception as e:
        return {"combos": 0, "projected_seconds": 0.0, "warn": False, "refuse": True, "error": str(e)}


# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------

class GridSearchJob:
    def __init__(self, spec: dict):
        self.spec = _normalize_spec(spec)
        self.job_id = uuid.uuid4().hex[:12]
        self.state = "starting"  # starting | running | done | cancelled | error
        self.cancel_flag = False
        self.started_at = time.time()
        self.error: Optional[str] = None

        # Total = product of value-list lengths.
        total = 1
        for gp in self.spec["grid_params"]:
            total *= len(gp["values"])
        self.total_combos = total
        self.combo_idx = 0
        self.current_best_metric: Optional[float] = None
        self.results: list[dict] = []  # [{combo_idx, params, stats}]
        self.stopped_early = False        # set when the trade-count target is hit
        self.target_match: Optional[dict] = None  # {combo_idx, params, trades}
        # Frozen at run start so every combo is costed identically (editing
        # Risk Settings mid-sweep must not change costs between combos) and so
        # the published result records the fees it was actually charged.
        self.risk_config_snapshot: Optional[dict] = None

        # Live resource monitor (mirrors Walk Forward's CPU meter).
        self.n_workers = int(self.spec.get("n_workers") or 1)
        self.n_workers_effective = 1          # actual, after clamping to combo count
        self.active_workers = 0
        self.cpu_percent = 0.0
        self.cpu_percent_percore: list[float] = []

        # When False (a muted child driven by the Overnight Run), suppress all
        # socket emits and the module-global last-result writes, and expose the
        # finished result on `self.result` for the parent to read. Mirrors the
        # WalkForwardJob.emit_enabled pattern used by walkforward_robustness.
        self.emit_enabled = True
        self.result: Optional[dict] = None

        self._thread = threading.Thread(target=self._run, name=f"gs-{self.job_id}", daemon=True)

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
        if self.state == "running" and self.combo_idx > 0 and self.total_combos > 0:
            per = elapsed / self.combo_idx
            eta = max(0.0, per * (self.total_combos - self.combo_idx))
        return {
            "state": self.state,
            "job_id": self.job_id,
            "spec": {
                "strategy_id": self.spec["strategy_id"],
                "symbol": self.spec["symbol"],
                "timeframe": self.spec["timeframe"],
                "metric": self.spec["metric"],
                "grid_params": self.spec["grid_params"],
                "target_trades": self.spec.get("target_trades"),
                "target_trades_tol": self.spec.get("target_trades_tol"),
            },
            "combo_idx": self.combo_idx,
            "total_combos": self.total_combos,
            "current_best_metric": self.current_best_metric,
            "elapsed_seconds": elapsed,
            "eta_seconds": eta,
            "error": self.error,
            "stopped_early": self.stopped_early,
            "target_match": self.target_match,
            # resource monitor (so a mid-run page refresh rehydrates the CPU meter)
            "n_workers": self.n_workers_effective,
            "active_workers": self.active_workers,
            "cpu_percent": self.cpu_percent,
            "cpu_percent_percore": self.cpu_percent_percore,
        }

    # ---- thread ------------------------------------------------------------

    def _emit(self, event: str, payload: dict) -> None:
        if not self.emit_enabled:
            return
        event_bus.emit(event, {"job_id": self.job_id, **payload})

    def _resource_sampler(self, stop_event: threading.Event) -> None:
        """Background thread: every ~1s push CPU utilization (overall + per-core),
        how many worker processes are busy, elapsed, and ETA to the UI. Mirrors
        Walk Forward's sampler so both share the same CpuMeter widget."""
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
            elapsed = time.time() - self.started_at
            eta = None
            if self.combo_idx > 0 and self.total_combos > 0:
                per = elapsed / self.combo_idx
                eta = max(0.0, per * (self.total_combos - self.combo_idx))
            self._emit("gs_resources", {
                "cpu_percent": self.cpu_percent,
                "cpu_percent_percore": self.cpu_percent_percore,
                "active_workers": self.active_workers,
                "n_workers": self.n_workers_effective,
                "elapsed_seconds": elapsed,
                "eta_seconds": eta,
            })

    def _run(self) -> None:
        stop_sampler = threading.Event()
        sampler = threading.Thread(target=self._resource_sampler, args=(stop_sampler,),
                                   name=f"gs-cpu-{self.job_id}", daemon=True)
        sampler.start()
        try:
            self.state = "running"
            self._do_run()
            if self.cancel_flag:
                self.state = "cancelled"
                self._emit("gs_cancelled", {})
            else:
                self.state = "done"
        except Exception as e:
            log.exception("grid-search job failed")
            self.error = str(e)
            self.state = "error"
            self._emit("gs_error", {"message": str(e)})
        finally:
            stop_sampler.set()
            self.active_workers = 0

    def _do_run(self) -> None:
        s = self.spec
        names = [gp["name"] for gp in s["grid_params"]]
        value_lists = [gp["values"] for gp in s["grid_params"]]
        target_trades = s.get("target_trades")

        # Use the batch's frozen snapshot if one was injected (Overnight Run), so
        # every asset in a multi-hour run is costed identically; else read live.
        rc_snapshot = s.get("risk_snapshot") or risk_config.get()
        self.risk_config_snapshot = rc_snapshot

        # Clamp the requested range to the strategy's per-symbol tradeable floor
        # (e.g. Lunar on ES → 2018-01-01 .. 2026-04-30). The UI auto-fills the
        # date pickers with the full dataset span, so without this the explicit
        # start/end bypass the floor that the engine applies on None — making
        # grid-search trade counts diverge from the Dashboard. Clamping (not
        # overriding) still honors a user who narrows the range within the floor.
        floor_start, floor_end = backtest_engine.symbol_floor_bounds(
            backtest_engine.get_strategy_class(s["strategy_id"]), s["symbol"]
        )
        if floor_start is not None:
            s["start_time"] = floor_start if s["start_time"] is None else max(s["start_time"], floor_start)
        if floor_end is not None:
            s["end_time"] = floor_end if s["end_time"] is None else min(s["end_time"], floor_end)

        # Early-stop ("stop at trades") halts at the FIRST combo in scan order that
        # hits the target — a meaning that only holds when combos run in order. So
        # it stays single-core (deterministic). The exhaustive sweep — the slow
        # case that actually needs cores — fans out across worker processes.
        if s["n_workers"] > 1 and target_trades is None:
            self.n_workers_effective = max(1, min(s["n_workers"], self.total_combos))
            self._run_parallel(names, value_lists, rc_snapshot)
        else:
            self.n_workers_effective = 1
            self.active_workers = 1
            self._run_sequential(names, value_lists, rc_snapshot)

        if self.cancel_flag:
            # Stash partial results so the UI can still render what we got.
            self._publish_result(partial=True)
            return

        # stopped_early is also "partial" (we did not sweep the full grid), but
        # it's a successful stop, not a cancel — _run() leaves state == done.
        self._publish_result(partial=self.stopped_early)

    def _run_sequential(self, names: list, value_lists: list, rc_snapshot: dict) -> None:
        """Single-core sweep in scan order. Handles the optional early-stop, which
        is only deterministic while serial."""
        s = self.spec
        best_metric: Optional[float] = None
        target_trades = s.get("target_trades")
        target_tol = int(s.get("target_trades_tol") or 0)
        # Load once from the pinned broker; the engine copies it per combo. broker
        # is forwarded to run() too so the recorded run is consistent.
        df = market_data.load_parquet(s["symbol"], s["timeframe"], broker=s["broker"])

        for combo_idx, combo in enumerate(itertools.product(*value_lists), start=1):
            if self.cancel_flag:
                break

            self.combo_idx = combo_idx
            params = dict(s["base_params"])
            for name, value in zip(names, combo):
                params[name] = value

            result = backtest_engine.run(
                s["strategy_id"], s["symbol"], s["timeframe"],
                params, start_time=s["start_time"], end_time=s["end_time"],
                df=df, broker=s["broker"], risk_overrides=rc_snapshot, stats_only=True,
            )
            stats = result.get("stats") or {}
            metric_value = _score_from_stats(stats, s["metric"])

            row = {
                "combo_idx": combo_idx,
                "params": {n: v for n, v in zip(names, combo)},
                "stats": stats,
            }
            self.results.append(row)

            if best_metric is None or metric_value > best_metric:
                best_metric = metric_value
            self.current_best_metric = best_metric

            self._emit("gs_progress", {
                "combo_idx": combo_idx,
                "total_combos": self.total_combos,
                "current_metric_value": metric_value,
                "current_best_metric": best_metric,
                "params": row["params"],
            })

            # Optional early-stop: first combo whose trade count lands within
            # ±tolerance of the target ends the sweep. None => never triggers.
            if target_trades is not None:
                n_trades = int(stats.get("trades") or 0)
                if abs(n_trades - target_trades) <= target_tol:
                    self.stopped_early = True
                    self.target_match = {
                        "combo_idx": combo_idx,
                        "params": row["params"],
                        "trades": n_trades,
                    }
                    self._emit("gs_target_hit", {
                        "combo_idx": combo_idx,
                        "params": row["params"],
                        "trades": n_trades,
                        "target_trades": target_trades,
                        "target_trades_tol": target_tol,
                    })
                    break

    def _run_parallel(self, names: list, value_lists: list, rc_snapshot: dict) -> None:
        """Exhaustive sweep fanned out across worker processes (true multi-core).
        Combos are independent and deterministic, so the results are identical to
        the serial sweep — we just re-sort by combo index at the end. Progress
        counts completions (which arrive out of order); the bar still fills 0→100."""
        s = self.spec
        n_workers = self.n_workers_effective
        best_metric: Optional[float] = None
        combos = list(enumerate(itertools.product(*value_lists), start=1))

        ctx = mp.get_context("spawn")
        # The pool initializer loads the dataset once per worker; each task then
        # ships only its own param overrides. base_params is copied for pickling.
        init_args = (s["strategy_id"], s["symbol"], s["timeframe"], s["broker"],
                     s["start_time"], s["end_time"], dict(s["base_params"]), rc_snapshot)

        completed = 0
        with ProcessPoolExecutor(max_workers=n_workers, mp_context=ctx,
                                 initializer=_combo_worker_init, initargs=init_args) as ex:
            futs = {ex.submit(_combo_task, ci, names, combo): ci for ci, combo in combos}
            self.active_workers = min(n_workers, len(combos))
            for fut in as_completed(futs):
                if self.cancel_flag:
                    ex.shutdown(wait=False, cancel_futures=True)
                    break
                try:
                    ci, params, stats = fut.result()
                except Exception:
                    log.exception("grid-search combo failed")
                    completed += 1
                    self.combo_idx = completed
                    continue

                metric_value = _score_from_stats(stats, s["metric"])
                self.results.append({"combo_idx": ci, "params": params, "stats": stats})
                if best_metric is None or metric_value > best_metric:
                    best_metric = metric_value
                self.current_best_metric = best_metric

                completed += 1
                self.combo_idx = completed
                self.active_workers = max(0, min(n_workers, len(combos) - completed))
                self._emit("gs_progress", {
                    "combo_idx": completed,
                    "total_combos": self.total_combos,
                    "current_metric_value": metric_value,
                    "current_best_metric": best_metric,
                    "params": params,
                })

        # Publish in scan order so the table/heatmap match the serial sweep exactly.
        self.results.sort(key=lambda r: r["combo_idx"])

    def _publish_result(self, partial: bool) -> None:
        s = self.spec
        elapsed = time.time() - self.started_at

        result = {
            "strategy_id": s["strategy_id"],
            "symbol": s["symbol"],
            "timeframe": s["timeframe"],
            "broker": s["broker"],
            "metric": s["metric"],
            "grid_params": s["grid_params"],
            "base_params": s["base_params"],
            "start_time": s["start_time"],
            "end_time": s["end_time"],
            "results": self.results,
            "total_combos": self.total_combos,
            "completed_combos": self.combo_idx,
            "elapsed_seconds": elapsed,
            "partial": partial,
            "risk_config": self.risk_config_snapshot,
            "target_trades": s.get("target_trades"),
            "target_trades_tol": s.get("target_trades_tol"),
            "stopped_early": self.stopped_early,
            "target_match": self.target_match,
        }
        # Always expose the finished result for a parent (Overnight Run) to read.
        self.result = result

        # A muted child must NOT touch the interactive Grid UI's module globals
        # or emit gs_complete — only real interactive runs do.
        if self.emit_enabled:
            if self.total_combos > 0 and self.combo_idx > 0:
                global _last_avg_per_combo_sec
                _last_avg_per_combo_sec = elapsed / self.combo_idx
            global _last_result
            _last_result = result
            self._emit("gs_complete", {"result": result})
