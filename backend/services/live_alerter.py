"""
Fires TradingView-style webhook alerts when a live strategy emits a signal.

ONE SENDER: only the headless alerts_daemon calls dispatch_for_rule() (one
rule per runner, behind the idempotency guard). The old browser LiveRunner
no longer sends anything. test_dispatch() is the user-initiated test button.

Each POST carries the JSON payload the Binance acceptor expects:
  {
    "secret":   "<token>",
    "strategy": "<alias>",
    "leverage": "<int as string>",
    "action":   "BUY | SELL | EXIT_LONG | EXIT_SHORT",
    "symbol":   "BTCUSDT",
    "sent_at":  "2026-10-26T14:15:02.812Z"
  }

`sent_at` is when QuantLab decided the signal (UTC, milliseconds). It is stamped
once when the payload is built, so retries resend the same value and a retried
signal measures as slow rather than looking fresh. The receiver uses it to time
the gap between signal and fill, so this box's clock must stay NTP-synced.

Every attempt (ok/fail) emits a `live_alert_dispatched` Socket.IO event.
"""
from __future__ import annotations

import json
import logging
import threading
import time
from datetime import datetime, timezone
from typing import Optional

import httpx

from services import event_bus, live_alerts_config
from services.strategies.base import Signal

log = logging.getLogger(__name__)

_TIMEOUT_SECONDS = 10.0
_MAX_ATTEMPTS = 3
# Retry ONLY when the order provably never reached the receiver. 502/503 mean a
# proxy in front of it answered "upstream unavailable". Everything else —
# read timeouts, 504, any other status — may already have placed the order, so
# a retry could double it.
_RETRY_STATUSES = (502, 503)
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


def sent_at_now() -> str:
    """UTC now as ISO-8601 with milliseconds, e.g. 2026-10-26T14:15:02.812Z."""
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _default_payload(rule: dict, action: str, symbol: str, sent_at: str) -> dict:
    return {
        "secret":   rule["secret"],
        "strategy": rule["strategy_alias"],
        "leverage": str(rule["leverage"]),
        "action":   action,
        "symbol":   symbol,
        "sent_at":  sent_at,
    }


def build_payload(rule: dict, action: str, symbol: str, sent_at: Optional[str] = None) -> dict:
    sent_at = sent_at or sent_at_now()
    template = rule.get("payload_template")
    if not template:
        return _default_payload(rule, action, symbol, sent_at)
    tokens = {
        "action":   action,
        "symbol":   symbol,
        "secret":   rule["secret"],
        "strategy": rule["strategy_alias"],
        "leverage": str(rule["leverage"]),
        "sent_at":  sent_at,
    }
    rendered = template
    for key, val in tokens.items():
        rendered = rendered.replace("{{" + key + "}}", val)
    try:
        return json.loads(rendered)
    except (json.JSONDecodeError, ValueError):
        log.warning("payload_template for rule %r failed to render — falling back to default", rule.get("name"))
        return _default_payload(rule, action, symbol, sent_at)


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


def _never_reached_server(exc: Exception) -> bool:
    """True only when the connection itself was never established (DNS failure,
    connection refused, connect timeout) — so the receiver cannot have acted."""
    return isinstance(exc, (httpx.ConnectError, httpx.ConnectTimeout))


def _post(url: str, payload: dict, *, strategy_id: str, symbol: str,
          action: str, rule_name: str, price: Optional[float] = None,
          account: str = "demo", test: bool = False):
    last_err: str | None = None
    status: Optional[int] = None
    for attempt in range(1, _MAX_ATTEMPTS + 1):
        retry = False
        try:
            r = httpx.post(url, json=payload, timeout=_TIMEOUT_SECONDS)
            status = r.status_code
            if 200 <= r.status_code < 300:
                log.info("live_alert [%s] %s %s → %s attempt %d OK (status=%d secret=%s)",
                         rule_name, strategy_id, action, url, attempt, r.status_code,
                         _redact(payload.get("secret", "")))
                _emit_dispatched(strategy_id, symbol, action, ok=True,
                                 status_code=r.status_code, url=url, rule_name=rule_name,
                                 price=price, account=account, test=test)
                return
            last_err = f"HTTP {r.status_code}: {r.text[:2000]}" if r.text else f"HTTP {r.status_code}"
            retry = r.status_code in _RETRY_STATUSES
        except Exception as e:
            last_err = f"{type(e).__name__}: {e}"
            retry = _never_reached_server(e)
        will_retry = retry and attempt < _MAX_ATTEMPTS
        if will_retry:
            why = "retrying — the request never reached the receiver"
        elif retry:
            why = "giving up"
        else:
            why = "NOT retrying — the receiver may already have acted on it"
        log.warning("live_alert [%s] %s %s attempt %d failed: %s — %s",
                    rule_name, strategy_id, action, attempt, last_err, why)
        if not will_retry:
            break
        time.sleep(attempt)   # 1s, then 2s

    log.warning("live_alert FAIL [%s] %s %s → %s: %s",
                rule_name, strategy_id, action, url, last_err)
    _emit_dispatched(strategy_id, symbol, action, ok=False, status_code=status,
                     error=last_err, url=url, rule_name=rule_name,
                     price=price, account=account, test=test)


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


def test_dispatch(rule_name: str, action: str = "BUY", dry_run: bool = True) -> dict:
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
