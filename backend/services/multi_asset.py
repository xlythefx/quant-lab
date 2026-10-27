"""
Multi-Asset runner — one independent backtest per asset, run in worker
processes so a basket uses several cores instead of one.

The page sends one request per asset (a few at a time) and each request thread
blocks on a ProcessPoolExecutor future. Threads alone would not help: the
backend is one Python process, and Python runs one thread of Python code at a
time, so the bar-by-bar walk needs separate processes to run in parallel.

Fresh workers per run. A worker caches its own copy of the risk settings and
the strategy classes, so a pool kept alive across runs could silently backtest
with old fees or old strategy code. Each new `run_id` therefore retires the
previous pool, and the risk settings travel with every task as a snapshot
taken in the parent. Idle workers (~210 MB each) shut down after
IDLE_SHUTDOWN_SECS.

What a task returns is the per_strategy slice only (the aggregate block is a
duplicate for a one-asset run), with the equity curve thinned for drawing and
`stats.ann_vol_pct` measured on the FULL curve before thinning.
"""
from __future__ import annotations

import logging
import math
import multiprocessing as mp
import os
import threading
from concurrent.futures import ProcessPoolExecutor
from concurrent.futures.process import BrokenProcessPool

import numpy as np

from services import portfolio_runner

log = logging.getLogger(__name__)

N_WORKERS = max(1, int(os.environ.get("MULTI_ASSET_WORKERS") or min(4, (os.cpu_count() or 2) - 1)))
IDLE_SHUTDOWN_SECS = 90
MAX_CURVE_POINTS = 4000
SECONDS_PER_YEAR = 365.25 * 24 * 3600   # same constant as frontend metrics.js


class SupersededError(Exception):
    """The request belongs to a run older than the one the pool is serving."""


_lock = threading.Lock()
_pool: ProcessPoolExecutor | None = None
_pool_run_id: int | None = None
_pending = 0
_idle_timer: threading.Timer | None = None


# ---------------------------------------------------------------------------
# Curve helpers (pure — unit-tested)
# ---------------------------------------------------------------------------

def thin_equity(curve: list[dict], max_points: int = MAX_CURVE_POINTS) -> list[dict]:
    """Cut a per-bar equity curve down to about `max_points` for drawing.

    The curve is split into max_points/2 equal slices and each slice keeps its
    lowest and highest equity point (plus the very first and last point), so
    peaks, troughs and the final value all survive — a chart ~1,500 px wide
    cannot show more than that anyway. Display only: every headline number is
    computed server-side from the full curve before this runs.
    """
    n = len(curve)
    if n <= max_points:
        return curve
    eq = np.nan_to_num(np.array([p["equity"] for p in curve], dtype=float),
                       nan=0.0, posinf=0.0, neginf=0.0)
    step = math.ceil(n / (max_points // 2))
    keep = {0, n - 1}
    for lo in range(0, n, step):
        seg = eq[lo:lo + step]
        keep.add(lo + int(seg.argmin()))
        keep.add(lo + int(seg.argmax()))
    return [curve[i] for i in sorted(keep)]


def annualized_vol_pct(curve: list[dict], starting_capital: float) -> float | None:
    """Annualized volatility of the per-bar equity returns, in %.

    A line-for-line port of `annualizedVol` in frontend metrics.js, which the
    Performance tab used to run on the full curve in the browser. The curve the
    browser gets is now thinned, so the number is computed here instead.
    Equity is rounded to cents first because that is what the browser saw.
    """
    if len(curve) < 3:
        return None
    sc = float(starting_capital) or 100000.0
    eq = np.round(np.array([p["equity"] for p in curve], dtype=float), 2)
    v = eq / sc * 100.0
    v = v[np.isfinite(v) & (v > 0)]
    if v.size < 3:
        return None
    rets = v[1:] / v[:-1] - 1.0
    if rets.size < 2:
        return None
    var = float(rets.var(ddof=1))
    dts = np.diff(np.array([p["time"] for p in curve], dtype=float))
    dts = dts[dts > 0]
    mean_dt = float(dts.mean()) if dts.size else 0.0
    if not mean_dt:
        return None
    return math.sqrt(var) * math.sqrt(SECONDS_PER_YEAR / mean_dt) * 100.0


# ---------------------------------------------------------------------------
# Worker task (module-level so it pickles under the Windows "spawn" method)
# ---------------------------------------------------------------------------

def _asset_task(spec, start_time, end_time, risk_snapshot):
    res = portfolio_runner.run_portfolio(
        [spec], start_time=start_time, end_time=end_time,
        risk_overrides=risk_snapshot, with_chart_data=False, per_strategy_only=True,
    )
    sc = float(res["risk_config"]["starting_capital"])
    for blk in res["per_strategy"].values():
        full = blk["equity"]
        blk["stats"]["ann_vol_pct"] = annualized_vol_pct(full, sc)
        blk["equity"] = thin_equity(full)
        # Per-bar copy of the drawdown; the wire drops it anyway, so don't
        # pay to pickle 200k dicts back to the parent.
        (blk.get("analytics") or {}).pop("drawdown_curve", None)
    return res


# ---------------------------------------------------------------------------
# Pool management
# ---------------------------------------------------------------------------

def _new_pool() -> ProcessPoolExecutor:
    log.info("[multi-asset] starting %d worker process(es)", N_WORKERS)
    return ProcessPoolExecutor(max_workers=N_WORKERS, mp_context=mp.get_context("spawn"))


def _shutdown_if_idle() -> None:
    global _pool
    with _lock:
        if _pending == 0 and _pool is not None:
            log.info("[multi-asset] idle — shutting down workers")
            _pool.shutdown(wait=False)
            _pool = None


def _arm_idle_timer() -> None:
    """Caller holds _lock."""
    global _idle_timer
    if _idle_timer is not None:
        _idle_timer.cancel()
        _idle_timer = None
    if _pending == 0 and _pool is not None:
        _idle_timer = threading.Timer(IDLE_SHUTDOWN_SECS, _shutdown_if_idle)
        _idle_timer.daemon = True
        _idle_timer.start()


def _submit(run_id: int, *args):
    global _pool, _pool_run_id, _pending, _idle_timer
    with _lock:
        if _pool_run_id is not None and run_id < _pool_run_id:
            raise SupersededError()
        if _idle_timer is not None:
            _idle_timer.cancel()
            _idle_timer = None
        if _pool is None or run_id != _pool_run_id:
            old = _pool
            _pool, _pool_run_id = _new_pool(), run_id
            if old is not None:
                # Queued assets of the old run are cancelled; ones already on a
                # worker finish and are ignored by the page.
                old.shutdown(wait=False, cancel_futures=True)
        try:
            fut = _pool.submit(_asset_task, *args)
        except BrokenProcessPool:
            _pool.shutdown(wait=False)
            _pool = _new_pool()
            fut = _pool.submit(_asset_task, *args)
        _pending += 1
        return fut, _pool


def run_asset(run_id: int, spec, start_time, end_time, risk_snapshot: dict) -> dict:
    """Run one asset on a worker and block until it is done.

    `run_id` is the run's start time in ms. A newer id retires the previous
    run's workers; an older one is refused with SupersededError. Raises
    CancelledError if a newer run cancelled this asset while it was queued.
    """
    global _pool, _pending
    fut, pool = _submit(run_id, spec, start_time, end_time, risk_snapshot)
    try:
        return fut.result()
    except BrokenProcessPool:
        # A worker died (e.g. out of memory). Drop that pool so the next
        # request starts fresh workers instead of failing forever.
        with _lock:
            if _pool is pool:
                _pool = None
        raise
    finally:
        with _lock:
            _pending -= 1
            _arm_idle_timer()
