"""
Headless live-alert daemon — the ONLY component that POSTs strategy webhooks.

One runner per enabled rule ("deployment"). Keeps running as long as the Flask
process is alive — no browser connection required. Each runner:

  1. checks the rule (rule_validation) — a bad rule is reported, never run;
  2. WARMS UP from Binance REST before it listens to the live feed:
       - saved state for this exact config -> restore it (open position
         included) and catch up only on the bars it hasn't seen yet;
       - no saved state -> replay recent history SILENTLY to warm the
         indicators, then FORCE FLAT (the replay may have "opened" a
         historical trade that was never sent to the broker);
  3. runs strategy.on_candle on every CLOSED live bar and dispatches signals;
  4. saves its state after every processed bar (data/live_state/), so a
     restart never forgets an open position (and so never misses its exit).

The one catch-up rule (restored state, or bars missed during a reconnect): a
signal is FRESH when its bar closed within one bar-period of now. Fresh
signals are sent. Stale EXITS are still sent — closing late is safe, staying
open is not. Stale ENTRIES are dropped and logged as "missed (stale)".

Call `start(socket_manager)` once at app startup.
Call `refresh()` whenever rules are saved — ANY change to a rule restarts its
runner, so edits apply immediately.
"""
from __future__ import annotations

import hashlib
import json
import logging
import os
import re
import time
from threading import Event, Lock, RLock, Thread

import numpy as np

from config import DATA_DIR, TIMEFRAME_SECONDS
from services import live_alerter, live_alerts_config
from services.atomic_io import atomic_write_json
from services.binance_stream import fetch_closed_klines
from services.live import live_store
from services.live.live_symbols import is_binance_spot
from services.live.rule_validation import validate_rule
from services.strategy_registry import get_strategy_class, list_strategies

log = logging.getLogger(__name__)

_lock = Lock()
_socket_manager = None

# Active headless runners keyed by rule name (unique per rule).
_runners: dict[str, "_HeadlessRunner"] = {}

_STATE_DIR = os.path.join(DATA_DIR, "live_state")
HISTORY_MIN, HISTORY_MAX = 500, 1000   # warm-up bars fetched (1000 = one Binance request)
_GRACE_SECONDS = 90                    # STARTING (not STALE) this long after a (re)start
_BACKFILL_PAGES = 10                   # max 1000-bar REST pages per backfill


def _fmt_utc(epoch: float | None) -> str:
    return time.strftime("%b %d, %Y %H:%M UTC", time.gmtime(epoch)) if epoch else "never"


def state_key(rule: dict) -> str:
    """Hash of what defines the strategy's behaviour. A change here (new params,
    symbol, timeframe, strategy) means saved state no longer applies -> fresh start."""
    raw = json.dumps([rule.get("strategy_id"), rule.get("symbol"), rule.get("timeframe"),
                      rule.get("params") or {}], sort_keys=True, default=str)
    return hashlib.sha1(raw.encode("utf-8")).hexdigest()[:16]


def _state_path(name: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9_-]+", "_", name).strip("_")[:60] or "rule"
    tag = hashlib.sha1(name.encode("utf-8")).hexdigest()[:8]
    return os.path.join(_STATE_DIR, f"rule_{slug}_{tag}.json")


def _json_safe(v):
    """Strategy state as plain JSON types (numpy scalars -> Python). NaN is kept:
    Python's json round-trips it, and strategies read NaN as 'no value'."""
    if isinstance(v, dict):
        return {str(k): _json_safe(x) for k, x in v.items()}
    if isinstance(v, (list, tuple, set)):
        return [_json_safe(x) for x in v]
    if isinstance(v, np.generic):
        return v.item()
    return v


def _as_list(out) -> list:
    return [] if out is None else (out if isinstance(out, list) else [out])


# ---------------------------------------------------------------------------

class _HeadlessRunner:
    """One live deployment: warm-up, live bars, dispatch, persisted state, health."""

    def __init__(self, rule: dict, socket_manager):
        self.rule = rule
        self.name = rule["name"]
        self.strategy_id = rule["strategy_id"]
        self.symbol = rule["symbol"]
        self.timeframe = rule["timeframe"]
        self.period = int(TIMEFRAME_SECONDS.get(self.timeframe, 60))
        self._sm = socket_manager
        self.strategy = None
        self._state: dict = {}
        self._last_bar = 0              # open time of the last processed closed bar
        self._key = state_key(rule)
        self._path = _state_path(self.name)
        self._lock = RLock()
        self._stop = Event()
        self._listener = None
        self.health = {
            "started_at": int(time.time()),
            "phase": "starting",        # starting -> live
            "last_closed_bar_time": None,
            "last_signal": None,        # {action, time, stale}
            "last_error": None,         # {message, time} — most recent problem, informational
            "error": None,              # current blocking problem -> status ERROR
        }

    # ---- lifecycle -----------------------------------------------------------
    def start(self):
        Thread(target=self._boot, name=f"live-runner[{self.name}]", daemon=True).start()

    def stop(self):
        self._stop.set()
        with self._lock:
            if self._listener:
                self._sm.remove_listener("live", self.symbol, self.timeframe, self._listener)
                self._listener = None
        log.info("[alerts_daemon] stopped runner %s/%s/%s (rule=%s)",
                 self.strategy_id, self.symbol, self.timeframe, self.name)

    def _boot(self):
        """Start, and keep retrying (backoff capped at 60s) until it works or the
        rule is stopped — a start failure is recorded as the runner's error."""
        delay = 5
        while not self._stop.is_set():
            try:
                self._start_once()
                return
            except Exception as e:
                self._fail(f"start failed: {e}")
                log.warning("[alerts_daemon] runner %s start failed (retry in %ds): %s",
                            self.name, delay, e)
            self._stop.wait(delay)
            delay = min(60, delay * 2)

    def _start_once(self):
        problems = validate_rule(self.rule)
        if problems:
            raise ValueError("; ".join(problems))
        self.strategy = get_strategy_class(self.strategy_id)(self.rule.get("params") or {})
        history = []
        if is_binance_spot(self.symbol):
            n = min(HISTORY_MAX, max(HISTORY_MIN, int(self.strategy.warmup_bars())))
            history = fetch_closed_klines(self.symbol, self.timeframe, limit=n)
        with self._lock:
            if self._stop.is_set():
                return
            self._warm_up(history)
            if self._stop.is_set():
                return
            self._listener = self._on_feed
            self._sm.add_listener("live", self.symbol, self.timeframe, self._listener)
            self.health.update(phase="live", error=None)
        log.info("[alerts_daemon] runner %s live on %s/%s (strategy=%s)",
                 self.name, self.symbol, self.timeframe, self.strategy_id)

    # ---- warm-up / restore ---------------------------------------------------
    def _warm_up(self, history: list[dict]):
        saved = self._load_saved()
        if saved is not None:
            self._state = saved["state"]
            self._last_bar = int(saved.get("last_bar") or 0)
            self.health["last_closed_bar_time"] = self._last_bar or None
            newer = [b for b in history if b["time"] > self._last_bar]
            gap = bool(newer and self._last_bar and newer[0]["time"] > self._last_bar + self.period)
            self._activity("info", f"restored saved state (last bar {_fmt_utc(self._last_bar)}); "
                                   f"catching up {len(newer)} bar(s)"
                                   + (" — history has a hole since then, indicators re-warm as bars arrive"
                                      if gap else ""))
            for bar in newer:
                if self._stop.is_set():
                    return
                self._process(bar)
            return

        # Fresh start: warm indicators silently (no dispatch, no journal) ...
        for bar in history:
            if self._stop.is_set():
                return
            self._run_strategy(bar)
        # ... then FORCE FLAT: never believe in a historical trade the broker never got.
        self.strategy.reset_position(self._state)
        if history:
            self._last_bar = int(history[-1]["time"])
            self.health["last_closed_bar_time"] = self._last_bar
        self._activity("info", f"warmed up on {len(history)} {self.timeframe} bar(s); starting flat")
        self._save()

    def _load_saved(self) -> dict | None:
        try:
            with open(self._path, "r") as f:
                saved = json.load(f)
        except FileNotFoundError:
            return None
        except Exception as e:
            log.warning("[alerts_daemon] unreadable saved state for %s (%s) — starting fresh", self.name, e)
            return None
        if not isinstance(saved, dict) or not isinstance(saved.get("state"), dict):
            return None
        if saved.get("key") != self._key:
            pos = saved["state"].get("pos")
            if pos:
                side = "LONG" if pos > 0 else "SHORT"
                self._activity("info", f"settings changed while the strategy held a {side} position — "
                                       f"it starts flat and will NOT send that exit; check the broker",
                               ok=False)
            return None
        return saved

    def _save(self):
        try:
            atomic_write_json(self._path, {
                "key": self._key, "rule_name": self.name,
                "strategy_id": self.strategy_id, "symbol": self.symbol, "timeframe": self.timeframe,
                "last_bar": self._last_bar, "saved_at": int(time.time()),
                "state": _json_safe(self._state),
            }, indent=None)
        except Exception as e:
            log.warning("[alerts_daemon] could not save state for %s: %s", self.name, e)

    # ---- bars ----------------------------------------------------------------
    def _run_strategy(self, bar: dict) -> list:
        return _as_list(self.strategy.on_candle(bar, self._state))

    def _is_fresh(self, bar_time: int) -> bool:
        """The bar closed within one bar-period of now."""
        return time.time() - (bar_time + self.period) <= self.period

    def _process(self, bar: dict):
        """One closed bar through the strategy -> (fresh/stale rule) -> dispatch."""
        t = int(bar["time"])
        if t <= self._last_bar:
            return   # already seen (duplicate frame / overlap with history)
        was_flat = not self._state.get("pos")
        try:
            signals = self._run_strategy(bar)
            if (self.health["error"] or "").startswith("on_candle"):
                self.health["error"] = None
        except Exception as e:
            log.exception("[alerts_daemon] on_candle error (rule=%s)", self.name)
            self._fail(f"on_candle error on bar {_fmt_utc(t)}: {e}")
            signals = []
        self._last_bar = t
        self.health["last_closed_bar_time"] = t

        fresh = self._is_fresh(t)
        send = [s for s in signals if fresh or s.kind == "exit"]
        missed = [s for s in signals if not (fresh or s.kind == "exit")]
        if missed:
            age_min = int((time.time() - (t + self.period)) // 60)
            for s in missed:
                self._activity("missed", f"missed (stale): bar closed {age_min} min ago — "
                                         f"late entries are never sent", action=live_alerter.action_for(s),
                               ok=False)
            # The broker never got this entry: don't let the strategy think it's in it.
            if was_flat or any(s.kind == "exit" for s in send):
                self.strategy.reset_position(self._state)

        self._save()   # state first: after a crash this bar is never re-sent

        try:
            from services.live import live_engine
            live_engine.note_eval(self.rule, bar, send)
            if send:
                send = live_engine.filter_new_signals(self.rule, bar, send)
                live_engine.on_signals(self.rule, bar, send)
        except Exception:
            log.exception("[alerts_daemon] live_engine hook failed (continuing)")

        # on_candle may return several signals (a pyramiding add, or exit + flip):
        # one webhook each, in order, so the broker stacks/flattens correctly.
        for s in send:
            self.health["last_signal"] = {"action": live_alerter.action_for(s), "time": t, "stale": not fresh}
            live_alerter.dispatch_for_rule(self.rule, self.symbol, s)

    def _on_feed(self, msg: dict):
        """Live stream callback (the stream's own thread)."""
        with self._lock:
            if self._stop.is_set():
                return
            try:
                if msg.get("__event") == "reconnected":
                    self._safe_backfill()
                    return
                if not msg.get("isClosed"):
                    return
                t = int(msg["time"])
                if t <= self._last_bar:
                    return
                if self._last_bar and t > self._last_bar + self.period:
                    self._safe_backfill(until=t)   # bars closed while we weren't listening
                self._process(msg)
            except Exception as e:
                log.exception("[alerts_daemon] live bar failed (rule=%s)", self.name)
                self._fail(f"live bar handling failed: {e}")

    def _backfill(self, until: int | None = None):
        """Fetch closed bars after the last processed one (and before `until`)
        from REST and run them through _process (fresh/stale rule applies)."""
        if not self._last_bar or not is_binance_spot(self.symbol):
            return
        for _ in range(_BACKFILL_PAGES):
            bars = fetch_closed_klines(self.symbol, self.timeframe, limit=1000,
                                       start_time=self._last_bar + self.period)
            bars = [b for b in bars if b["time"] > self._last_bar and (until is None or b["time"] < until)]
            if not bars:
                return
            self._activity("info", f"backfilled {len(bars)} missed {self.timeframe} bar(s)")
            for bar in bars:
                self._process(bar)

    def _safe_backfill(self, until: int | None = None):
        try:
            self._backfill(until)
        except Exception as e:
            log.warning("[alerts_daemon] backfill failed for %s: %s", self.name, e)
            self._activity("info", f"could not backfill missed bars ({e}); continuing with live bars",
                           ok=False)

    # ---- health ----------------------------------------------------------------
    def _fail(self, message: str):
        self.health["error"] = message
        self.health["last_error"] = {"message": message, "time": int(time.time())}

    def _activity(self, kind: str, detail: str, action: str = "", ok: bool = True):
        try:
            live_store.add_activity(kind, rule_name=self.name, symbol=self.symbol,
                                    action=action or "", ok=ok, detail=detail)
        except Exception:
            log.debug("[alerts_daemon] activity log failed", exc_info=True)

    def health_snapshot(self) -> dict:
        connected = False
        if self._listener is not None:
            stream = self._sm.stream_for("live", self.symbol, self.timeframe)
            if stream is not None:
                # Binance streams know if the socket is open; others (CSV tail) only if alive.
                connected = bool(stream.connected) if hasattr(stream, "connected") else stream.is_running()
        h = dict(self.health)
        h["feed_connected"] = connected
        return h


# ---------------------------------------------------------------------------

def _wanted_rules() -> dict[str, dict]:
    """Return {rule_name: rule} for all enabled rules that have a timeframe."""
    rules = live_alerts_config.load_rules()
    return {
        r["name"]: r
        for r in rules
        if r.get("enabled") and r.get("timeframe", "").strip()
    }


def _stop_runner(name: str):
    """Pop and stop a runner without ever raising.

    A runner whose underlying live stream has wedged (e.g. a websocket that
    died with a teardown error) must not crash refresh() — otherwise every
    subsequent rule save 500s until the process is restarted.
    """
    runner = _runners.pop(name, None)
    if runner is None:
        return
    try:
        runner.stop()
    except Exception:
        log.exception("[alerts_daemon] error stopping runner %s (continuing)", name)


def forget_state(name: str):
    """Delete a deleted deployment's saved state, so a NEW deployment that
    reuses the name can't inherit an old position."""
    try:
        os.remove(_state_path(name))
    except FileNotFoundError:
        pass
    except Exception:
        log.exception("[alerts_daemon] could not delete saved state for %s", name)


def rename_state(old_name: str, new_name: str):
    """Carry a deployment's saved state (incl. any open position) across a rename."""
    src, dst = _state_path(old_name), _state_path(new_name)
    try:
        with open(src, "r") as f:
            saved = json.load(f)
        saved["rule_name"] = new_name
        atomic_write_json(dst, saved, indent=None)
        os.remove(src)
    except FileNotFoundError:
        pass
    except Exception:
        log.exception("[alerts_daemon] could not move state %s -> %s", old_name, new_name)


def refresh():
    """Reconcile running headless runners against the current enabled rules.
    Safe to call from any thread (e.g. after saving rules via the UI).
    Restarts a runner whenever ANY field of its rule changed — webhook, secret,
    leverage, account, params… — so edits apply immediately.
    """
    if _socket_manager is None:
        return
    wanted = _wanted_rules()

    with _lock:
        for name in list(_runners):
            if name not in wanted:
                _stop_runner(name)

        for name, rule in wanted.items():
            current = _runners.get(name)
            if current is not None and current.rule == rule:
                continue
            if current is not None:
                _stop_runner(name)
            runner = _HeadlessRunner(rule, _socket_manager)
            _runners[name] = runner
            runner.start()


def deployment_status(rule: dict) -> dict:
    """What the deployment is REALLY doing: {status, detail, health}.

    RUNNING  enabled + feed connected + a closed bar within 2x the timeframe
    STARTING just (re)started — warming up / connecting (grace period)
    STALE    enabled but no recent bar, or the feed is disconnected
    ERROR    the runner failed (bad rule, start failure, strategy error)
    PAUSED   disabled
    """
    if not rule.get("enabled"):
        return {"status": "PAUSED", "detail": "paused — not listening, sends nothing", "health": None}
    with _lock:
        runner = _runners.get(rule["name"])
    if runner is None:
        return {"status": "ERROR", "detail": "not running — the live daemon has no runner for it",
                "health": None}
    h = runner.health_snapshot()
    if h["error"]:
        return {"status": "ERROR", "detail": h["error"], "health": h}
    now = time.time()
    last = h["last_closed_bar_time"]
    bar_recent = last is not None and now - (last + runner.period) <= 2 * runner.period
    if h["phase"] == "live" and h["feed_connected"] and bar_recent:
        return {"status": "RUNNING", "detail": "", "health": h}
    if now - h["started_at"] < _GRACE_SECONDS:
        detail = "warming up on recent history" if h["phase"] != "live" else "connecting to the live feed"
        return {"status": "STARTING", "detail": detail, "health": h}
    if not h["feed_connected"]:
        return {"status": "STALE", "detail": "live feed disconnected — reconnecting", "health": h}
    return {"status": "STALE", "detail": f"no closed bar since {_fmt_utc(last + runner.period if last else None)}",
            "health": h}


def start(socket_manager):
    """Call once at Flask app startup."""
    global _socket_manager
    _socket_manager = socket_manager
    log.info("[alerts_daemon] initialising from saved rules")
    # Scan the strategy registry once here: the runners boot in parallel threads,
    # and the registry's lazy first scan isn't safe to run from several at once.
    list_strategies()
    refresh()
