"""
Live Terminal runtime engine — the glue between the (unchanged) headless
alert daemon and the terminal's views. Everything here is additive: the old
#livealerts page keeps working whether or not the terminal is open.

Responsibilities
  - kill switch: one flag that blocks EVERY webhook POST immediately
  - signal idempotency: a given (rule, bar-time, action) fires at most once
  - "why did/didn't it fire": last evaluation per rule
  - open-position tracking per rule → journal_trades rows on each realized
    round-trip (persisted in SQLite settings so restarts don't lose a leg)
  - live_signal socket events (chart markers / activity feed)
  - webhook dispatch recording (alerts_history + activity)

$ P&L note: live sizing happens at the broker, so journal pnl_usd is an
ESTIMATE: pct-move × (starting_capital × risk_pct × leverage). Phase 09
reconciles against the broker's ACTUAL realized P&L from WAMP.
"""
from __future__ import annotations

import logging
import time
from threading import Lock

from services import event_bus, risk_config
from services.live import live_store
from services.strategies.base import Signal

log = logging.getLogger(__name__)

_lock = Lock()

# rule name -> {"bar_time", "close", "fired": [actions], "at"}
_last_eval: dict[str, dict] = {}
# rule name -> last dispatch outcome {"ok", "at", "error"}
_last_dispatch: dict[str, dict] = {}
# fired-signal idempotency keys (rule|bar_time|action), bounded
_fired_keys: set[str] = set()
_fired_order: list[str] = []
_FIRED_CAP = 4000

_ACTION_MAP = {
    ("long", "entry"): "BUY",
    ("long", "exit"): "EXIT_LONG",
    ("short", "entry"): "SELL",
    ("short", "exit"): "EXIT_SHORT",
}


# ---- kill switch -------------------------------------------------------------

def kill_switch() -> bool:
    return bool(live_store.get_setting("kill_switch", False))


def set_kill_switch(killed: bool) -> bool:
    live_store.set_setting("kill_switch", bool(killed))
    live_store.add_activity("killswitch", detail="DISARMED ALL — webhooks blocked" if killed else "re-armed")
    event_bus.emit("deployments_changed", {"killswitch": bool(killed)})
    log.warning("[live_engine] kill switch %s", "ENGAGED" if killed else "released")
    return bool(killed)


# ---- rule helpers --------------------------------------------------------------

def _account_of(rule: dict) -> str:
    return str(rule.get("account") or "demo").lower()


def _notional_estimate(rule: dict) -> float:
    """Estimated live exposure for $-P&L: capital × risk_pct × leverage."""
    try:
        cap = float(risk_config.get().get("starting_capital", 100_000.0))
    except Exception:
        cap = 100_000.0
    params = rule.get("params") or {}
    try:
        risk_pct = float(params.get("risk_pct", 0.10) or 0.10)
    except (TypeError, ValueError):
        risk_pct = 0.10
    lev = max(1, int(rule.get("leverage") or 1))
    return cap * risk_pct * lev


# ---- evaluation + signals -------------------------------------------------------

def note_eval(rule: dict, candle: dict, signals: list[Signal] | None) -> None:
    """Record the last closed-bar evaluation for 'why did/didn't it fire'."""
    with _lock:
        _last_eval[rule["name"]] = {
            "bar_time": int(candle.get("time") or 0),
            "close": float(candle.get("close") or 0.0),
            "fired": [_ACTION_MAP.get((s.side, s.kind), "?") for s in (signals or [])],
            "at": int(time.time()),
        }


def _seen(key: str) -> bool:
    if key in _fired_keys:
        return True
    _fired_keys.add(key)
    _fired_order.append(key)
    if len(_fired_order) > _FIRED_CAP:
        old = _fired_order.pop(0)
        _fired_keys.discard(old)
    return False


def filter_new_signals(rule: dict, candle: dict, signals: list[Signal]) -> list[Signal]:
    """Idempotency guard: (rule, bar-time, action) fires at most once, so a
    reconnect / double-delivered closed bar never double-sends a webhook."""
    out = []
    bar_t = int(candle.get("time") or 0)
    with _lock:
        for s in signals:
            action = _ACTION_MAP.get((s.side, s.kind))
            if action is None:
                continue
            key = f"{rule['name']}|{bar_t}|{action}"
            if _seen(key):
                log.warning("[live_engine] duplicate signal suppressed: %s", key)
                continue
            out.append(s)
    return out


def _positions() -> dict:
    return live_store.get_setting("open_positions", {}) or {}


def _save_positions(pos: dict) -> None:
    live_store.set_setting("open_positions", pos)


def on_signals(rule: dict, candle: dict, signals: list[Signal]) -> None:
    """Track position state per rule, journal realized round-trips, emit
    live_signal events. Called AFTER filter_new_signals."""
    name = rule["name"]
    account = _account_of(rule)
    for s in signals:
        action = _ACTION_MAP.get((s.side, s.kind))
        if action is None:
            continue

        event_bus.emit("live_signal", {
            "rule_name": name,
            "strategy_id": rule.get("strategy_id"),
            "symbol": rule.get("symbol"),
            "timeframe": rule.get("timeframe"),
            "side": s.side, "kind": s.kind, "action": action,
            "price": float(s.price or 0.0),
            "time": int(s.time or candle.get("time") or time.time()),
            "account": account,
            "reason": s.reason or "",
            "test": False,
        })
        live_store.add_activity("signal", rule_name=name, symbol=rule.get("symbol", ""),
                                action=action, ok=True,
                                detail=f"price={s.price} reason={s.reason or '-'}")

        pos = _positions()
        cur = pos.get(name)
        if s.kind == "entry":
            if cur is None:
                pos[name] = {
                    "side": s.side,
                    "entry": float(s.price or 0.0),
                    "entry_time": int(s.time or candle.get("time") or time.time()),
                }
                _save_positions(pos)
            # live parity: pyramiding=1 — an add while open is ignored for journal state
        elif s.kind == "exit" and cur is not None:
            entry = float(cur.get("entry") or 0.0)
            exit_p = float(s.price or 0.0)
            direction = 1.0 if cur.get("side") == "long" else -1.0
            pnl_pct = ((exit_p - entry) / entry * 100.0 * direction) if entry else 0.0
            exit_t = int(s.time or candle.get("time") or time.time())
            entry_t = int(cur.get("entry_time") or exit_t)
            live_store.add_journal_trade({
                "ts": exit_t,
                "entry_time": entry_t,
                "rule_name": name,
                "strategy_id": rule.get("strategy_id"),
                "strategy": rule.get("strategy_alias") or rule.get("strategy_id"),
                "symbol": rule.get("symbol"),
                "timeframe": rule.get("timeframe"),
                "account": account,
                "venue": "BINANCE" if (rule.get("broker") or "binance") == "binance" else "TRADESTATION",
                "side": "LONG" if cur.get("side") == "long" else "SHORT",
                "entry": entry,
                "exit": exit_p,
                "pnl_pct": pnl_pct,
                "pnl_usd": pnl_pct / 100.0 * _notional_estimate(rule),
                "r": None,  # no stop distance tracked live — honest NULL
                "hold_min": max(0.0, (exit_t - entry_t) / 60.0),
            })
            pos.pop(name, None)
            _save_positions(pos)


# ---- dispatch recording (called from live_alerter) ------------------------------

def record_dispatch(payload: dict) -> None:
    """Persist every webhook attempt (ok/fail/blocked/dry-run) + activity."""
    name = payload.get("rule_name") or ""
    ok = bool(payload.get("ok"))
    dry = bool(payload.get("dry_run"))
    blocked = bool(payload.get("blocked"))
    with _lock:
        _last_dispatch[name] = {
            "ok": ok, "at": int(payload.get("time") or time.time()),
            "error": payload.get("error"), "dry_run": dry, "blocked": blocked,
        }
    live_store.add_alert_history({
        "ts": payload.get("time") or int(time.time()),
        "rule_name": name,
        "strategy_id": payload.get("strategy_id"),
        "symbol": payload.get("symbol"),
        "action": payload.get("action"),
        "price": payload.get("price"),
        "ok": ok,
        "status_code": payload.get("status_code"),
        "error": payload.get("error"),
        "url": payload.get("url"),
        "test": payload.get("test", False),
        "dry_run": dry,
        "account": payload.get("account", "demo"),
    })
    kind = "webhook_blocked" if blocked else ("webhook_ok" if ok else "webhook_fail")
    if dry:
        kind = "test_signal"
    live_store.add_activity(kind, rule_name=name, symbol=payload.get("symbol", ""),
                            action=payload.get("action", ""), ok=ok,
                            detail=payload.get("error") or (f"HTTP {payload.get('status_code')}" if payload.get("status_code") else ""))


# ---- runtime state for the deployments view --------------------------------------

def runtime_state() -> dict:
    """Merge journal totals + last evals + last dispatches per rule name."""
    totals = live_store.journal_totals_by_rule()
    with _lock:
        evals = {k: dict(v) for k, v in _last_eval.items()}
        dispatches = {k: dict(v) for k, v in _last_dispatch.items()}
    positions = _positions()
    return {
        "totals": totals,
        "last_eval": evals,
        "last_dispatch": dispatches,
        "open_positions": positions,
        "killswitch": kill_switch(),
    }
