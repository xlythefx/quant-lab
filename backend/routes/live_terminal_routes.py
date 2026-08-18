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

from services import market_data, event_bus, live_alerts_config, live_alerter, alerts_daemon, assets
from services.live import live_engine, live_store
from utils.validators import validate_symbol, validate_timeframe, validate_limit, ValidationError

log = logging.getLogger(__name__)
live_bp = Blueprint("live_terminal", __name__, url_prefix="/api/live")

# Live Terminal instruments = the crypto spot pairs catalogued for Binance
# (backend/data/assets/binance.json). Add a pair there and it shows up in the
# chart's symbol switcher automatically after a backend restart — no code change
# here. The candle/ticker endpoints + socket kline stream already work for any
# valid Binance pair, so the catalog is the one place that curates the list.
def _price_decimals(tick_size: float) -> int:
    """0.01 -> 2, 0.0001 -> 4. Defaults to 2 when uncatalogued (tick 0)."""
    if not tick_size or tick_size >= 1:
        return 2
    return len(f"{tick_size:.10f}".rstrip("0").split(".")[1])


def _build_instruments() -> list[dict]:
    out = []
    for sym, meta in sorted(assets.for_broker("binance").items()):
        if meta.asset_class != "crypto":
            continue
        label = f"{meta.base} / {meta.quote}" if meta.base and meta.quote else sym
        out.append({
            "symbol": sym, "venue": "BINANCE", "cls": "crypto",
            "label": label, "priceDecimals": _price_decimals(meta.tick_size),
        })
    # Never hand back an empty list — the terminal must always have a chart.
    return out or [{"symbol": "BTCUSDT", "venue": "BINANCE", "cls": "crypto",
                    "label": "BTC / USDT", "priceDecimals": 2}]


INSTRUMENTS = _build_instruments()
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
    # One masking convention across the app (see live_alerts_config.mask_secret).
    return live_alerts_config.mask_secret(secret or "")


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
    # Increments (pyramiding > 1) are ALLOWED. The strategy self-limits to its schema
    # max and emits one entry per trigger; QuantLab throws one webhook each and the
    # Flask receiver sizes/counts/caps execution. Default stays 1 via the schema, and
    # only strategies whose live on_candle emits multiple entries actually stack
    # (e.g. vwap_deviation). Validate on 156 (staging) before any 167 deployment.

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
        # Optional: reuse another rule's real secret without exposing it to the
        # browser. save_rules() resolves this by name, then drops the field.
        "secret_source": str(body.get("secret_source") or "").strip(),
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
    # Symbol may change in place (kept upper-case like create).
    if body.get("symbol"):
        rule["symbol"] = str(body["symbol"]).strip().upper()
    # pyramiding > 1 allowed here too (see deployments_create) — no forcing.

    # Rename: `name` is the deployment's identity (key in the rules file + how the
    # daemon tracks it). A rename is an in-place field change here — the daemon
    # refresh swaps the runner. Runtime/journal history keyed by the OLD name is
    # left as-is (self-use tradeoff), so we log the rename explicitly.
    new_name = str(body.get("name") or "").strip()
    renamed = bool(new_name and new_name != name)
    if renamed:
        if any(r["name"] == new_name for j, r in enumerate(rules) if j != idx):
            return jsonify({"error": f"a deployment named '{new_name}' already exists"}), 400
        rule["name"] = new_name

    rules[idx] = rule
    live_alerts_config.save_rules(rules)
    alerts_daemon.refresh()
    if renamed:
        live_store.add_activity("info", rule_name=new_name,
                                detail=f"renamed from '{name}'", symbol=rule.get("symbol", ""))
    elif "status" in body:
        kind = "armed" if rule["enabled"] else "paused"
        live_store.add_activity(kind, rule_name=rule["name"], symbol=rule.get("symbol", ""))
    else:
        live_store.add_activity("info", rule_name=rule["name"], detail="deployment updated")
    event_bus.emit("deployments_changed", {"name": rule["name"], "op": "patched"})
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


_PREVIEW_ACTIONS = ("BUY", "SELL", "EXIT_LONG", "EXIT_SHORT")
_PREVIEW_SECRET = "••••••"   # placeholder so the secret's SHAPE shows, never a real token


@live_bp.post("/payload-preview")
def payload_preview():
    """The EXACT JSON body this deployment will POST, for cross-checking before
    arming. Runs the real live_alerter.build_payload() (default shape OR a custom
    payload_template) so the preview can't drift from what actually fires. The
    secret is a masked placeholder — the real token is never involved here."""
    body = request.get_json(silent=True) or {}
    fake_rule = {
        "name": str(body.get("name") or "preview"),
        "secret": _PREVIEW_SECRET,
        "strategy_alias": str(body.get("strategy_alias") or "").strip(),
        "leverage": body.get("leverage", 1),
        "payload_template": body.get("payload_template") or None,
    }
    symbol = str(body.get("symbol") or "BTCUSDT").strip().upper()
    payloads = {a: live_alerter.build_payload(fake_rule, a, symbol) for a in _PREVIEW_ACTIONS}
    return jsonify({"symbol": symbol, "secret_masked": _PREVIEW_SECRET, "payloads": payloads})


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


# ===========================================================================
# Phase 07 — live trade journal + analytics (backtest math over live trades)
# ===========================================================================

@live_bp.get("/journal")
def journal():
    period = (request.args.get("period") or "ALL").upper()
    span = {"7D": 7 * 86400, "30D": 30 * 86400}.get(period)
    since = int(time.time()) - span if span else None
    rows = live_store.get_journal(
        since_ts=since,
        strategy_id=request.args.get("strategy_id") or None,
        symbol=request.args.get("symbol") or None,
        account=request.args.get("account") or None,
    )
    rows.reverse()  # newest first for the table
    return jsonify({"rows": rows})


@live_bp.get("/analytics")
def analytics():
    from services.live import live_analytics
    try:
        return jsonify(live_analytics.compute(
            period=request.args.get("period") or "ALL",
            group=request.args.get("group") or "strategy",
            filter_key=request.args.get("filter_key") or None,
            filter_value=request.args.get("filter_value") or None,
            account=request.args.get("account") or None,
        ))
    except Exception as e:
        log.exception("live analytics failed")
        return jsonify({"error": str(e)}), 500


# ===========================================================================
# Phase 09 — REAL positions / risk / reconciliation (read-only from the
# sinegu-api WAMP MySQL). {ok:false} on any WAMP trouble → the UI falls back
# to the labeled SIMULATED placeholder instead of hard-breaking.
# ===========================================================================

def _account_arg() -> str:
    return "live" if (request.args.get("account") or "demo").lower() == "live" else "demo"


@live_bp.get("/master-account")
def live_master_account():
    """Headline equity: the master Binance account (name='master') read from the
    LOCAL sinegu_db QuantLab is deployed on. Read-only; {ok:false} when WAMP is
    down so the top bar can hide the number rather than show a fake one."""
    from services.live import wamp_positions
    try:
        out = wamp_positions.get_master_account()
        out["ok"] = True
        out["source"] = "sinegu-api"
        return jsonify(out)
    except wamp_positions.WampUnavailable as e:
        return jsonify({"ok": False, "error": f"WAMP unreachable: {e}"})


@live_bp.get("/positions")
def live_positions():
    from services.live import wamp_positions
    try:
        return jsonify({"ok": True, "source": "sinegu-api",
                        "rows": wamp_positions.get_open_positions(_account_arg())})
    except wamp_positions.WampUnavailable as e:
        return jsonify({"ok": False, "error": f"WAMP unreachable: {e}", "rows": []})


@live_bp.get("/positions/closed")
def live_positions_closed():
    from services.live import wamp_positions
    try:
        limit = validate_limit(request.args.get("limit"), default=100, maximum=1000)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    try:
        return jsonify({"ok": True, "source": "sinegu-api",
                        "rows": wamp_positions.get_closed_positions(_account_arg(), limit)})
    except wamp_positions.WampUnavailable as e:
        return jsonify({"ok": False, "error": f"WAMP unreachable: {e}", "rows": []})


@live_bp.get("/risk")
def live_risk():
    from services.live import wamp_positions
    try:
        out = wamp_positions.get_risk(_account_arg())
        out["ok"] = True
        out["source"] = "sinegu-api"
        return jsonify(out)
    except wamp_positions.WampUnavailable as e:
        return jsonify({"ok": False, "error": f"WAMP unreachable: {e}"})


@live_bp.get("/reconciliation")
def live_reconciliation():
    from services.live import wamp_positions
    alerts = [a for a in live_store.get_alerts_history(200) if not a.get("test")]
    try:
        return jsonify({"ok": True, **wamp_positions.reconcile(alerts, _account_arg())})
    except wamp_positions.WampUnavailable as e:
        return jsonify({"ok": False, "error": f"WAMP unreachable: {e}",
                        "alerts": [{**a, "recon": "wamp_down"} for a in alerts],
                        "positions_without_signal": [], "counts": {}})


@live_bp.get("/deployments/<path:name>/expectation")
def deployment_expectation(name):
    """Live vs expectation: run the SAME strategy+params through the backtest
    engine over the cached parquet and return the headline stats to compare
    against the deployment's live journal."""
    rule = live_alerts_config.find_rule_by_name(name)
    if not rule:
        return jsonify({"error": f"no deployment named '{name}'"}), 404
    try:
        from services import backtest_engine
        res = backtest_engine.run(
            rule["strategy_id"], rule["symbol"], rule.get("timeframe") or "1h",
            params=rule.get("params") or {}, stats_only=True,
        )
        s = res.get("stats") or {}
        return jsonify({"ok": True, "expected": {
            "win_rate": s.get("win_rate"),
            "profit_factor": s.get("profit_factor"),
            "avg_pnl_pct": s.get("avg_pnl_pct"),
            "max_drawdown_pct_peak": s.get("max_drawdown_pct_peak"),
            "trades": s.get("trades"),
            "sharpe": s.get("sharpe"),
            "first_time": s.get("first_time"),
            "last_time": s.get("last_time"),
        }})
    except FileNotFoundError:
        return jsonify({"ok": False, "error": f"no cached dataset for {rule['symbol']} {rule.get('timeframe')} — download it on the Downloads page first"}), 404
    except Exception as e:
        log.exception("expectation backtest failed")
        return jsonify({"ok": False, "error": str(e)}), 500
