"""
Local SQLite storage for the Live Terminal (decided in plan 01/06):
    journal_trades — realized live round-trips (drives live Analytics, 07)
    alerts_history — every webhook dispatch attempt (deletable in the UI)
    activity_log   — the black box: armed/paused/killed/fired/sent/blocked
    settings       — k/v (kill switch, open-position state per rule)

One file: backend/data/live_terminal.db. WAL + a process-wide lock keeps it
safe across the daemon/webhook/request threads (single-user scale).
Alert RULES are not here — they stay in data/live_alerts.json as today.
"""
from __future__ import annotations

import json
import logging
import os
import sqlite3
import time
from threading import Lock

from config import DATA_DIR

log = logging.getLogger(__name__)

_PATH = os.path.join(DATA_DIR, "live_terminal.db")
_LOCK = Lock()
_conn: sqlite3.Connection | None = None

_SCHEMA = """
CREATE TABLE IF NOT EXISTS journal_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,             -- exit time (epoch s) = the trade's timestamp
    entry_time INTEGER,
    rule_name TEXT NOT NULL,
    strategy_id TEXT NOT NULL,
    strategy TEXT,                   -- display alias
    symbol TEXT NOT NULL,
    timeframe TEXT,
    account TEXT DEFAULT 'demo',
    venue TEXT DEFAULT 'BINANCE',
    side TEXT,                       -- LONG | SHORT
    entry REAL,
    exit REAL,
    pnl_pct REAL,                    -- price-move % (signed, after direction)
    pnl_usd REAL,                    -- ESTIMATED $ (see live_engine notional est)
    r REAL,                          -- R multiple when a stop is known, else NULL
    hold_min REAL
);
CREATE INDEX IF NOT EXISTS idx_journal_ts ON journal_trades(ts);

CREATE TABLE IF NOT EXISTS alerts_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    rule_name TEXT,
    strategy_id TEXT,
    symbol TEXT,
    action TEXT,
    price REAL,
    ok INTEGER,
    status_code INTEGER,
    error TEXT,
    url TEXT,
    test INTEGER DEFAULT 0,
    dry_run INTEGER DEFAULT 0,
    account TEXT DEFAULT 'demo'
);
CREATE INDEX IF NOT EXISTS idx_alerts_ts ON alerts_history(ts);

CREATE TABLE IF NOT EXISTS activity_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER NOT NULL,
    kind TEXT NOT NULL,              -- deployed|armed|paused|killed|signal|webhook_ok|webhook_fail|webhook_blocked|test_signal|killswitch|reconnect|info
    rule_name TEXT,
    symbol TEXT,
    action TEXT,
    ok INTEGER,
    detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_activity_ts ON activity_log(ts);

CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
);
"""


def _get_conn() -> sqlite3.Connection:
    global _conn
    if _conn is None:
        os.makedirs(DATA_DIR, exist_ok=True)
        _conn = sqlite3.connect(_PATH, check_same_thread=False)
        _conn.execute("PRAGMA journal_mode=WAL")
        _conn.executescript(_SCHEMA)
        _conn.commit()
    return _conn


def _rows(cur) -> list[dict]:
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]


# ---- settings k/v ----------------------------------------------------------

def get_setting(key: str, default=None):
    with _LOCK:
        cur = _get_conn().execute("SELECT value FROM settings WHERE key=?", (key,))
        row = cur.fetchone()
    if row is None:
        return default
    try:
        return json.loads(row[0])
    except (json.JSONDecodeError, TypeError):
        return default


def set_setting(key: str, value) -> None:
    with _LOCK:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO settings(key, value) VALUES(?, ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, json.dumps(value)),
        )
        conn.commit()


# ---- journal ---------------------------------------------------------------

def add_journal_trade(t: dict) -> int:
    with _LOCK:
        conn = _get_conn()
        cur = conn.execute(
            """INSERT INTO journal_trades
               (ts, entry_time, rule_name, strategy_id, strategy, symbol, timeframe,
                account, venue, side, entry, exit, pnl_pct, pnl_usd, r, hold_min)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (t.get("ts"), t.get("entry_time"), t.get("rule_name"), t.get("strategy_id"),
             t.get("strategy"), t.get("symbol"), t.get("timeframe"), t.get("account", "demo"),
             t.get("venue", "BINANCE"), t.get("side"), t.get("entry"), t.get("exit"),
             t.get("pnl_pct"), t.get("pnl_usd"), t.get("r"), t.get("hold_min")),
        )
        conn.commit()
        return cur.lastrowid


def get_journal(since_ts: int | None = None, strategy_id: str | None = None,
                symbol: str | None = None, account: str | None = None,
                limit: int = 2000) -> list[dict]:
    q = "SELECT * FROM journal_trades WHERE 1=1"
    args: list = []
    if since_ts:
        q += " AND ts >= ?"; args.append(since_ts)
    if strategy_id:
        q += " AND strategy_id = ?"; args.append(strategy_id)
    if symbol:
        q += " AND symbol = ?"; args.append(symbol)
    if account:
        q += " AND account = ?"; args.append(account)
    q += " ORDER BY ts ASC LIMIT ?"; args.append(limit)
    with _LOCK:
        return _rows(_get_conn().execute(q, args))


def journal_totals_by_rule() -> dict[str, dict]:
    """{rule_name: {pnl_usd, n}} for deployment cards."""
    with _LOCK:
        cur = _get_conn().execute(
            "SELECT rule_name, COALESCE(SUM(pnl_usd),0) AS pnl, COUNT(*) AS n "
            "FROM journal_trades GROUP BY rule_name")
        rows = cur.fetchall()
    return {r[0]: {"pnl_usd": float(r[1] or 0.0), "n": int(r[2])} for r in rows}


# ---- alerts history ---------------------------------------------------------

def add_alert_history(row: dict) -> int:
    with _LOCK:
        conn = _get_conn()
        cur = conn.execute(
            """INSERT INTO alerts_history
               (ts, rule_name, strategy_id, symbol, action, price, ok, status_code,
                error, url, test, dry_run, account)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (row.get("ts") or int(time.time()), row.get("rule_name"), row.get("strategy_id"),
             row.get("symbol"), row.get("action"), row.get("price"),
             1 if row.get("ok") else 0, row.get("status_code"), row.get("error"),
             row.get("url"), 1 if row.get("test") else 0, 1 if row.get("dry_run") else 0,
             row.get("account", "demo")),
        )
        conn.commit()
        return cur.lastrowid


def get_alerts_history(limit: int = 200) -> list[dict]:
    with _LOCK:
        return _rows(_get_conn().execute(
            "SELECT * FROM alerts_history ORDER BY ts DESC, id DESC LIMIT ?", (limit,)))


def delete_alerts_history(ids: list[int] | None = None) -> int:
    with _LOCK:
        conn = _get_conn()
        if ids:
            marks = ",".join("?" for _ in ids)
            cur = conn.execute(f"DELETE FROM alerts_history WHERE id IN ({marks})", ids)
        else:
            cur = conn.execute("DELETE FROM alerts_history")
        conn.commit()
        return cur.rowcount


# ---- activity log ------------------------------------------------------------

def add_activity(kind: str, rule_name: str = "", symbol: str = "", action: str = "",
                 ok: bool | None = None, detail: str = "") -> None:
    with _LOCK:
        conn = _get_conn()
        conn.execute(
            "INSERT INTO activity_log (ts, kind, rule_name, symbol, action, ok, detail) "
            "VALUES (?,?,?,?,?,?,?)",
            (int(time.time()), kind, rule_name, symbol, action,
             None if ok is None else (1 if ok else 0), detail[:2000]),
        )
        conn.commit()


def get_activity(limit: int = 300) -> list[dict]:
    with _LOCK:
        return _rows(_get_conn().execute(
            "SELECT * FROM activity_log ORDER BY ts DESC, id DESC LIMIT ?", (limit,)))
