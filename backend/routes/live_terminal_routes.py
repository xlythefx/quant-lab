"""
Live Terminal REST endpoints (/api/live/*).

Snapshot endpoints for initial paint; live updates ride the existing
Socket.IO rooms (candle stream) + global events (gateway, live_signal,
live_alert_dispatched). This blueprint grows with the phases:
  03: instruments / candles / ticker / markets
  05: deployments (a view over the live-alert rules + daemon) + test signal
  06: kill switch / alerts history / activity log
"""
from __future__ import annotations

import logging
import time
from threading import Lock

from flask import Blueprint, jsonify, request

from services import market_data, event_bus, live_alerts_config, live_alerter, alerts_daemon
from services.live import live_engine, live_store
from utils.validators import validate_symbol, validate_timeframe, validate_limit, ValidationError

log = logging.getLogger(__name__)
live_bp = Blueprint("live_terminal", __name__, url_prefix="/api/live")

# First instruments (per plan 01): BTCUSDT + LTCUSDT on Binance spot.
INSTRUMENTS = [
    {"symbol": "BTCUSDT", "venue": "BINANCE", "cls": "crypto", "label": "Bitcoin / USDT",  "priceDecimals": 2},
    {"symbol": "LTCUSDT", "venue": "BINANCE", "cls": "crypto", "label": "Litecoin / USDT", "priceDecimals": 2},
]
_INSTRUMENT_SYMBOLS = {i["symbol"] for i in INSTRUMENTS}

# Timeframes offered by the terminal's chart (subset of config.TIMEFRAMES).
LIVE_TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"]


@live_bp.get("/instruments")
def instruments():
    return jsonify({"instruments": INSTRUMENTS, "timeframes": LIVE_TIMEFRAMES})


@live_bp.get("/candles")
def candles():
    try:
        symbol = validate_symbol(request.args.get("symbol"))
        tf = validate_timeframe(request.args.get("timeframe"))
        limit = validate_limit(request.args.get("limit"), default=300, maximum=1000)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    try:
        data = market_data.fetch_ohlcv(symbol, tf, limit)
    except Exception as e:
        log.exception("live candles failed")
        return jsonify({"error": str(e)}), 502
    return jsonify({"symbol": symbol, "timeframe": tf, "candles": data})


@live_bp.get("/ticker")
def ticker():
    try:
        symbol = validate_symbol(request.args.get("symbol"))
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    try:
        return jsonify(market_data.fetch_ticker(symbol))
    except Exception as e:
        log.exception("live ticker failed")
        return jsonify({"error": str(e)}), 502


# ---- Markets table (cached ~10s so the UI can poll politely) --------------
_markets_cache: dict = {"ts": 0.0, "rows": None}
_markets_lock = Lock()


def _build_markets_rows() -> list[dict]:
    rows = []
    for inst in INSTRUMENTS:
        sym = inst["symbol"]
        row = {"symbol": sym, "venue": inst["venue"], "last": None, "chg24h": None,
               "volume": None, "funding": None, "spark": []}
        try:
            t = market_data.fetch_ticker(sym)
            row.update({"last": t["price"], "chg24h": t["changePct"], "volume": t["quoteVol"]})
        except Exception:
            log.warning("markets: ticker failed for %s", sym)
        try:
            candles_1h = market_data.fetch_ohlcv(sym, "1h", 30)
            row["spark"] = [c["close"] for c in candles_1h]
        except Exception:
            log.warning("markets: spark failed for %s", sym)
        rows.append(row)
    return rows


@live_bp.get("/markets")
def markets():
    with _markets_lock:
        if _markets_cache["rows"] is None or time.time() - _markets_cache["ts"] > 10.0:
            _markets_cache["rows"] = _build_markets_rows()
            _markets_cache["ts"] = time.time()
        return jsonify({"rows": _markets_cache["rows"]})


# ===========================================================================
# Phase 05 — Deployments: a VIEW over the live-alert rules + headless daemon.
# The old /api/live-alerts CRUD keeps working unchanged; these endpoints
# reshape the same rules into the terminal's Deployment model and add
# runtime state (last eval, P&L totals, open position, dispatch status).
# ===========================================================================

def _mask_url(url: str) -> str:
    if not url:
        return ""
    u = url.split("?")[0]
    return u if len(u) <= 64 else u[:61] + "…"


def _redact_secret(secret: str) -> str:
    if not secret:
        return ""
    return "***" if len(secret) <= 8 else f"{secret[:3]}…{secret[-2:]}"


def _deployment_view(rule: dict, rt: dict) -> dict:
    name = rule["name"]
    totals = rt["totals"].get(name, {})
    return {
        "name": name,
        "strategy_id": rule["strategy_id"],
        "strategy_alias": rule.get("strategy_alias") or rule["strategy_id"],
        "symbol": rule["symbol"],
        "timeframe": rule.get("timeframe") or "",
        "venue": "BINANCE" if (rule.get("broker") or "binance") == "binance" else "TRADESTATION",
        "account": rule.get("account") or "demo",
        "leverage": rule.get("leverage", 1),
        "params": rule.get("params") or {},
        "status": "RUNNING" if rule.get("enabled") else "PAUSED",
        "webhook_hint": _mask_url(rule.get("webhook_url") or ""),
        "secret_hint": _redact_secret(rule.get("secret") or ""),
        "pnl": totals.get("pnl_usd", 0.0),
        "n": totals.get("n", 0),
        "last_eval": rt["last_eval"].get(name),
        "last_dispatch": rt["last_dispatch"].get(name),
        "open_position": rt["open_positions"].get(name),
    }


@live_bp.get("/deployments")
def deployments_list():
    rules = live_alerts_config.load_rules()
    rt = live_engine.runtime_state()
    return jsonify({
        "deployments": [_deployment_view(r, rt) for r in rules],
        "killswitch": rt["killswitch"],
    })


_DEPLOY_REQUIRED = ("name", "strategy_id", "symbol", "timeframe", "webhook_url", "secret", "strategy_alias")


@live_bp.post("/deployments")
def deployments_create():
    body = request.get_json(silent=True) or {}
    missing = [k for k in _DEPLOY_REQUIRED if not str(body.get(k) or "").strip()]
    if missing:
        return jsonify({"error": f"missing required fields: {', '.join(missing)}"}), 400

    rules = live_alerts_config.load_rules()
    name = str(body["name"]).strip()
    if any(r["name"] == name for r in rules):
        return jsonify({"error": f"a deployment named '{name}' already exists"}), 400

    params = dict(body.get("params") or {})
    # Live parity with the backtest: single position only (memory: live-vs-backtest-parity).
    if "pyramiding" in params:
        params["pyramiding"] = 1

    rule = {
        "name": name,
        "strategy_id": str(body["strategy_id"]).strip(),
        "symbol": str(body["symbol"]).strip().upper(),
        "timeframe": str(body["timeframe"]).strip(),
        "enabled": bool(body.get("enabled", True)),
        "webhook_url": str(body["webhook_url"]).strip(),
        "secret": str(body["secret"]).strip(),
        "strategy_alias": str(body["strategy_alias"]).strip(),
        "leverage": body.get("leverage", 1),
        "payload_template": body.get("payload_template") or None,
        "params": params,
        "account": str(body.get("account") or "demo"),
    }
    saved = live_alerts_config.save_rules(rules + [rule])
    alerts_daemon.refresh()
    live_store.add_activity("deployed", rule_name=name, symbol=rule["symbol"],
                            detail=f"{rule['strategy_id']} {rule['timeframe']} account={rule['account']} "
                                   f"status={'RUNNING' if rule['enabled'] else 'PAUSED'}")
    event_bus.emit("deployments_changed", {"name": name, "op": "created"})
    rt = live_engine.runtime_state()
    created = next((r for r in saved if r["name"] == name), None)
    if created is None:
        return jsonify({"error": "rule failed validation (check webhook URL is http/https and all fields set)"}), 400
    return jsonify({"deployment": _deployment_view(created, rt)})


@live_bp.patch("/deployments/<path:name>")
def deployments_patch(name):
    body = request.get_json(silent=True) or {}
    rules = live_alerts_config.load_rules()
    idx = next((i for i, r in enumerate(rules) if r["name"] == name), None)
    if idx is None:
        return jsonify({"error": f"no deployment named '{name}'"}), 404

    rule = dict(rules[idx])
    if "status" in body:
        rule["enabled"] = str(body["status"]).upper() == "RUNNING"
    for k in ("params", "account", "leverage", "webhook_url", "secret",
              "strategy_alias", "timeframe", "payload_template", "enabled"):
        if k in body and body[k] is not None:
            rule[k] = body[k]
    if isinstance(rule.get("params"), dict) and "pyramiding" in rule["params"]:
        rule["params"]["pyramiding"] = 1

    rules[idx] = rule
    live_alerts_config.save_rules(rules)
    alerts_daemon.refresh()
    if "status" in body:
        kind = "armed" if rule["enabled"] else "paused"
        live_store.add_activity(kind, rule_name=name, symbol=rule.get("symbol", ""))
    else:
        live_store.add_activity("info", rule_name=name, detail="deployment updated")
    event_bus.emit("deployments_changed", {"name": name, "op": "patched"})
    rt = live_engine.runtime_state()
    return jsonify({"deployment": _deployment_view(rule, rt)})


@live_bp.delete("/deployments/<path:name>")
def deployments_delete(name):
    rules = live_alerts_config.load_rules()
    kept = [r for r in rules if r["name"] != name]
    if len(kept) == len(rules):
        return jsonify({"error": f"no deployment named '{name}'"}), 404
    live_alerts_config.save_rules(kept)
    alerts_daemon.refresh()
    live_store.add_activity("killed", rule_name=name)
    event_bus.emit("deployments_changed", {"name": name, "op": "deleted"})
    return jsonify({"ok": True})


@live_bp.post("/deployments/<path:name>/test-signal")
def deployments_test_signal(name):
    body = request.get_json(silent=True) or {}
    action = str(body.get("action") or "BUY").upper()
    dry_run = bool(body.get("dry_run", True))  # SAFE DEFAULT: dry-run
    rule = live_alerts_config.find_rule_by_name(name)
    if not rule:
        return jsonify({"error": f"no deployment named '{name}'"}), 404

    res = live_alerter.test_dispatch(name, action, dry_run=dry_run)
    if res.get("ok"):
        # Light up the chart + alerts end-to-end (daemon → strategy channel).
        event_bus.emit("live_signal", {
            "rule_name": name,
            "strategy_id": rule.get("strategy_id"),
            "symbol": rule.get("symbol"),
            "timeframe": rule.get("timeframe"),
            "action": action,
            "side": "long" if action in ("BUY", "EXIT_SHORT") else "short",
            "kind": "entry" if action in ("BUY", "SELL") else "exit",
            "price": None,
            "time": int(time.time()),
            "account": rule.get("account") or "demo",
            "test": True,
        })
    return jsonify(res)


# ===========================================================================
# Phase 06 — kill switch, alerts history, activity log
# ===========================================================================

@live_bp.get("/killswitch")
def killswitch_get():
    return jsonify({"killed": live_engine.kill_switch()})


@live_bp.post("/killswitch")
def killswitch_set():
    body = request.get_json(silent=True) or {}
    killed = live_engine.set_kill_switch(bool(body.get("killed")))
    return jsonify({"killed": killed})


@live_bp.get("/alerts-history")
def alerts_history():
    try:
        limit = validate_limit(request.args.get("limit"), default=200, maximum=2000)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"rows": live_store.get_alerts_history(limit)})


@live_bp.delete("/alerts-history")
def alerts_history_delete():
    body = request.get_json(silent=True) or {}
    ids = body.get("ids")
    if ids is not None and not isinstance(ids, list):
        return jsonify({"error": "ids must be a list or null"}), 400
    n = live_store.delete_alerts_history(ids)
    return jsonify({"ok": True, "deleted": n})


@live_bp.get("/activity")
def activity():
    try:
        limit = validate_limit(request.args.get("limit"), default=300, maximum=2000)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    return jsonify({"rows": live_store.get_activity(limit)})
