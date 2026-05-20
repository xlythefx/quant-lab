"""
Cost Sensitivity Sweep service.

Runs a fixed strategy/params/symbol/range at multiple execution-cost levels
(slippage_bps, fee_pct, or fee_flat) to see how the strategy's edge holds up
as real-world costs increase. Answers "what slippage kills my Sharpe?".

One job at a time. Mirrors grid_search's structure: threading.Thread, event
bus progress emission, one-job singleton, start/cancel/status/last_result.
"""
from __future__ import annotations

import logging
import math
import threading
import time
import uuid
from typing import Any, Optional

from services import backtest_engine, event_bus

log = logging.getLogger(__name__)

# Risk-config keys we allow sweeping. Other keys (starting_capital, risk_pct,
# pyramiding) wouldn't make sense as a "cost" sweep — they'd be a different
# feature.
_ALLOWED_DIMS = {"slippage_bps", "fee_pct", "fee_flat"}

# Hard cap on sweep size. Each value is one full backtest; 50 is more than
# enough to draw a smooth curve.
MAX_SWEEP_VALUES = 50


# ---------------------------------------------------------------------------
# Job registry (one job at a time)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_current_job: Optional["CostSweepJob"] = None
_last_result: Optional[dict] = None
_last_avg_per_run_sec: Optional[float] = None


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

    job = CostSweepJob(spec)
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


def _normalize_spec(spec: dict) -> dict:
    sweep_dim = str(spec.get("sweep_dim") or "").strip()
    if sweep_dim not in _ALLOWED_DIMS:
        raise ValueError(f"sweep_dim must be one of {sorted(_ALLOWED_DIMS)}")

    raw_values = spec.get("sweep_values") or []
    if not isinstance(raw_values, (list, tuple)) or len(raw_values) == 0:
        raise ValueError("sweep_values must be a non-empty list")

    seen: set[float] = set()
    values: list[float] = []
    for v in raw_values:
        try:
            num = float(v)
        except (TypeError, ValueError):
            raise ValueError(f"sweep_values has non-numeric entry: {v!r}")
        if num < 0:
            raise ValueError(f"sweep_values must be non-negative; got {num}")
        if num in seen:
            continue
        seen.add(num)
        values.append(num)
    values.sort()
    if len(values) > MAX_SWEEP_VALUES:
        raise ValueError(
            f"sweep would produce {len(values)} runs (limit: {MAX_SWEEP_VALUES}). "
            f"Reduce the number of values."
        )

    metric = str(spec.get("metric") or "sharpe")
    if metric not in _METRIC_KEYS:
        raise ValueError(f"unknown metric: {metric}")

    strategy_id = str(spec["strategy_id"]).strip()
    if not strategy_id:
        raise ValueError("strategy_id is required")

    return {
        "strategy_id": strategy_id,
        "symbol":      str(spec["symbol"]).strip(),
        "timeframe":   str(spec["timeframe"]).strip(),
        "start_time":  int(spec["start_time"]) if spec.get("start_time") is not None else None,
        "end_time":    int(spec["end_time"]) if spec.get("end_time") is not None else None,
        "params":      dict(spec.get("params") or {}),
        "sweep_dim":   sweep_dim,
        "sweep_values": values,
        "metric":      metric,
    }


# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------

class CostSweepJob:
    def __init__(self, spec: dict):
        self.spec = _normalize_spec(spec)
        self.job_id = uuid.uuid4().hex[:12]
        self.state = "starting"  # starting | running | done | cancelled | error
        self.cancel_flag = False
        self.started_at = time.time()
        self.error: Optional[str] = None

        self.total_runs = len(self.spec["sweep_values"])
        self.run_idx = 0
        self.current_best_metric: Optional[float] = None
        self.results: list[dict] = []

        self._thread = threading.Thread(target=self._run, name=f"cs-{self.job_id}", daemon=True)

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
        if self.state == "running" and self.run_idx > 0 and self.total_runs > 0:
            per = elapsed / self.run_idx
            eta = max(0.0, per * (self.total_runs - self.run_idx))
        return {
            "state": self.state,
            "job_id": self.job_id,
            "spec": {
                "strategy_id": self.spec["strategy_id"],
                "symbol":      self.spec["symbol"],
                "timeframe":   self.spec["timeframe"],
                "sweep_dim":   self.spec["sweep_dim"],
                "sweep_values": self.spec["sweep_values"],
                "metric":      self.spec["metric"],
            },
            "run_idx": self.run_idx,
            "total_runs": self.total_runs,
            "current_best_metric": self.current_best_metric,
            "elapsed_seconds": elapsed,
            "eta_seconds": eta,
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
                self._emit("cs_cancelled", {})
            else:
                self.state = "done"
        except Exception as e:
            log.exception("cost-sweep job failed")
            self.error = str(e)
            self.state = "error"
            self._emit("cs_error", {"message": str(e)})

    def _do_run(self) -> None:
        s = self.spec
        best_metric: Optional[float] = None

        for i, value in enumerate(s["sweep_values"], start=1):
            if self.cancel_flag:
                break

            self.run_idx = i
            risk_overrides = {s["sweep_dim"]: float(value)}

            result = backtest_engine.run(
                s["strategy_id"], s["symbol"], s["timeframe"],
                s["params"], start_time=s["start_time"], end_time=s["end_time"],
                risk_overrides=risk_overrides,
            )
            stats = result.get("stats") or {}
            metric_value = _score_from_stats(stats, s["metric"])

            row = {
                "combo_idx": i,
                "params": {s["sweep_dim"]: float(value)},
                "stats": stats,
            }
            self.results.append(row)

            if best_metric is None or metric_value > best_metric:
                best_metric = metric_value
            self.current_best_metric = best_metric

            self._emit("cs_progress", {
                "run_idx": i,
                "total_runs": self.total_runs,
                "sweep_dim": s["sweep_dim"],
                "sweep_value": float(value),
                "current_metric_value": metric_value,
                "current_best_metric": best_metric,
            })

        if self.cancel_flag:
            self._publish_result(partial=True)
            return

        self._publish_result(partial=False)

    def _publish_result(self, partial: bool) -> None:
        s = self.spec
        elapsed = time.time() - self.started_at
        if self.run_idx > 0:
            global _last_avg_per_run_sec
            _last_avg_per_run_sec = elapsed / self.run_idx

        result = {
            "strategy_id": s["strategy_id"],
            "symbol":      s["symbol"],
            "timeframe":   s["timeframe"],
            "metric":      s["metric"],
            "sweep_dim":   s["sweep_dim"],
            "sweep_values": s["sweep_values"],
            "params":      s["params"],
            "start_time":  s["start_time"],
            "end_time":    s["end_time"],
            "results":     self.results,
            "total_runs":  self.total_runs,
            "completed_runs": self.run_idx,
            "elapsed_seconds": elapsed,
            "partial":     partial,
        }

        global _last_result
        _last_result = result
        self._emit("cs_complete", {"result": result})
