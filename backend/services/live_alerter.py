"""
Fires TradingView-style webhook alerts when a live strategy emits a signal.

Called from strategy_runner._emit_signal() ONLY when mode == "live". Looks up
ALL rules for a (strategy_id, symbol) pair in live_alerts.json — one thread
per rule — so you can target multiple VPS endpoints from a single signal.

Each POST carries the JSON payload the Binance acceptor expects:
  {
    "secret":   "<token>",
    "strategy": "<alias>",
    "leverage": "<int as string>",
    "action":   "BUY | SELL | EXIT_LONG | EXIT_SHORT",
    "symbol":   "BTCUSDT"
  }

Every attempt (ok/fail) emits a `live_alert_dispatched` Socket.IO event.
"""
from __future__ import annotations

import json
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
    ("long",  "entry"): "BUY",
    ("long",  "exit"):  "EXIT_LONG",
    ("short", "entry"): "SELL",
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


def _default_payload(rule: dict, action: str, symbol: str) -> dict:
    return {
        "secret":   rule["secret"],
        "strategy": rule["strategy_alias"],
        "leverage": str(rule["leverage"]),
        "action":   action,
        "symbol":   symbol,
    }


def build_payload(rule: dict, action: str, symbol: str) -> dict:
    template = rule.get("payload_template")
    if not template:
        return _default_payload(rule, action, symbol)
    tokens = {
        "action":   action,
        "symbol":   symbol,
        "secret":   rule["secret"],
        "strategy": rule["strategy_alias"],
        "leverage": str(rule["leverage"]),
    }
    rendered = template
    for key, val in tokens.items():
        rendered = rendered.replace("{{" + key + "}}", val)
    try:
        return json.loads(rendered)
    except (json.JSONDecodeError, ValueError):
        log.warning("payload_template for rule %r failed to render — falling back to default", rule.get("name"))
        return _default_payload(rule, action, symbol)


def _emit_dispatched(strategy_id: str, symbol: str, action: str, *,
                     ok: bool, status_code: Optional[int] = None,
                     error: Optional[str] = None, url: str = "",
                     rule_name: str = ""):
    event_bus.emit("live_alert_dispatched", {
        "rule_name":   rule_name,
        "strategy_id": strategy_id,
        "symbol":      symbol,
        "action":      action,
        "ok":          bool(ok),
        "status_code": status_code,
        "error":       error,
        "url":         url,
        "time":        int(time.time()),
    })


def _post(url: str, payload: dict, *, strategy_id: str, symbol: str,
          action: str, rule_name: str):
    try:
        r = httpx.post(url, json=payload, timeout=_TIMEOUT_SECONDS)
        ok = 200 <= r.status_code < 300
        log.info("live_alert [%s] %s %s → %s (status=%d secret=%s)",
                 rule_name, strategy_id, action, url, r.status_code,
                 _redact(payload.get("secret", "")))
        _emit_dispatched(strategy_id, symbol, action, ok=ok,
                         status_code=r.status_code,
                         error=None if ok else (r.text[:200] or None),
                         url=url, rule_name=rule_name)
    except Exception as e:
        log.warning("live_alert FAIL [%s] %s %s → %s: %s",
                    rule_name, strategy_id, action, url, e)
        _emit_dispatched(strategy_id, symbol, action, ok=False,
                         error=str(e), url=url, rule_name=rule_name)


def dispatch(strategy_id: str, symbol: str, sig: Signal) -> None:
    action = action_for(sig)
    if action is None:
        log.warning("live_alert skipped: no action mapping for side=%s kind=%s (strategy=%s symbol=%s)",
                    sig.side, sig.kind, strategy_id, symbol)
        return

    rules = live_alerts_config.find_rules(strategy_id, symbol)
    enabled = [r for r in rules if r.get("enabled")]
    if not enabled:
        return

    for rule in enabled:
        payload = build_payload(rule, action, symbol)
        threading.Thread(
            target=_post,
            args=(rule["webhook_url"], payload),
            kwargs={"strategy_id": strategy_id, "symbol": symbol,
                    "action": action, "rule_name": rule["name"]},
            daemon=True,
        ).start()


_VALID_ACTIONS = frozenset(_ACTION_MAP.values())


def test_dispatch(rule_name: str, action: str = "BUY") -> dict:
    """Synthetic fire for connectivity testing a specific named rule."""
    if action not in _VALID_ACTIONS:
        return {"ok": False, "error": f"unknown action '{action}'"}
    rule = live_alerts_config.find_rule_by_name(rule_name)
    if not rule:
        return {"ok": False, "error": f"no rule named '{rule_name}'"}
    if not rule.get("enabled"):
        return {"ok": False, "error": "rule is disabled"}

    payload = build_payload(rule, action, rule["symbol"])
    threading.Thread(
        target=_post,
        args=(rule["webhook_url"], payload),
        kwargs={"strategy_id": rule["strategy_id"], "symbol": rule["symbol"],
                "action": action, "rule_name": rule["name"]},
        daemon=True,
    ).start()

    preview = dict(payload)
    preview["secret"] = _redact(preview["secret"])
    return {"ok": True, "url": rule["webhook_url"], "payload": preview}
