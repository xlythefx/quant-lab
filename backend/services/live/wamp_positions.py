"""
READ-ONLY reader for the sinegu-api WAMP MySQL (real broker positions).

Tables (auto-filled from the brokers by the SaaS):
    binance_positions / binance_pastpositions  + binance_accounts (demo flag)
    ig_positions      / ig_past_positions      + ig_accounts      (demo flag)

This module NEVER writes. It is only for the terminal's Positions / Risk /
Reconciliation panels; alert storage stays inside QuantLab (plan 06).
Every public function raises WampUnavailable on connection trouble — the
routes turn that into {ok: false} and the UI falls back to the labeled
SIMULATED placeholder, so the terminal never hard-breaks when WAMP is down.

Config via backend/.env (python-dotenv):
    WAMP_DB_HOST (localhost) · WAMP_DB_USER (root) · WAMP_DB_PASS ('') ·
    WAMP_DB_NAME (sinegu_db)
"""
from __future__ import annotations

import logging
import os
from datetime import datetime, timezone

from dotenv import load_dotenv

log = logging.getLogger(__name__)

_ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), ".env")
load_dotenv(_ENV_PATH)

_CFG = {
    "host": os.environ.get("WAMP_DB_HOST", "localhost"),
    "user": os.environ.get("WAMP_DB_USER", "root"),
    "password": os.environ.get("WAMP_DB_PASS", ""),
    "database": os.environ.get("WAMP_DB_NAME", "sinegu_db"),
}


class WampUnavailable(Exception):
    pass


def _connect():
    try:
        import mysql.connector
        return mysql.connector.connect(connection_timeout=3, **_CFG)
    except Exception as e:
        raise WampUnavailable(str(e))


def _query(sql: str, args: tuple = ()) -> list[dict]:
    conn = _connect()
    try:
        cur = conn.cursor(dictionary=True)
        cur.execute(sql, args)
        return cur.fetchall()
    except Exception as e:
        raise WampUnavailable(str(e))
    finally:
        try:
            conn.close()
        except Exception:
            pass


def _f(v) -> float:
    try:
        return float(v or 0.0)
    except (TypeError, ValueError):
        return 0.0


def _demo_flag(account: str) -> int:
    return 1 if str(account or "demo").lower() == "demo" else 0


# ---- open positions -----------------------------------------------------------

def get_open_positions(account: str = "demo") -> list[dict]:
    demo = _demo_flag(account)
    rows: list[dict] = []

    for r in _query(
        """SELECT p.symbol, p.position_side, p.position_amt, p.entry_price,
                  p.mark_price, p.unrealized_profit, p.notional,
                  p.initial_margin, p.maint_margin, a.name AS account_name
           FROM binance_positions p
           JOIN binance_accounts a ON a.api_key = p.api_key
           WHERE a.demo = %s AND a.deleted_at IS NULL""", (demo,)):
        amt = _f(r["position_amt"])
        side = r["position_side"] if r["position_side"] in ("LONG", "SHORT") else ("LONG" if amt >= 0 else "SHORT")
        mark = _f(r["mark_price"])
        rows.append({
            "broker": "binance",
            "account_name": r["account_name"],
            "symbol": r["symbol"],
            "side": side,
            "size": abs(amt),
            "entry": _f(r["entry_price"]),
            "mark": mark,
            "upnl": _f(r["unrealized_profit"]),
            "notional": abs(_f(r["notional"])) or abs(amt) * mark,
            "margin": _f(r["initial_margin"]),
            "maint_margin": _f(r["maint_margin"]),
        })

    for r in _query(
        """SELECT p.ticker, p.direction, p.size, p.level, p.unrealized_pnl,
                  p.strategy, a.name AS account_name
           FROM ig_positions p
           JOIN ig_accounts a ON a.api_key = p.api_key
           WHERE a.demo = %s AND a.deleted_at IS NULL""", (demo,)):
        size = _f(r["size"])
        entry = _f(r["level"])
        upnl = _f(r["unrealized_pnl"])
        notional = abs(size) * entry
        rows.append({
            "broker": "ig",
            "account_name": r["account_name"],
            "symbol": r["ticker"],
            "side": "LONG" if r["direction"] == "BUY" else "SHORT",
            "size": abs(size),
            "entry": entry,
            # IG rows carry no mark price — derive it from uPnL so the panel
            # still shows a sensible number (labeled broker-derived).
            "mark": entry + (upnl / size if size else 0.0) * (1 if r["direction"] == "BUY" else -1),
            "upnl": upnl,
            "notional": notional,
            "margin": 0.0,
            "maint_margin": 0.0,
            "strategy": r["strategy"],
        })

    return rows


# ---- closed positions -----------------------------------------------------------

def get_closed_positions(account: str = "demo", limit: int = 100) -> list[dict]:
    demo = _demo_flag(account)
    rows: list[dict] = []

    for r in _query(
        """SELECT p.symbol, p.position_side, p.position_amt, p.entry_price,
                  p.exit_price, p.realized_pnl, p.side, p.closed_at, p.strategy,
                  a.name AS account_name
           FROM binance_pastpositions p
           JOIN binance_accounts a ON a.api_key = p.api_key
           WHERE a.demo = %s AND a.deleted_at IS NULL
           ORDER BY p.closed_at DESC LIMIT %s""", (demo, int(limit))):
        rows.append({
            "broker": "binance",
            "account_name": r["account_name"],
            "symbol": r["symbol"],
            "side": r["position_side"],
            "size": abs(_f(r["position_amt"])),
            "entry": _f(r["entry_price"]),
            "exit": _f(r["exit_price"]),
            "realized_pnl": _f(r["realized_pnl"]),
            "strategy": r.get("strategy"),
            "closed_at": int(r["closed_at"].replace(tzinfo=timezone.utc).timestamp()) if r["closed_at"] else None,
        })

    for r in _query(
        """SELECT p.ticker, p.side, p.size, p.open_price, p.close_price, p.pnl,
                  p.strategy, p.closed_at, a.name AS account_name
           FROM ig_past_positions p
           JOIN ig_accounts a ON a.api_key = p.api_key
           WHERE a.demo = %s AND a.deleted_at IS NULL
           ORDER BY p.closed_at DESC LIMIT %s""", (demo, int(limit))):
        rows.append({
            "broker": "ig",
            "account_name": r["account_name"],
            "symbol": r["ticker"],
            "side": "LONG" if r["side"] == "BUY" else "SHORT",
            "size": abs(_f(r["size"])),
            "entry": _f(r["open_price"]),
            "exit": _f(r["close_price"]),
            "realized_pnl": _f(r["pnl"]),
            "strategy": r.get("strategy"),
            "closed_at": int(r["closed_at"].replace(tzinfo=timezone.utc).timestamp()) if r["closed_at"] else None,
        })

    rows.sort(key=lambda x: x["closed_at"] or 0, reverse=True)
    return rows[:limit]


# ---- risk aggregates -----------------------------------------------------------

def get_risk(account: str = "demo") -> dict:
    demo = _demo_flag(account)
    positions = get_open_positions(account)

    bal = _query(
        "SELECT COALESCE(SUM(balance),0) b, COALESCE(SUM(unrealized_pnl),0) u "
        "FROM binance_accounts WHERE demo=%s AND deleted_at IS NULL", (demo,))[0]
    ig_bal = _query(
        "SELECT COALESCE(SUM(balance),0) b, COALESCE(SUM(unrealized_pnl),0) u "
        "FROM ig_accounts WHERE demo=%s AND deleted_at IS NULL", (demo,))[0]

    upnl_positions = sum(p["upnl"] for p in positions)
    equity = _f(bal["b"]) + _f(ig_bal["b"]) + upnl_positions

    # Day P&L: broker-realized today (UTC) + current unrealized.
    midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    mstr = midnight.strftime("%Y-%m-%d %H:%M:%S")
    day_binance = _query(
        """SELECT COALESCE(SUM(p.realized_pnl),0) s FROM binance_pastpositions p
           JOIN binance_accounts a ON a.api_key = p.api_key
           WHERE a.demo=%s AND a.deleted_at IS NULL AND p.closed_at >= %s""", (demo, mstr))[0]["s"]
    day_ig = _query(
        """SELECT COALESCE(SUM(p.pnl),0) s FROM ig_past_positions p
           JOIN ig_accounts a ON a.api_key = p.api_key
           WHERE a.demo=%s AND a.deleted_at IS NULL AND p.closed_at >= %s""", (demo, mstr))[0]["s"]
    day_pnl = _f(day_binance) + _f(day_ig) + upnl_positions

    gross = sum(abs(p["notional"]) for p in positions)
    net = sum(p["notional"] * (1 if p["side"] == "LONG" else -1) for p in positions)
    margin_used = sum(p["margin"] for p in positions)
    maint = sum(p["maint_margin"] for p in positions)

    exposures = [{"symbol": p["symbol"], "side": p["side"], "notional": p["notional"]} for p in positions]
    position_risk = []
    for p in positions:
        lev = (p["notional"] / p["margin"]) if p["margin"] > 0 else None
        liq = None
        dist = None
        if lev and p["entry"]:
            liq = p["entry"] * (1 - 1 / lev) if p["side"] == "LONG" else p["entry"] * (1 + 1 / lev)
            dist = abs(1 / lev) * 100.0
        position_risk.append({
            "symbol": p["symbol"], "lev": lev, "notional": p["notional"],
            "liqPrice": liq, "distPct": dist, "uPnl": p["upnl"],
        })

    return {
        "cards": {
            "equity": equity,
            "dayPnl": day_pnl,
            "gross": gross,
            "netDelta": net,
            "marginUsed": margin_used,
            "freeMargin": equity - margin_used,
            # No real VaR from the broker — a flat 2%-vol 95% estimate on gross,
            # marked derived in the UI.
            "var1d": gross * 0.02 * 1.65,
            "maintMargin": maint,
            "leverage": (gross / equity) if equity > 0 else 0.0,
            "utilPct": (margin_used / equity * 100.0) if equity > 0 else 0.0,
        },
        "exposures": exposures,
        "positionRisk": position_risk,
    }


# ---- master account (headline equity) -----------------------------------------

def get_master_account() -> dict:
    """The master Binance account (name='master') from the LOCAL sinegu_db —
    whatever environment QuantLab is deployed on. Read-only, a SINGLE account
    (not the demo/live sum in get_risk).
      equity = balance + unrealized_pnl
      dayPnl = today's (UTC) realized for this account + current unrealized
    """
    rows = _query(
        "SELECT api_key, balance, unrealized_pnl, initial_deposit, currency_type "
        "FROM binance_accounts WHERE name='master' AND deleted_at IS NULL LIMIT 1")
    if not rows:
        raise WampUnavailable("no master Binance account (name='master')")
    a = rows[0]
    balance = _f(a["balance"])
    upnl = _f(a["unrealized_pnl"])
    midnight = datetime.now(timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
    mstr = midnight.strftime("%Y-%m-%d %H:%M:%S")
    day = _query(
        "SELECT COALESCE(SUM(realized_pnl),0) s FROM binance_pastpositions "
        "WHERE api_key=%s AND closed_at >= %s", (a["api_key"], mstr))[0]["s"]
    return {
        "name": "master",
        "equity": balance + upnl,
        "dayPnl": _f(day) + upnl,
        "balance": balance,
        "unrealizedPnl": upnl,
        "initialDeposit": _f(a["initial_deposit"]),
        "currency": a.get("currency_type") or "USDT",
    }


# ---- reconciliation -----------------------------------------------------------

_ENTRY_ACTIONS = ("BUY", "SELL")
_EXIT_ACTIONS = ("EXIT_LONG", "EXIT_SHORT")
_MATCH_WINDOW_S = 45 * 60


def reconcile(alert_rows: list[dict], account: str = "demo") -> dict:
    """Match fired alerts against real WAMP positions.

    Returns per-alert status:
      matched            — a real position event lines up with the alert
      fired_no_position  — the alert fired but no position showed up (FLAG)
      pending            — too recent / open leg, judged later
    plus positions_without_signal — open positions no alert accounts for.
    """
    open_pos = get_open_positions(account)
    closed = get_closed_positions(account, limit=300)

    results = []
    for a in alert_rows:
        if a.get("dry_run"):
            status = "dry_run"
        else:
            sym = (a.get("symbol") or "").upper()
            t = int(a.get("ts") or 0)
            action = a.get("action") or ""
            side = "LONG" if action in ("BUY", "EXIT_LONG") else "SHORT"
            status = "fired_no_position"
            if action in _ENTRY_ACTIONS:
                if any(p["symbol"].upper() == sym and p["side"] == side for p in open_pos):
                    status = "matched"
                elif any(c["symbol"].upper() == sym and (c["closed_at"] or 0) >= t for c in closed):
                    status = "matched"  # opened after the alert and already closed
                elif not a.get("ok"):
                    status = "webhook_failed"
            elif action in _EXIT_ACTIONS:
                if any(c["symbol"].upper() == sym and abs((c["closed_at"] or 0) - t) <= _MATCH_WINDOW_S for c in closed):
                    status = "matched"
                elif any(p["symbol"].upper() == sym for p in open_pos):
                    status = "fired_no_position"  # still open at the broker — exit didn't land!
                elif not a.get("ok"):
                    status = "webhook_failed"
            else:
                status = "unknown_action"
        results.append({**a, "recon": status})

    alerted_symbols = {(a.get("symbol") or "").upper() for a in alert_rows if not a.get("dry_run")}
    orphans = [p for p in open_pos if p["symbol"].upper() not in alerted_symbols]

    return {
        "alerts": results,
        "positions_without_signal": orphans,
        "counts": {
            "matched": sum(1 for r in results if r["recon"] == "matched"),
            "flagged": sum(1 for r in results if r["recon"] in ("fired_no_position", "webhook_failed")),
            "orphans": len(orphans),
        },
    }
