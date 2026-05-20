"""
Background job runner for historical-data downloads.

Before this module: /api/datasets/download blocked the Flask request thread
for the entire fetch (minutes to hours), the browser hit a 120s axios timeout
on long pulls, and there was no cancel button. After this module: the route
returns a job_id immediately, a daemon thread does the work, and progress +
terminal state stream over Socket.IO. Mirrors the patterns already in use by
walkforward.py / cost_sweep.py / grid_search.py.

One job at a time, globally. If a second download is requested while one is
running, the first is cancelled and the new one starts.

Socket events emitted:
  download_progress  per-batch progress (carries broker/symbol/tf/cursor/%)
  download_complete  terminal success (carries the same metadata the route
                     used to return synchronously)
  download_cancelled terminal cancel
  download_error     terminal failure
"""
from __future__ import annotations

import logging
import os
import threading
import time
import uuid
from datetime import datetime, timezone
from typing import Optional

import pandas as pd

from services import market_data, event_bus
from services.brokers import dukascopy

log = logging.getLogger(__name__)

_BROKERS = ("binance", "dukascopy")


# ---------------------------------------------------------------------------
# Job registry (one job at a time)
# ---------------------------------------------------------------------------

_lock = threading.Lock()
_current_job: Optional["DownloadJob"] = None
_last_result: Optional[dict] = None


def get_status() -> dict:
    """Snapshot of the live job, or idle state. Used by the frontend on mount
    to re-hydrate a download that was started before the page was refreshed."""
    with _lock:
        job = _current_job
    if job is None:
        return {"state": "idle", "last_result": _last_result}
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

    job = DownloadJob(spec)
    with _lock:
        _current_job = job
    job.start()
    return job.job_id


# ---------------------------------------------------------------------------
# Spec normalization
# ---------------------------------------------------------------------------

def _normalize_spec(spec: dict) -> dict:
    broker = (spec.get("broker") or "binance").strip().lower()
    if broker not in _BROKERS:
        raise ValueError(f"unknown broker {broker!r}; allowed: {_BROKERS}")
    symbol = str(spec.get("symbol") or "").strip().upper()
    if not symbol:
        raise ValueError("symbol is required")
    timeframe = str(spec.get("timeframe") or "").strip()
    if not timeframe:
        raise ValueError("timeframe is required")
    start_ms = int(spec.get("start_ms"))
    end_ms = int(spec.get("end_ms"))
    if end_ms <= start_ms:
        raise ValueError("end must be after start")
    return {
        "broker": broker,
        "symbol": symbol,
        "timeframe": timeframe,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "sid": spec.get("sid"),
        "expected": int(spec.get("expected") or 1),
        "job_id": spec.get("job_id"),
    }


# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------

class DownloadJob:
    def __init__(self, spec: dict):
        self.spec = _normalize_spec(spec)
        self.job_id = self.spec["job_id"] or uuid.uuid4().hex[:12]
        self.state = "starting"  # starting | running | done | cancelled | error
        self.cancel_flag = False
        self.started_at = time.time()
        self.error: Optional[str] = None
        # Most recent progress payload (mirrors what we stream via socket so
        # /status can re-hydrate the UI on a page refresh).
        self.last_progress: dict = {
            "job_id": self.job_id,
            "broker": self.spec["broker"],
            "symbol": self.spec["symbol"],
            "timeframe": self.spec["timeframe"],
            "fetched": 0,
            "expected": int(self.spec["expected"]),
            "start_ms": self.spec["start_ms"],
            "end_ms": self.spec["end_ms"],
            "cursor_ms": self.spec["start_ms"],
            "status": "starting",
        }

        self._thread = threading.Thread(target=self._run, name=f"dl-{self.job_id}", daemon=True)

    # ---- public ------------------------------------------------------------

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: Optional[float] = None) -> None:
        self._thread.join(timeout=timeout)

    def request_cancel(self) -> None:
        self.cancel_flag = True

    def snapshot(self) -> dict:
        elapsed = time.time() - self.started_at
        return {
            "state": self.state,
            "job_id": self.job_id,
            "spec": {
                "broker": self.spec["broker"],
                "symbol": self.spec["symbol"],
                "timeframe": self.spec["timeframe"],
                "start_ms": self.spec["start_ms"],
                "end_ms": self.spec["end_ms"],
            },
            "progress": dict(self.last_progress),
            "elapsed_seconds": elapsed,
            "error": self.error,
        }

    # ---- thread ------------------------------------------------------------

    def _emit(self, event: str, payload: dict) -> None:
        sid = self.spec.get("sid")
        if sid:
            event_bus.emit(event, payload, to=sid)
        else:
            event_bus.emit(event, payload)

    def _record_progress(self, **patch) -> None:
        self.last_progress = {**self.last_progress, **patch}
        self._emit("download_progress", dict(self.last_progress))

    def _run(self) -> None:
        try:
            self.state = "running"
            # Initial 0% event so the UI paints the bar immediately.
            self._record_progress(status="starting")
            if self.spec["broker"] == "binance":
                meta = self._run_binance()
            else:
                meta = self._run_dukascopy()
            if self.cancel_flag:
                self.state = "cancelled"
                self._emit("download_cancelled", {"job_id": self.job_id})
                return
            self.state = "done"
            global _last_result
            _last_result = {**meta, "broker": self.spec["broker"]}
            self._emit("download_complete", {
                "job_id": self.job_id,
                "broker": self.spec["broker"],
                "symbol": self.spec["symbol"],
                "timeframe": self.spec["timeframe"],
                **meta,
            })
        except Exception as e:
            log.exception("download job failed (broker=%s)", self.spec.get("broker"))
            self.error = str(e)
            self.state = "error"
            self._emit("download_error", {"job_id": self.job_id, "message": str(e)})

    # ---- broker dispatch ---------------------------------------------------

    def _run_binance(self) -> dict:
        s = self.spec

        def progress_cb(p):
            self._record_progress(
                fetched=int(p.get("fetched", 0)),
                cursor_ms=int(p.get("last_ts") or s["start_ms"]),
                status="downloading",
            )

        def cancel_check() -> bool:
            return self.cancel_flag

        return market_data.download_range(
            s["symbol"], s["timeframe"],
            s["start_ms"], s["end_ms"],
            progress_cb=progress_cb,
            cancel_check=cancel_check,
        )

    def _run_dukascopy(self) -> dict:
        s = self.spec
        start_dt = datetime.fromtimestamp(s["start_ms"] / 1000, tz=timezone.utc)
        end_dt   = datetime.fromtimestamp(s["end_ms"]   / 1000, tz=timezone.utc)
        total_span_ms = max(1, s["end_ms"] - s["start_ms"])

        def progress_cb(done, total):
            # Linear interpolation across the requested date range.
            ratio = done / max(1, total)
            cursor_ms = s["start_ms"] + int(total_span_ms * ratio)
            self._record_progress(
                fetched=int(s["expected"] * ratio),
                cursor_ms=cursor_ms,
                status="downloading",
            )

        def cancel_check() -> bool:
            return self.cancel_flag

        new_bars = dukascopy.download(
            s["symbol"], start_dt, end_dt, s["timeframe"],
            progress_cb=progress_cb,
            cancel_check=cancel_check,
        )
        if self.cancel_flag:
            return {"rows_added": 0, "rows_total": 0, "first_time": None, "last_time": None}
        if new_bars.empty:
            raise ValueError(f"Dukascopy returned no ticks for {s['symbol']} {s['timeframe']} in that range")

        # Idempotent merge into broker-namespaced parquet.
        path = market_data.parquet_path(s["symbol"], s["timeframe"], broker="dukascopy")
        rows_before = 0
        if os.path.exists(path):
            try:
                existing = pd.read_parquet(path)
                rows_before = len(existing)
                merged = pd.concat([existing, new_bars], ignore_index=True)
            except Exception:
                merged = new_bars
        else:
            merged = new_bars
        merged = merged.drop_duplicates(subset=["time"]).sort_values("time").reset_index(drop=True)
        merged.to_parquet(path, index=False)

        return {
            "rows_added": int(len(merged) - rows_before),
            "rows_total": int(len(merged)),
            "path": path,
            "first_time": int(merged["time"].iloc[0]),
            "last_time":  int(merged["time"].iloc[-1]),
        }
