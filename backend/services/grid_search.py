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
import threading
import time
import uuid
from typing import Any, Optional

from services import backtest_engine, event_bus

log = logging.getLogger(__name__)

# Hard cap — refuse to start jobs above this. Soft warn (~500) is enforced
# client-side via the /estimate endpoint.
MAX_COMBOS = 5000


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
    if total > MAX_COMBOS:
        raise ValueError(
            f"grid would produce {total} combos (limit: {MAX_COMBOS}). "
            f"Narrow your values or sweep fewer params."
        )

    out = {
        "strategy_id": str(spec["strategy_id"]).strip(),
        "symbol": str(spec["symbol"]).strip(),
        "timeframe": str(spec["timeframe"]).strip(),
        "start_time": int(spec["start_time"]) if spec.get("start_time") is not None else None,
        "end_time": int(spec["end_time"]) if spec.get("end_time") is not None else None,
        "base_params": dict(spec.get("base_params") or {}),
        "grid_params": grid_params,
        "metric": str(spec.get("metric") or "sharpe"),
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
        return {
            "combos": total,
            "projected_seconds": float(total) * float(avg),
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
            },
            "combo_idx": self.combo_idx,
            "total_combos": self.total_combos,
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
                self._emit("gs_cancelled", {})
            else:
                self.state = "done"
        except Exception as e:
            log.exception("grid-search job failed")
            self.error = str(e)
            self.state = "error"
            self._emit("gs_error", {"message": str(e)})

    def _do_run(self) -> None:
        s = self.spec
        names = [gp["name"] for gp in s["grid_params"]]
        value_lists = [gp["values"] for gp in s["grid_params"]]
        best_metric: Optional[float] = None

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

        if self.cancel_flag:
            # Stash partial results so the UI can still render what we got.
            self._publish_result(partial=True)
            return

        self._publish_result(partial=False)

    def _publish_result(self, partial: bool) -> None:
        s = self.spec
        elapsed = time.time() - self.started_at
        if self.total_combos > 0 and self.combo_idx > 0:
            global _last_avg_per_combo_sec
            _last_avg_per_combo_sec = elapsed / self.combo_idx

        result = {
            "strategy_id": s["strategy_id"],
            "symbol": s["symbol"],
            "timeframe": s["timeframe"],
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
        }

        global _last_result
        _last_result = result
        self._emit("gs_complete", {"result": result})
