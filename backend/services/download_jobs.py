"""
Background job runner for historical-data downloads.

Before this module: /api/datasets/download blocked the Flask request thread
for the entire fetch (minutes to hours), the browser hit a 120s axios timeout
on long pulls, and there was no cancel button. After this module: the route
returns a job_id immediately, a daemon thread does the work, and progress +
terminal state stream over Socket.IO. Mirrors the patterns already in use by
walkforward.py / cost_sweep.py / grid_search.py.

One job at a time, globally. If a second download is requested while one is
running, the first is cancelled and the new one starts. A job may carry several
symbols and timeframes (spec["symbols"] x spec["timeframes"]); they download
one after another. In a batch, a pair that fails is reported and skipped —
except a Binance IP ban, which stops the whole batch.

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
from services.brokers import dukascopy, yahoo
from services.brokers import tradestation
from services.brokers import databento

log = logging.getLogger(__name__)

_BROKERS = (*market_data.CCXT_BROKERS, "dukascopy", "yahoo", "tradestation", "databento")


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
    symbols = [str(s or "").strip().upper() for s in (spec.get("symbols") or [spec.get("symbol")])]
    if not all(symbols):
        raise ValueError("symbol is required")
    # CCXT symbols carry their market in the name (BTCUSDT.P, MEXC.LTCUSDT —
    # see market_data.CCXT_BROKERS): the markers decide both the CCXT client
    # and the data/{broker}/ folder, so keep broker and symbol in agreement
    # whichever one the caller set.
    if broker in market_data.CCXT_BROKERS:
        symbols = [market_data.ccxt_symbol_for(s, broker) for s in symbols]
        brokers = {market_data.ccxt_broker_for(s) for s in symbols}
        if len(brokers) > 1:
            raise ValueError(f"one batch can't mix markets: {sorted(brokers)}")
        broker = brokers.pop()
    symbols = list(dict.fromkeys(symbols))  # drop repeats, keep order
    timeframes = [str(t or "").strip() for t in (spec.get("timeframes") or [spec.get("timeframe")])]
    if not all(timeframes):
        raise ValueError("timeframe is required")
    timeframes = list(dict.fromkeys(timeframes))  # drop repeats, keep order
    start_ms = int(spec.get("start_ms"))
    end_ms = int(spec.get("end_ms"))
    if end_ms <= start_ms:
        raise ValueError("end must be after start")
    return {
        "broker": broker,
        "symbol": symbols[0],  # symbol + timeframe = the pair downloading now
        "symbols": symbols,
        "timeframe": timeframes[0],
        "timeframes": timeframes,
        "start_ms": start_ms,
        "end_ms": end_ms,
        "sid": spec.get("sid"),
        # Crypto only: replace the saved file with a fresh copy (see download_range).
        "overwrite": bool(spec.get("overwrite")),
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
        self._tf_started = self.started_at  # when the current timeframe began (ETA)
        self.error: Optional[str] = None
        # Most recent progress payload (mirrors what we stream via socket so
        # /status can re-hydrate the UI on a page refresh).
        self.last_progress: dict = {
            "job_id": self.job_id,
            "broker": self.spec["broker"],
            "symbol": self.spec["symbol"],
            "timeframe": self.spec["timeframe"],
            "timeframes": self.spec["timeframes"],
            "item_index": 0,  # which (symbol, timeframe) pair of the batch
            "item_count": len(self.spec["symbols"]) * len(self.spec["timeframes"]),
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
                "symbols": self.spec["symbols"],
                "timeframe": self.spec["timeframe"],
                "timeframes": self.spec["timeframes"],
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
            items = [(s, tf) for s in self.spec["symbols"] for tf in self.spec["timeframes"]]
            results = []
            for i, (sym, tf) in enumerate(items):
                if self.cancel_flag:
                    break
                self.spec["symbol"], self.spec["timeframe"] = sym, tf
                self._tf_started = time.time()
                self._record_progress(symbol=sym, timeframe=tf, item_index=i, status="downloading",
                                      fetched=0, pages_done=0, pages_total=None, eta_seconds=None,
                                      cursor_ms=self.spec["start_ms"])
                try:
                    meta = self._run_one()
                except market_data.BinanceBanned:
                    raise
                except Exception as e:
                    if len(items) == 1:
                        raise
                    log.warning("batch: %s %s failed, skipping: %s", sym, tf, e)
                    results.append({"symbol": sym, "timeframe": tf, "error": str(e)})
                    continue
                results.append({"symbol": sym, "timeframe": tf, **meta})
            if self.cancel_flag:
                self.state = "cancelled"
                self._emit("download_cancelled", {"job_id": self.job_id, "results": results})
                return
            ok = [r for r in results if "error" not in r]
            if not ok:
                raise RuntimeError(f"all {len(results)} downloads failed — first: {results[0]['error']}")
            self.state = "done"
            global _last_result
            _last_result = {**ok[-1], "broker": self.spec["broker"], "results": results}
            self._emit("download_complete", {
                "job_id": self.job_id,
                "broker": self.spec["broker"],
                **ok[-1],
                "results": results,
            })
        except Exception as e:
            log.exception("download job failed (broker=%s)", self.spec.get("broker"))
            self.error = str(e)
            self.state = "error"
            self._emit("download_error", {"job_id": self.job_id, "message": str(e)})

    # ---- broker dispatch ---------------------------------------------------

    def _run_one(self) -> dict:
        """Download self.spec["timeframe"] with the broker's adapter."""
        if self.spec["broker"] in market_data.CCXT_BROKERS:
            return self._run_ccxt()
        if self.spec["broker"] == "yahoo":
            return self._run_yahoo()
        if self.spec["broker"] == "tradestation":
            return self._run_tradestation()
        if self.spec["broker"] == "databento":
            return self._run_databento()
        return self._run_dukascopy()

    def _run_ccxt(self) -> dict:
        s = self.spec

        def progress_cb(p):
            done, total = int(p.get("pages_done", 0)), int(p.get("pages_total") or 0)
            spent = time.time() - self._tf_started
            self._record_progress(
                fetched=int(p.get("fetched", 0)),
                pages_done=done,
                pages_total=total,
                cursor_ms=int(p.get("cursor_ms") or s["start_ms"]),
                # Time left for this timeframe, from the pace so far.
                eta_seconds=spent * (total - done) / done if done and total else None,
                status="downloading",
            )

        def cancel_check() -> bool:
            return self.cancel_flag

        return market_data.download_range(
            s["symbol"], s["timeframe"],
            s["start_ms"], s["end_ms"],
            progress_cb=progress_cb,
            cancel_check=cancel_check,
            overwrite=s["overwrite"],
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

    def _run_databento(self) -> dict:
        s = self.spec
        start_dt = datetime.fromtimestamp(s["start_ms"] / 1000, tz=timezone.utc)
        end_dt   = datetime.fromtimestamp(s["end_ms"]   / 1000, tz=timezone.utc)
        total_span_ms = max(1, s["end_ms"] - s["start_ms"])

        def progress_cb(done, total):
            ratio = (done or 0) / max(1, total)
            cursor_ms = s["start_ms"] + int(total_span_ms * ratio)
            self._record_progress(
                fetched=int(s["expected"] * ratio),
                cursor_ms=cursor_ms,
                status="downloading",
            )

        def cancel_check() -> bool:
            return self.cancel_flag

        new_bars = databento.download(
            s["symbol"], start_dt, end_dt, s["timeframe"],
            progress_cb=progress_cb,
            cancel_check=cancel_check,
        )
        if self.cancel_flag:
            return {"rows_added": 0, "rows_total": 0, "first_time": None, "last_time": None}
        if new_bars.empty:
            raise ValueError(
                f"Databento returned no bars for {s['symbol']} {s['timeframe']} in that range. "
                "Check DATABENTO_API_KEY in .env, your GLBX.MDP3 entitlement, and that the "
                "market was open during this period."
            )

        path = market_data.parquet_path(s["symbol"], s["timeframe"], broker="databento")
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

    def _run_yahoo(self) -> dict:
        s = self.spec
        start_dt = datetime.fromtimestamp(s["start_ms"] / 1000, tz=timezone.utc)
        end_dt   = datetime.fromtimestamp(s["end_ms"]   / 1000, tz=timezone.utc)

        # Yahoo returns the full range in one HTTP call, so progress is binary
        # (0% → 100%). Emit a single mid-fetch ping so the UI doesn't appear
        # stalled while yfinance is in flight.
        def progress_cb(done, total):
            ratio = (done or 0) / max(1, total)
            cursor_ms = s["start_ms"] + int((s["end_ms"] - s["start_ms"]) * ratio)
            self._record_progress(
                fetched=int(s["expected"] * ratio),
                cursor_ms=cursor_ms,
                status="downloading",
            )

        def cancel_check() -> bool:
            return self.cancel_flag

        new_bars = yahoo.download(
            s["symbol"], start_dt, end_dt, s["timeframe"],
            progress_cb=progress_cb,
            cancel_check=cancel_check,
        )
        if self.cancel_flag:
            return {"rows_added": 0, "rows_total": 0, "first_time": None, "last_time": None}
        if new_bars.empty:
            raise ValueError(f"Yahoo returned no bars for {s['symbol']} {s['timeframe']} in that range")

        path = market_data.parquet_path(s["symbol"], s["timeframe"], broker="yahoo")
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

    def _run_tradestation(self) -> dict:
        s = self.spec
        start_dt = datetime.fromtimestamp(s["start_ms"] / 1000, tz=timezone.utc)
        end_dt   = datetime.fromtimestamp(s["end_ms"]   / 1000, tz=timezone.utc)

        def progress_cb(done, total):
            ratio = (done or 0) / max(1, total)
            cursor_ms = s["start_ms"] + int((s["end_ms"] - s["start_ms"]) * ratio)
            self._record_progress(
                fetched=int(s["expected"] * ratio),
                cursor_ms=cursor_ms,
                status="downloading",
            )

        def cancel_check() -> bool:
            return self.cancel_flag

        new_bars = tradestation.download(
            s["symbol"], start_dt, end_dt, s["timeframe"],
            progress_cb=progress_cb,
            cancel_check=cancel_check,
        )
        if self.cancel_flag:
            return {"rows_added": 0, "rows_total": 0, "first_time": None, "last_time": None}
        if new_bars.empty:
            raise ValueError(
                f"TradeStation returned no bars for {s['symbol']} {s['timeframe']} in that range. "
                "Check that credentials are set in .env and the market was open during this period."
            )

        path = market_data.parquet_path(s["symbol"], s["timeframe"], broker="tradestation")
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
