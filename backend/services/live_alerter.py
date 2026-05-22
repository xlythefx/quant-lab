"""
Fires TradingView-style webhook alerts when a live strategy emits a signal.

Called from strategy_runner._emit_signal() ONLY when mode == "live". Looks
up a per-(strategy_id, symbol) rule in live_alerts.json; if enabled, POSTs
the JSON payload the user's Binance acceptor expects:

  {
    "secret":   "<token>",
    "strategy": "<alias>",
    "leverage": "<int as string>",
    "action":   "ENTER_LONG | EXIT_LONG | ENTER_SHORT | EXIT_SHORT",
    "symbol":   "BTCUSDT"
  }

The POST runs on a daemon thread with a 5s timeout — strategy execution is
never blocked. Every attempt (ok/fail) emits a `live_alert_dispatched`
Socket.IO event so the UI can surface recent firings.
"""
from __future__ import annotations

import logging
import threading
import time
from typing import Optional

import httpx

from services import event_bus, live_alerts_config
from services.strategies.base import Signal

log = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 5.0
_ACTION_MAP = {
    ("long",  "entry"): "ENTER_LONG",
    ("long",  "exit"):  "EXIT_LONG",
    ("short", "entry"): "ENTER_SHORT",
    ("short", "exit"):  "EXIT_SHORT",
}


def _redact(secret: str) -> str:
    if not secret:
        return ""
    if len(secret) <= 8:
        return "***"
    return f"{secret[:4]}…{secret[-4:]}"


def action_for(sig: Signal) -> Optional[str]:
    return _ACTION_MAP.get((sig.side, sig.kind))


def build_payload(rule: dict, action: str, symbol: str) -> dict:
    return {
        "secret":   rule["secret"],
        "strategy": rule["strategy_alias"],
        "leverage": str(rule["leverage"]),
        "action":   action,
        "symbol":   symbol,
    }


def _emit_dispatched(strategy_id: str, symbol: str, action: str, *,
                     ok: bool, status_code: Optional[int] = None,
                     error: Optional[str] = None, url: str = ""):
    event_bus.emit("live_alert_dispatched", {
        "strategy_id": strategy_id,
        "symbol":      symbol,
        "action":      action,
        "ok":          bool(ok),
        "status_code": status_code,
        "error":       error,
        "url":         url,
        "time":        int(time.time()),
    })


def _post(url: str, payload: dict, *, strategy_id: str, symbol: str, action: str):
    try:
        r = httpx.post(url, json=payload, timeout=_TIMEOUT_SECONDS)
        ok = 200 <= r.status_code < 300
        log.info("live_alert %s %s → %s (status=%d secret=%s)",
                 strategy_id, action, url, r.status_code, _redact(payload.get("secret", "")))
        _emit_dispatched(strategy_id, symbol, action, ok=ok, status_code=r.status_code,
                         error=None if ok else (r.text[:200] or None), url=url)
    except Exception as e:
        log.warning("live_alert FAIL %s %s → %s: %s", strategy_id, action, url, e)
        _emit_dispatched(strategy_id, symbol, action, ok=False, error=str(e), url=url)


def dispatch(strategy_id: str, symbol: str, sig: Signal) -> None:
    rule = live_alerts_config.find_rule(strategy_id, symbol)
    if not rule or not rule.get("enabled"):
        return

    action = action_for(sig)
    if action is None:
        log.warning("live_alert skipped: no action mapping for side=%s kind=%s (strategy=%s symbol=%s)",
                    sig.side, sig.kind, strategy_id, symbol)
        return

    payload = build_payload(rule, action, symbol)
    threading.Thread(
        target=_post,
        args=(rule["webhook_url"], payload),
        kwargs={"strategy_id": strategy_id, "symbol": symbol, "action": action},
        daemon=True,
    ).start()


def test_dispatch(strategy_id: str, symbol: str) -> dict:
    """Synthetic ENTER_LONG fire for connectivity testing. Returns a
    redacted preview of what was sent (or would have been sent)."""
    rule = live_alerts_config.find_rule(strategy_id, symbol)
    if not rule:
        return {"ok": False, "error": f"no rule for ({strategy_id}, {symbol})"}
    if not rule.get("enabled"):
        return {"ok": False, "error": "rule is disabled"}

    payload = build_payload(rule, "ENTER_LONG", symbol)
    threading.Thread(
        target=_post,
        args=(rule["webhook_url"], payload),
        kwargs={"strategy_id": strategy_id, "symbol": symbol, "action": "ENTER_LONG"},
        daemon=True,
    ).start()

    preview = dict(payload)
    preview["secret"] = _redact(preview["secret"])
    return {"ok": True, "url": rule["webhook_url"], "payload": preview}
