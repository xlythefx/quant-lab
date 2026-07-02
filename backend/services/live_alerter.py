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
                     rule_name: str = "", price: Optional[float] = None,
                     account: str = "demo", test: bool = False,
                     dry_run: bool = False, blocked: bool = False):
    payload = {
        "rule_name":   rule_name,
        "strategy_id": strategy_id,
        "symbol":      symbol,
        "action":      action,
        "ok":          bool(ok),
        "status_code": status_code,
        "error":       error,
        "url":         url,
        "time":        int(time.time()),
        "price":       price,
        "account":     account,
        "test":        bool(test),
        "dry_run":     bool(dry_run),
        "blocked":     bool(blocked),
    }
    event_bus.emit("live_alert_dispatched", payload)
    # Persist to the terminal's alerts_history / activity log (additive; the
    # old #livealerts page keeps its own localStorage view of this event).
    try:
        from services.live import live_engine
        live_engine.record_dispatch(payload)
    except Exception:
        log.exception("live_engine.record_dispatch failed (non-fatal)")


def _kill_switch_engaged() -> bool:
    try:
        from services.live import live_engine
        return live_engine.kill_switch()
    except Exception:
        return False


def _post(url: str, payload: dict, *, strategy_id: str, symbol: str,
          action: str, rule_name: str, price: Optional[float] = None,
          account: str = "demo", test: bool = False):
    last_err: str | None = None
    for attempt in range(3):
        try:
            r = httpx.post(url, json=payload, timeout=_TIMEOUT_SECONDS)
            if 200 <= r.status_code < 300:
                log.info("live_alert [%s] %s %s → %s (status=%d secret=%s)",
                         rule_name, strategy_id, action, url, r.status_code,
                         _redact(payload.get("secret", "")))
                _emit_dispatched(strategy_id, symbol, action, ok=True,
                                 status_code=r.status_code, url=url, rule_name=rule_name,
                                 price=price, account=account, test=test)
                return
            last_err = f"HTTP {r.status_code}: {r.text[:2000]}" if r.text else f"HTTP {r.status_code}"
        except Exception as e:
            last_err = str(e)
            log.warning("live_alert [%s] attempt %d failed: %s", rule_name, attempt + 1, e)
        if attempt < 2:
            time.sleep(2 ** attempt)   # 1s, 2s backoff before retry

    log.warning("live_alert FAIL [%s] %s %s → %s: %s (all retries exhausted)",
                rule_name, strategy_id, action, url, last_err)
    _emit_dispatched(strategy_id, symbol, action, ok=False,
                     error=last_err, url=url, rule_name=rule_name,
                     price=price, account=account, test=test)


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

    if _kill_switch_engaged():
        for rule in enabled:
            log.warning("live_alert BLOCKED by kill switch [%s] %s %s", rule["name"], strategy_id, action)
            _emit_dispatched(strategy_id, symbol, action, ok=False,
                             error="blocked by kill switch (disarmed)", url=rule["webhook_url"],
                             rule_name=rule["name"], price=sig.price,
                             account=str(rule.get("account") or "demo"), blocked=True)
        return

    for rule in enabled:
        if rule.get("broker") == "tradestation" and not rule.get("payload_template"):
            log.warning(
                "live_alert [%s]: rule targets a TradeStation/futures symbol (%s) "
                "but has no payload_template — the default Binance payload shape "
                "will likely be rejected by your ES broker endpoint. "
                "Add a payload_template in the Live Alerts config.",
                rule["name"], symbol,
            )
        payload = build_payload(rule, action, symbol)
        threading.Thread(
            target=_post,
            args=(rule["webhook_url"], payload),
            kwargs={"strategy_id": strategy_id, "symbol": symbol,
                    "action": action, "rule_name": rule["name"],
                    "price": sig.price, "account": str(rule.get("account") or "demo")},
            daemon=True,
        ).start()


def dispatch_for_rule(rule: dict, symbol: str, sig: Signal) -> None:
    """Fire for one specific rule only. Used by _HeadlessRunner (per-rule runners)."""
    action = action_for(sig)
    if action is None:
        log.warning("live_alert skipped: no action mapping for side=%s kind=%s (rule=%s)",
                    sig.side, sig.kind, rule.get("name"))
        return
    if not rule.get("enabled"):
        return
    if _kill_switch_engaged():
        log.warning("live_alert BLOCKED by kill switch [%s] %s %s", rule["name"], rule["strategy_id"], action)
        _emit_dispatched(rule["strategy_id"], symbol, action, ok=False,
                         error="blocked by kill switch (disarmed)", url=rule["webhook_url"],
                         rule_name=rule["name"], price=sig.price,
                         account=str(rule.get("account") or "demo"), blocked=True)
        return
    if rule.get("broker") == "tradestation" and not rule.get("payload_template"):
        log.warning(
            "live_alert [%s]: rule targets a TradeStation/futures symbol (%s) "
            "but has no payload_template — the default Binance payload shape "
            "will likely be rejected by your ES broker endpoint.",
            rule["name"], symbol,
        )
    payload = build_payload(rule, action, symbol)
    threading.Thread(
        target=_post,
        args=(rule["webhook_url"], payload),
        kwargs={"strategy_id": rule["strategy_id"], "symbol": symbol,
                "action": action, "rule_name": rule["name"],
                "price": sig.price, "account": str(rule.get("account") or "demo")},
        daemon=True,
    ).start()


_VALID_ACTIONS = frozenset(_ACTION_MAP.values())


def test_dispatch(rule_name: str, action: str = "BUY", dry_run: bool = False) -> dict:
    """Synthetic fire for connectivity testing a specific named rule.

    dry_run=True builds + logs the payload and emits the events (so the
    terminal's chart/alerts light up end-to-end) but never POSTs — the safe
    default for the terminal's Test Signal button."""
    if action not in _VALID_ACTIONS:
        return {"ok": False, "error": f"unknown action '{action}'"}
    rule = live_alerts_config.find_rule_by_name(rule_name)
    if not rule:
        return {"ok": False, "error": f"no rule named '{rule_name}'"}
    if not rule.get("enabled"):
        return {"ok": False, "error": "rule is disabled"}

    payload = build_payload(rule, action, rule["symbol"])
    preview = dict(payload)
    preview["secret"] = _redact(preview.get("secret", ""))

    if dry_run:
        _emit_dispatched(rule["strategy_id"], rule["symbol"], action, ok=True,
                         url=rule["webhook_url"], rule_name=rule["name"],
                         account=str(rule.get("account") or "demo"),
                         test=True, dry_run=True)
        return {"ok": True, "dry_run": True, "url": rule["webhook_url"], "payload": preview}

    if _kill_switch_engaged():
        _emit_dispatched(rule["strategy_id"], rule["symbol"], action, ok=False,
                         error="blocked by kill switch (disarmed)", url=rule["webhook_url"],
                         rule_name=rule["name"], account=str(rule.get("account") or "demo"),
                         test=True, blocked=True)
        return {"ok": False, "error": "kill switch engaged — re-arm to send webhooks"}

    threading.Thread(
        target=_post,
        args=(rule["webhook_url"], payload),
        kwargs={"strategy_id": rule["strategy_id"], "symbol": rule["symbol"],
                "action": action, "rule_name": rule["name"],
                "account": str(rule.get("account") or "demo"), "test": True},
        daemon=True,
    ).start()

    return {"ok": True, "url": rule["webhook_url"], "payload": preview}
