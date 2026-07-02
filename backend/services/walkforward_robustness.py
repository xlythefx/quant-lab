"""
Multi-seed robustness for Walk-Forward Optimization.

Runs the SAME WFA config across several optimizer seeds. Each seed makes Optuna
explore a different search path, so clustered results = a real edge, while
scattered / sign-flipping results = the edge was an artifact of one lucky seed
(overfitting to the optimizer). This complements the Monte Carlo page, which
probes path/sequence luck on a *fixed* parameter set — here we probe the
optimization itself.

One job at a time (mirrors services.walkforward). Each seed reuses the full
parallel WFA engine (all CPU cores); seeds run back-to-back. The inner jobs run
with events suppressed; this module forwards its own rb_* progress instead.
"""
from __future__ import annotations

import logging
import statistics
import threading
import time
import uuid
from typing import Optional

from services import event_bus, walkforward

log = logging.getLogger(__name__)

_lock = threading.Lock()
_current_job: Optional["RobustnessJob"] = None
_last_result: Optional[dict] = None

# Headline metrics pulled from each seed's stitched OOS stats.
METRICS = ["total_return_pct", "sharpe", "profit_factor", "max_drawdown_pct", "trades"]


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


def start(spec: dict, seeds: list) -> str:
    """Cancel any running robustness job and start a new one."""
    global _current_job
    with _lock:
        prev = _current_job
    if prev is not None and prev.state in ("running", "starting"):
        prev.request_cancel()
        prev.join(timeout=5.0)
    job = RobustnessJob(spec, seeds)
    with _lock:
        _current_job = job
    job.start()
    return job.job_id


class RobustnessJob:
    def __init__(self, spec: dict, seeds: list):
        self.spec = dict(spec)
        self.seeds = [int(s) for s in (seeds or [])] or [1, 2, 3, 4, 5]
        self.job_id = uuid.uuid4().hex[:12]
        self.state = "starting"  # starting | running | done | cancelled | error
        self.cancel_flag = False
        self.started_at = time.time()
        self.error: Optional[str] = None

        self.seed_idx = 0                 # 1-based index of the seed running now
        self.n_seeds = len(self.seeds)
        self.per_seed: list[dict] = []
        self._inner: Optional[walkforward.WalkForwardJob] = None

        self._thread = threading.Thread(target=self._run, name=f"rb-{self.job_id}", daemon=True)

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
        done = len(self.per_seed)
        if self.state == "running" and done > 0:
            per = (time.time() - self.started_at) / done
            return max(0.0, per * (self.n_seeds - done))
        return None

    def snapshot(self) -> dict:
        inner = self._inner
        return {
            "state": self.state,
            "job_id": self.job_id,
            "kind": "robustness",
            "seed_idx": self.seed_idx,
            "n_seeds": self.n_seeds,
            "seeds": self.seeds,
            # current seed's inner WFA progress + the shared CPU monitor
            "window_idx": getattr(inner, "window_idx", 0) if inner else 0,
            "total_windows": getattr(inner, "total_windows", 0) if inner else 0,
            "cpu_percent": getattr(inner, "cpu_percent", 0.0) if inner else 0.0,
            "cpu_percent_percore": getattr(inner, "cpu_percent_percore", []) if inner else [],
            "active_workers": getattr(inner, "active_workers", 0) if inner else 0,
            "n_workers": getattr(inner, "n_workers_effective", 1) if inner else 1,
            "elapsed_seconds": time.time() - self.started_at,
            "eta_seconds": self._eta(),
            "per_seed": self.per_seed,
            "error": self.error,
        }

    # ---- thread ------------------------------------------------------------

    def _run(self) -> None:
        try:
            self.state = "running"
            self._do_run()
            if self.cancel_flag:
                self.state = "cancelled"
                self._emit("rb_cancelled", {})
            else:
                self.state = "done"
        except Exception as e:
            log.exception("robustness job failed")
            self.error = str(e)
            self.state = "error"
            self._emit("rb_error", {"message": str(e)})

    def _do_run(self) -> None:
        for i, seed in enumerate(self.seeds):
            if self.cancel_flag:
                break
            self.seed_idx = i + 1
            spec_i = dict(self.spec)
            spec_i["seed"] = int(seed)
            inner = walkforward.WalkForwardJob(spec_i)
            inner.emit_enabled = False     # no wf_* leakage to the single-run UI
            self._inner = inner
            inner.start()

            # Poll the inner job, forwarding its progress as rb_progress.
            while inner.is_alive():
                if self.cancel_flag:
                    inner.request_cancel()
                self._emit("rb_progress", self._progress_payload())
                time.sleep(0.5)
            inner.join(timeout=2.0)

            if inner.state == "error":
                raise RuntimeError(inner.error or "inner walk-forward failed")
            if self.cancel_flag:
                break

            self.per_seed.append(self._extract(seed, inner.result or {}))
            self._emit("rb_progress", self._progress_payload())

        self._inner = None
        if self.cancel_flag:
            return

        summary, verdict = self._summarize()
        result = {
            "kind": "robustness",
            "strategy_id": self.spec.get("strategy_id"),
            "symbol": self.spec.get("symbol"),
            "timeframe": self.spec.get("timeframe"),
            "metric": self.spec.get("metric"),
            "seeds": self.seeds,
            "per_seed": self.per_seed,
            "summary": summary,
            "verdict": verdict,
        }
        global _last_result
        _last_result = result
        self._emit("rb_complete", {"result": result})

    def _progress_payload(self) -> dict:
        s = self.snapshot()
        s.pop("per_seed", None)   # heavy + not needed mid-flight
        return s

    @staticmethod
    def _extract(seed: int, res: dict) -> dict:
        st = (res or {}).get("stats") or {}
        return {
            "seed": int(seed),
            "total_return_pct": st.get("total_return_pct"),
            "sharpe": st.get("sharpe"),
            "profit_factor": st.get("profit_factor"),
            "max_drawdown_pct": st.get("max_drawdown_pct"),
            "trades": st.get("trades"),
        }

    def _summarize(self):
        summary = {}
        for key in METRICS:
            vals = [p[key] for p in self.per_seed if isinstance(p.get(key), (int, float))]
            if not vals:
                summary[key] = None
                continue
            summary[key] = {
                "values": vals,
                "min": min(vals), "max": max(vals),
                "median": statistics.median(vals),
                "mean": statistics.fmean(vals),
                "std": statistics.pstdev(vals) if len(vals) > 1 else 0.0,
            }
        return summary, self._verdict(summary)

    @staticmethod
    def _verdict(summary: dict) -> dict:
        sh = summary.get("sharpe")
        ret = summary.get("total_return_pct")
        if not sh or not ret:
            return {"label": "inconclusive",
                    "text": "Not enough completed seeds to judge robustness."}
        sh_vals = sh["values"]
        pos = sum(1 for v in sh_vals if v > 0) / len(sh_vals)
        med = sh["median"]
        spread = (sh["std"] / abs(med)) if med else float("inf")
        if med <= 0:
            return {"label": "weak",
                    "text": "The median seed isn't profitable on a risk-adjusted basis — the edge doesn't hold up across seeds."}
        if pos >= 0.99 and spread < 0.5:
            return {"label": "robust",
                    "text": "Every seed produced a positive risk-adjusted return with a tight spread — the edge looks real, not seed-luck."}
        if pos >= 0.6:
            return {"label": "mixed",
                    "text": "Most seeds are positive, but results vary noticeably across seeds — treat with caution and lean toward more conservative parameters."}
        return {"label": "fragile",
                "text": "Results flip across seeds — the strategy is likely overfit to the optimizer seed rather than carrying a real edge."}
