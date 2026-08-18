"""
Overnight Run — an unattended batch that sweeps MULTIPLE assets and finds the
best parameters per asset, with a selectable engine:

  - "grid"          : Grid Search per asset (map the param terrain).
  - "walkforward"   : Walk-Forward per asset (validate a search space out-of-sample).
  - "grid_then_wf"  : grid finds the promising range, then Walk-Forward validates
                      that range OOS. The headline verdict for each asset then rests
                      on the OOS result, not the in-sample grid peak. (default)

It drives MUTED child jobs (grid_search.GridSearchJob / walkforward.WalkForwardJob
with emit_enabled=False), exactly like walkforward_robustness — so it never touches
the one-job-at-a-time interactive Grid/WF singletons. A bad or un-cached asset is
skipped and the batch continues. Results are checkpointed to overnight_store after
each asset (crash-resilient) and feed a client-side verdict PDF.

One job at a time (house pattern). Progress is emitted as overnight_* socket events.
"""
from __future__ import annotations

import logging
import math
import threading
import time
import uuid
from typing import Optional

from services import (event_bus, grid_search, market_data, overnight_plateau,
                      overnight_store, risk_config, walkforward)

log = logging.getLogger(__name__)

_lock = threading.Lock()
_current_job: Optional["OvernightRunJob"] = None

MODES = ("grid", "walkforward", "grid_then_wf")
HARD_CEILING = 10000            # max combos/asset (matches grid_search)
TOP_N = 50                      # per-asset combos kept for the results table
_STAT_SUBSET = ("sharpe", "total_return_pct", "max_drawdown_pct", "win_rate",
                "trades", "profit_factor")


class _Cancelled(Exception):
    """Raised inside an asset when the batch is cancelled mid-flight."""


# ---------------------------------------------------------------------------
# Public registry (one job at a time)
# ---------------------------------------------------------------------------

def get_status() -> dict:
    with _lock:
        job = _current_job
    if job is None:
        return {"state": "idle", "result": overnight_store.get_last()}
    return job.snapshot()


def get_last_result() -> Optional[dict]:
    return overnight_store.get_last()


def get_history() -> list:
    return overnight_store.get_history()


def cancel_current() -> bool:
    with _lock:
        job = _current_job
    if job is None or job.state not in ("running", "starting"):
        return False
    job.request_cancel()
    return True


def start(spec: dict) -> str:
    global _current_job
    with _lock:
        prev = _current_job
    if prev is not None and prev.state in ("running", "starting"):
        prev.request_cancel()
        prev.join(timeout=5.0)
    job = OvernightRunJob(spec)
    with _lock:
        _current_job = job
    job.start()
    return job.job_id


# ---------------------------------------------------------------------------
# Spec helpers
# ---------------------------------------------------------------------------

def _coerce_grid_params(raw) -> list:
    """Mirror grid_search's per-entry coercion (numbers, dedupe, keep order)."""
    out = []
    for entry in (raw or []):
        if entry.get("type") not in ("int", "float"):
            raise ValueError(f"grid_param {entry.get('name')!r} has bad type")
        name = str(entry.get("name") or "").strip()
        if not name:
            raise ValueError("grid_param missing name")
        seen, values = set(), []
        for v in (entry.get("values") or []):
            try:
                num = int(v) if entry["type"] == "int" else float(v)
            except (TypeError, ValueError):
                raise ValueError(f"grid_param {name!r} has non-numeric value: {v!r}")
            if num not in seen:
                seen.add(num)
                values.append(num)
        if not values:
            raise ValueError(f"grid_param {name!r} needs at least one value")
        out.append({"name": name, "type": entry["type"], "values": values})
    return out


def _combos_per_asset(grid_params: list) -> int:
    total = 1
    for gp in grid_params:
        total *= len(gp["values"])
    return total


def _normalize_spec(spec: dict) -> dict:
    strategy_id = str(spec.get("strategy_id") or "").strip()
    if not strategy_id:
        raise ValueError("strategy_id is required")

    mode = str(spec.get("mode") or "grid_then_wf").strip()
    if mode not in MODES:
        raise ValueError(f"unknown mode: {mode!r}")

    symbols = [str(s).strip() for s in (spec.get("symbols") or []) if str(s).strip()]
    if not symbols:
        raise ValueError("at least one symbol is required")
    # de-dupe, preserve order
    symbols = list(dict.fromkeys(symbols))

    timeframe = str(spec.get("timeframe") or "").strip()
    if not timeframe:
        raise ValueError("timeframe is required")

    metric = str(spec.get("metric") or "sharpe").strip()
    if metric not in grid_search._METRIC_KEYS:
        raise ValueError(f"unknown metric: {metric}")

    try:
        n_workers = int(spec.get("n_workers") or 1)
    except (TypeError, ValueError):
        n_workers = 1

    out = {
        "strategy_id": strategy_id,
        "timeframe": timeframe,
        "symbols": symbols,
        "mode": mode,
        "metric": metric,
        "n_workers": max(1, n_workers),
        "base_params": dict(spec.get("base_params") or {}),
        # Frozen once here so every asset in the batch is costed identically.
        "risk_snapshot": risk_config.get(),
    }

    # Grid params (needed for grid + grid_then_wf); enforce the per-asset cap now.
    if mode in ("grid", "grid_then_wf"):
        grid_params = _coerce_grid_params(spec.get("grid_params"))
        if not grid_params:
            raise ValueError("grid_params is required for this mode")
        combos = _combos_per_asset(grid_params)
        if combos > HARD_CEILING:
            raise ValueError(
                f"grid would produce {combos} combos/asset (limit: {HARD_CEILING}). "
                f"Narrow your ranges or sweep fewer params.")
        out["grid_params"] = grid_params
        out["combos_per_asset"] = combos

    # WF options (needed for walkforward + grid_then_wf).
    if mode in ("walkforward", "grid_then_wf"):
        wf = dict(spec.get("wf_opts") or {})
        if wf.get("is_bars") in (None, "") or wf.get("oos_bars") in (None, ""):
            raise ValueError("is_bars and oos_bars are required for Walk-Forward")
        out["wf_opts"] = {
            "is_bars": int(wf["is_bars"]),
            "oos_bars": int(wf["oos_bars"]),
            "n_trials": int(wf.get("n_trials") or 30),
            "seed": int(wf.get("seed") or 42),
            "embargo_bars": int(wf.get("embargo_bars") or 0),
            "purge_radius": int(wf.get("purge_radius") or 0),
            "sessions_cfg": wf.get("sessions_cfg"),
        }
        # For plain walkforward mode the search space is supplied directly;
        # grid_then_wf derives it from the grid plateau at run time.
        if mode == "walkforward":
            ss = spec.get("search_space") or []
            if not ss:
                raise ValueError("a search_space is required for walkforward mode")
            out["search_space"] = ss
    return out


def estimate(spec: dict) -> dict:
    """Rough projection for the UI. Read-only; starts nothing."""
    try:
        mode = str(spec.get("mode") or "grid_then_wf")
        symbols = [s for s in (spec.get("symbols") or []) if str(s).strip()]
        n_assets = len(set(symbols))
        combos = 0
        if mode in ("grid", "grid_then_wf"):
            combos = _combos_per_asset(_coerce_grid_params(spec.get("grid_params")))
        avg = grid_search.get_last_avg_seconds() or 1.0
        nw = max(1, int(spec.get("n_workers") or 1))
        grid_secs = float(combos) * avg / nw * n_assets if combos else 0.0
        return {
            "combos_per_asset": combos,
            "n_assets": n_assets,
            "total_combos": combos * n_assets,
            "projected_grid_seconds": grid_secs,   # WF time not projected (data-dependent)
            "refuse": combos > HARD_CEILING,
            "warn": combos > 500,
        }
    except Exception as e:
        return {"combos_per_asset": 0, "n_assets": 0, "total_combos": 0,
                "projected_grid_seconds": 0.0, "refuse": True, "warn": False, "error": str(e)}


# ---------------------------------------------------------------------------
# JSON-safety (atomic_write_json / browser JSON.parse can't take inf/nan)
# ---------------------------------------------------------------------------

def _json_safe(obj):
    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _json_safe(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_json_safe(v) for v in obj]
    return obj


def _subset(stats: dict) -> dict:
    return {k: stats.get(k) for k in _STAT_SUBSET}


def _safe_num(v):
    return v if (isinstance(v, (int, float)) and math.isfinite(v)) else None


# ---------------------------------------------------------------------------
# Job
# ---------------------------------------------------------------------------

class OvernightRunJob:
    def __init__(self, spec: dict):
        self.spec = _normalize_spec(spec)
        self.job_id = uuid.uuid4().hex[:12]
        self.state = "starting"  # starting | running | done | cancelled | error
        self.cancel_flag = False
        self.started_at = time.time()
        self.finished_at: Optional[float] = None
        self.error: Optional[str] = None

        self.total_assets = len(self.spec["symbols"])
        self.asset_idx = 0
        self.current_symbol: Optional[str] = None
        self.current_engine: Optional[str] = None
        self.per_asset: list[dict] = []
        self.skipped: list[dict] = []
        self.best_so_far: Optional[dict] = None   # {symbol, metric_value}
        self._best_val = -math.inf

        self._inner = None
        self._thread = threading.Thread(target=self._run, name=f"ovn-{self.job_id}", daemon=True)

    # ---- public ------------------------------------------------------------

    def start(self) -> None:
        self._thread.start()

    def join(self, timeout: Optional[float] = None) -> None:
        self._thread.join(timeout=timeout)

    def request_cancel(self) -> None:
        self.cancel_flag = True
        inner = self._inner
        if inner is not None:
            inner.request_cancel()

    def _emit(self, event: str, payload: dict) -> None:
        event_bus.emit(event, {"job_id": self.job_id, **payload})

    def _eta(self) -> Optional[float]:
        done = len(self.per_asset) + len(self.skipped)
        if self.state == "running" and done > 0:
            per = (time.time() - self.started_at) / done
            return max(0.0, per * (self.total_assets - done))
        return None

    def snapshot(self) -> dict:
        inner = self._inner
        return {
            "state": self.state, "job_id": self.job_id, "kind": "overnight_run",
            "mode": self.spec["mode"], "metric": self.spec["metric"],
            "asset_idx": self.asset_idx, "total_assets": self.total_assets,
            "current_symbol": self.current_symbol, "current_engine": self.current_engine,
            # inner progress: grid combos OR wf windows
            "combo_idx": getattr(inner, "combo_idx", 0) if inner else 0,
            "total_combos": getattr(inner, "total_combos", 0) if inner else 0,
            "current_best_metric": getattr(inner, "current_best_metric", None) if inner else None,
            "window_idx": getattr(inner, "window_idx", 0) if inner else 0,
            "total_windows": getattr(inner, "total_windows", 0) if inner else 0,
            # CPU monitor mirrored from the inner job (shares the CpuMeter widget)
            "cpu_percent": getattr(inner, "cpu_percent", 0.0) if inner else 0.0,
            "cpu_percent_percore": getattr(inner, "cpu_percent_percore", []) if inner else [],
            "active_workers": getattr(inner, "active_workers", 0) if inner else 0,
            "n_workers": getattr(inner, "n_workers_effective", 1) if inner else 1,
            "elapsed_seconds": time.time() - self.started_at,
            "eta_seconds": self._eta(),
            "best_so_far": self.best_so_far,
            "skipped": self.skipped,
            "per_asset": self.per_asset,
            "error": self.error,
        }

    def _progress_payload(self) -> dict:
        s = self.snapshot()
        s.pop("per_asset", None)  # heavy; not needed mid-flight
        return s

    # ---- thread ------------------------------------------------------------

    def _run(self) -> None:
        try:
            self.state = "running"
            self._do_run()
            self.state = "cancelled" if self.cancel_flag else "done"
        except Exception as e:
            log.exception("overnight run failed")
            self.error = str(e)
            self.state = "error"
        finally:
            self.finished_at = time.time()
            self._inner = None
            result = self._build_result()
            try:
                overnight_store.commit_to_history(result)
            except Exception:
                log.exception("overnight_store commit failed")
            evt = {"cancelled": "overnight_cancelled", "error": "overnight_error"}.get(
                self.state, "overnight_complete")
            self._emit(evt, {"result": result} if evt == "overnight_complete" else
                       {"message": self.error} if evt == "overnight_error" else {})

    def _do_run(self) -> None:
        s = self.spec
        tf = s["timeframe"]
        # (symbol, timeframe) pairs that actually have cached data.
        try:
            cached = {(r.get("symbol"), r.get("timeframe")) for r in market_data.list_datasets()}
        except Exception:
            log.exception("list_datasets failed; proceeding without pre-skip")
            cached = None

        for i, symbol in enumerate(s["symbols"]):
            if self.cancel_flag:
                break
            self.asset_idx = i + 1
            self.current_symbol = symbol

            if cached is not None and (symbol, tf) not in cached:
                self.skipped.append({"symbol": symbol, "reason": f"no cached data at {tf}"})
                self._checkpoint()
                self._emit("overnight_progress", self._progress_payload())
                continue

            try:
                rec = self._run_asset(symbol)
            except _Cancelled:
                break
            except Exception as e:
                log.exception("overnight asset %s failed", symbol)
                self.skipped.append({"symbol": symbol, "reason": str(e)[:300]})
                self._checkpoint()
                self._emit("overnight_progress", self._progress_payload())
                continue

            self.per_asset.append(rec)
            self._update_best(rec)
            self._checkpoint()
            self._emit("overnight_progress", self._progress_payload())

    # ---- per-asset dispatch ------------------------------------------------

    def _run_asset(self, symbol: str) -> dict:
        mode = self.spec["mode"]
        if mode == "grid":
            return self._run_grid(symbol)
        if mode == "walkforward":
            return self._run_wf(symbol, self.spec["search_space"], engine="walkforward")
        # grid_then_wf: map with grid, then validate the mapped range OOS.
        grid_rec = self._run_grid(symbol)
        search_space, wf_base = self._grid_to_search_space(grid_rec)
        if not search_space:
            grid_rec["wf"] = {"skipped": "no multi-value params to validate"}
            return grid_rec
        wf_rec = self._run_wf(symbol, search_space, engine="grid_then_wf", extra_base=wf_base)
        grid_rec["engine"] = "grid_then_wf"
        grid_rec["wf"] = wf_rec["wf"]
        grid_rec["wf_best"] = wf_rec["best"]
        # Headline shifts to the OOS number.
        grid_rec["headline_metric_value"] = wf_rec.get("headline_metric_value")
        return grid_rec

    # ---- child drivers -----------------------------------------------------

    def _drive(self, inner, engine: str):
        """Run a muted child job to completion, forwarding progress. Returns
        inner.result. Raises on inner error / cancel."""
        inner.emit_enabled = False
        self._inner = inner
        self._inner_engine = engine
        inner.start()
        while inner.state in ("starting", "running"):
            if self.cancel_flag:
                inner.request_cancel()
            self._emit("overnight_progress", self._progress_payload())
            time.sleep(0.5)
        inner.join(timeout=2.0)
        self._inner = None
        if inner.state == "error":
            raise RuntimeError(inner.error or f"{engine} failed")
        if self.cancel_flag:
            raise _Cancelled()
        return inner.result or {}

    def _grid_once(self, symbol: str, n_workers: int) -> dict:
        s = self.spec
        inner_spec = {
            "strategy_id": s["strategy_id"], "symbol": symbol, "timeframe": s["timeframe"],
            "start_time": None, "end_time": None,
            "base_params": s["base_params"], "grid_params": s["grid_params"],
            "metric": s["metric"], "n_workers": n_workers,
            "max_combos": HARD_CEILING, "risk_snapshot": s["risk_snapshot"],
        }
        return self._drive(grid_search.GridSearchJob(inner_spec), "grid")

    def _run_grid(self, symbol: str) -> dict:
        s = self.spec
        self.current_engine = "grid"
        res = self._grid_once(symbol, s["n_workers"])
        rows = res.get("results") or []
        # A worker process can die abruptly (BrokenProcessPool) under load, leaving
        # the parallel grid with no rows. For an unattended run, fall back to a
        # single-core sweep of that one asset rather than skipping it.
        if not rows and s["n_workers"] > 1 and not self.cancel_flag:
            log.warning("overnight grid for %s returned no rows on %d workers; retrying serially",
                        symbol, s["n_workers"])
            res = self._grid_once(symbol, 1)
            rows = res.get("results") or []
        if not rows:
            raise RuntimeError("grid produced no results")

        metric = s["metric"]
        scored = sorted(
            ((grid_search._score_from_stats(r.get("stats") or {}, metric), r) for r in rows),
            key=lambda x: x[0], reverse=True,
        )
        best_val, best_row = scored[0]
        plateau = overnight_plateau.build_plateau(rows, s["grid_params"], metric)
        return {
            "symbol": symbol, "engine": "grid",
            "combos_run": res.get("completed_combos", len(rows)),
            "total_combos": res.get("total_combos", len(rows)),
            "partial": bool(res.get("partial")),
            "grid_params": s["grid_params"],
            "best": {"params": best_row["params"], "stats": best_row.get("stats") or {},
                     "metric_value": _safe_num(best_val)},
            "plateau": plateau,
            "top": [{"params": r["params"], "stats": _subset(r.get("stats") or {}),
                     "metric_value": _safe_num(sc)} for sc, r in scored[:TOP_N]],
            "headline_metric_value": _safe_num(best_val),
        }

    def _run_wf(self, symbol: str, search_space: list, engine: str, extra_base: dict = None) -> dict:
        s = self.spec
        self.current_engine = "walkforward"
        wf = s["wf_opts"]
        base = dict(s["base_params"])
        if extra_base:
            base.update(extra_base)
        wf_spec = {
            "strategy_id": s["strategy_id"], "symbol": symbol, "timeframe": s["timeframe"],
            "start_time": None, "end_time": None,
            "base_params": base, "search_space": search_space,
            "is_bars": wf["is_bars"], "oos_bars": wf["oos_bars"], "n_trials": wf["n_trials"],
            "n_workers": s["n_workers"], "metric": s["metric"],
            "embargo_bars": wf["embargo_bars"], "purge_radius": wf["purge_radius"],
            "sessions_cfg": wf["sessions_cfg"], "seed": wf["seed"],
        }
        res = self._drive(walkforward.WalkForwardJob(wf_spec), engine)
        stats = res.get("stats") or {}
        windows = res.get("windows") or []
        n_win = len(windows)
        pos = sum(1 for w in windows
                  if float((w.get("oos_stats") or {}).get("total_return_pct") or 0.0) > 0)
        score = grid_search._score_from_stats(stats, s["metric"])
        return {
            "symbol": symbol, "engine": "walkforward",
            "best": {"params": res.get("params") or {}, "stats": _subset(stats),
                     "metric_value": _safe_num(score)},
            "wf": {
                "stats": _subset(stats),
                "n_windows": n_win,
                "pct_windows_positive": (pos / n_win) if n_win else None,
                "oos_return_pct": _safe_num(stats.get("total_return_pct")),
            },
            "headline_metric_value": _safe_num(score),
        }

    # ---- grid -> WF search space ------------------------------------------

    def _grid_to_search_space(self, grid_rec: dict):
        """Hand WF the range the grid mapped. Multi-value params become search
        bounds [min, max]; single-value params are fixed into WF's base_params."""
        search_space, base = [], {}
        for gp in self.spec["grid_params"]:
            vals = sorted(gp["values"])
            if len(vals) < 2:
                if vals:
                    base[gp["name"]] = vals[0]
                continue
            lo, hi = vals[0], vals[-1]
            if gp["type"] == "int":
                gaps = [b - a for a, b in zip(vals, vals[1:]) if b > a]
                step = max(1, min(gaps)) if gaps else 1
                search_space.append({"name": gp["name"], "type": "int",
                                     "low": int(lo), "high": int(hi), "step": int(step)})
            else:
                search_space.append({"name": gp["name"], "type": "float",
                                     "low": float(lo), "high": float(hi), "step": None})
        return search_space, base

    # ---- accounting --------------------------------------------------------

    def _update_best(self, rec: dict) -> None:
        v = rec.get("headline_metric_value")
        if isinstance(v, (int, float)) and math.isfinite(v) and v > self._best_val:
            self._best_val = v
            self.best_so_far = {"symbol": rec.get("symbol"), "metric_value": v}

    def _checkpoint(self) -> None:
        try:
            overnight_store.save_current(self._build_result())
        except Exception:
            log.exception("overnight checkpoint failed")

    def _build_result(self) -> dict:
        s = self.spec
        result = {
            "kind": "overnight_run", "job_id": self.job_id,
            "strategy_id": s["strategy_id"], "timeframe": s["timeframe"],
            "mode": s["mode"], "metric": s["metric"], "n_workers": s["n_workers"],
            "grid_params": s.get("grid_params"),
            "search_space": s.get("search_space"),
            "base_params": s["base_params"], "risk_config": s["risk_snapshot"],
            "requested_symbols": s["symbols"],
            "skipped": self.skipped,
            "per_asset": self.per_asset,
            "best_so_far": self.best_so_far,
            "started_at": self.started_at,
            "finished_at": self.finished_at,
            "elapsed_seconds": (self.finished_at or time.time()) - self.started_at,
            "state": self.state,
            "partial": self.state not in ("done",),
        }
        return _json_safe(result)
