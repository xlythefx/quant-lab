"""
Live analytics = the BACKTEST engine's math over the live trade journal.

We adapt journal rows to the exact `trades` shape `_compute_stats` expects
and synthesize the trade-exit equity curve (starting_capital + cumulative
realized P&L), then call backtest_engine._compute_stats itself — the metric
formulas are literally the same code, not a re-implementation.

Honest caveats (surfaced in the UI):
  - pnl_usd is the engine's ESTIMATE until phase-09 reconciliation supplies
    the broker's actual realized P&L.
  - Sharpe is computed on the trade-exit equity series (live has no per-bar
    MTM equity), annualized from the spacing of exits.
"""
from __future__ import annotations

import logging
import time
from typing import Optional

import numpy as np

from services import risk_config
from services.backtest_engine import _compute_stats
from services.live import live_store

log = logging.getLogger(__name__)

PERIODS = {"7D": 7 * 86400, "30D": 30 * 86400, "ALL": None}

GROUP_FIELDS = {
    "strategy": ("strategy_id", "strategy"),
    "symbol": ("symbol", "symbol"),
    "account": ("account", "account"),
}


def _rows_to_trades(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        pnl = float(r.get("pnl_usd") or 0.0)
        out.append({
            "win": pnl > 0,
            "pnl_dollars": pnl,
            "pnl_pct": float(r.get("pnl_pct") or 0.0),
            "side": (r.get("side") or "LONG").lower(),
            "entry_time": r.get("entry_time"),
            "exit_time": r.get("ts"),
            "hold_min": float(r.get("hold_min") or 0.0),
            "r": r.get("r"),
        })
    return out


def _equity_series(trades: list[dict], starting_capital: float):
    eq = [starting_capital]
    times = []
    for t in trades:
        eq.append(eq[-1] + t["pnl_dollars"])
        times.append(int(t["exit_time"] or 0))
    eq_arr = np.array(eq[1:], dtype=float) if len(eq) > 1 else np.array([starting_capital])
    time_a = np.array(times, dtype=np.int64) if times else np.array([int(time.time())], dtype=np.int64)
    peak = np.maximum.accumulate(np.concatenate([[starting_capital], eq_arr]))[1:]
    dd = eq_arr - peak
    return eq_arr, time_a, dd


def compute(period: str = "ALL", group: str = "strategy",
            filter_key: Optional[str] = None, filter_value: Optional[str] = None,
            account: Optional[str] = None) -> dict:
    span = PERIODS.get((period or "ALL").upper(), None)
    since = int(time.time()) - span if span else None
    rows = live_store.get_journal(since_ts=since, account=account or None)

    if filter_key in GROUP_FIELDS and filter_value:
        field = GROUP_FIELDS[filter_key][0]
        rows = [r for r in rows if str(r.get(field)) == str(filter_value)]

    try:
        cap = float(risk_config.get().get("starting_capital", 100_000.0))
    except Exception:
        cap = 100_000.0

    trades = _rows_to_trades(rows)
    eq_arr, time_a, dd = _equity_series(trades, cap)
    final_eq = float(eq_arr[-1]) if len(eq_arr) else cap

    stats = _compute_stats(trades, final_eq, dd, time_a, cap, equity_arr=eq_arr)

    # extras the terminal cards want
    holds = [t["hold_min"] for t in trades if t["hold_min"] is not None]
    rs = [t["r"] for t in trades if t.get("r") is not None]
    stats["avg_hold_min"] = float(np.mean(holds)) if holds else None
    stats["expectancy_usd"] = stats["avg_pnl_dollars"]
    stats["expectancy_r"] = float(np.mean(rs)) if rs else None

    curve = [{"t": int(t), "eq": float(e)} for t, e in zip(time_a.tolist(), eq_arr.tolist())] if trades else []

    # breakdown by group
    gfield = GROUP_FIELDS.get(group, GROUP_FIELDS["strategy"])[0]
    groups: dict[str, list[dict]] = {}
    for r in rows:
        groups.setdefault(str(r.get(gfield) or "—"), []).append(r)
    breakdown = []
    for key, grows in groups.items():
        gtrades = _rows_to_trades(grows)
        pnl = sum(t["pnl_dollars"] for t in gtrades)
        wins = sum(1 for t in gtrades if t["win"])
        gp = sum(t["pnl_dollars"] for t in gtrades if t["pnl_dollars"] > 0)
        gl = -sum(t["pnl_dollars"] for t in gtrades if t["pnl_dollars"] < 0)
        label = grows[0].get("strategy") if gfield == "strategy_id" else key
        breakdown.append({
            "key": key,
            "label": label or key,
            "net": float(pnl),
            "win": (wins / len(gtrades) * 100.0) if gtrades else 0.0,
            "pf": (gp / gl) if gl > 0 else (None if gp > 0 else 0.0),
            "exp": (pnl / len(gtrades)) if gtrades else 0.0,
            "n": len(gtrades),
        })
    breakdown.sort(key=lambda b: b["net"], reverse=True)

    return {"stats": stats, "curve": curve, "breakdown": breakdown,
            "period": period, "group": group,
            "filter": {"key": filter_key, "value": filter_value} if filter_value else None}
