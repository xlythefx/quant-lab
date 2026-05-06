"""
Hindsight backtest engine.

Single REST round-trip: load parquet → strategy.vectorized() → walk-forward
sim → return everything (candles, overlays, trades, equity, stats, analytics).

GLOBAL risk_config (services.risk_config) drives starting capital, risk
per trade, fees, and slippage. Strategy-level risk_pct is now ignored.
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services import market_data, risk_config
from services.strategy_registry import get_strategy_class

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialize_candles(df: pd.DataFrame) -> list[dict]:
    out = []
    for row in df.itertuples(index=False):
        out.append({
            "time": int(row.time),
            "open": float(row.open),
            "high": float(row.high),
            "low": float(row.low),
            "close": float(row.close),
            "volume": float(row.volume),
        })
    return out


def _build_overlays(strategy, sig_df: pd.DataFrame, time_a) -> list[dict]:
    overlays = []
    for ov in getattr(strategy, "OVERLAYS", []):
        if ov.from_column not in sig_df.columns:
            continue
        arr = sig_df[ov.from_column].astype(float).to_numpy()
        data = []
        for ti, val in zip(time_a, arr):
            if val is None or not math.isfinite(val):
                continue
            data.append({"time": int(ti), "value": float(val)})
        overlays.append({**ov.to_dict(), "data": data})
    return overlays


def _hhmm_to_min(s: str) -> int:
    try:
        hh, mm = s.split(":")
        return int(hh) * 60 + int(mm)
    except Exception:
        return 0


def _classify_session(entry_ts: int, sessions_cfg: dict) -> str:
    """Return the first enabled session name whose UTC window contains entry_ts.
    'unknown' if none match."""
    if not sessions_cfg:
        return "unknown"
    dt = datetime.fromtimestamp(int(entry_ts), tz=timezone.utc)
    minute = dt.hour * 60 + dt.minute
    for name, cfg in sessions_cfg.items():
        if not cfg or not cfg.get("enabled"):
            continue
        s = _hhmm_to_min(cfg.get("start", "00:00"))
        e = _hhmm_to_min(cfg.get("end", "00:00"))
        if s <= e:
            in_win = s <= minute < e
        else:
            in_win = minute >= s or minute < e   # wraps midnight
        if in_win:
            return name
    return "unknown"


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

def run(strategy_id: str, symbol: str, timeframe: str,
        params: Optional[dict] = None,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None) -> dict:

    rc = risk_config.get()
    starting_capital = float(rc["starting_capital"])
    risk_frac        = float(rc["risk_pct"]) / 100.0
    fee_flat         = float(rc["fee_flat"])
    fee_pct          = float(rc["fee_pct"]) / 100.0
    slippage         = float(rc["slippage_bps"]) / 10000.0

    cls = get_strategy_class(strategy_id)
    strategy = cls(params or {})

    df = market_data.load_parquet(symbol, timeframe)
    if start_time is not None:
        df = df[df["time"] >= int(start_time)]
    if end_time is not None:
        df = df[df["time"] <= int(end_time)]
    df = df.reset_index(drop=True)

    if df.empty:
        return _empty_result(strategy_id, symbol, timeframe, rc)

    sig_df = strategy.vectorized(df)
    time_a = sig_df["time"].to_numpy()
    close_a = sig_df["close"].to_numpy(dtype=float)
    el = sig_df["entry_long"].to_numpy()
    es = sig_df["entry_short"].to_numpy()
    xl = sig_df["exit_long"].to_numpy()
    xs = sig_df["exit_short"].to_numpy()

    n = len(sig_df)

    equity = float(starting_capital)
    peak = equity

    pos = 0
    entry_price = np.nan
    entry_time_ts = 0
    position_units = 0.0
    fees_paid_open = 0.0    # fees paid at open (deducted later from PnL)

    equity_arr = np.full(n, np.nan)
    dd_dollars_arr = np.zeros(n)
    trades_list: list[dict] = []

    for t in range(n):
        ts = int(time_a[t])
        c = close_a[t]

        # exits first
        if pos == 1 and xl[t]:
            fill = c * (1.0 - slippage)             # adverse slippage on exit
            notional_close = abs(fill * position_units)
            fee_close = fee_flat + notional_close * fee_pct
            pnl_dollars = (fill - entry_price) * position_units - fees_paid_open - fee_close
            equity += pnl_dollars
            trades_list.append(_trade("long", entry_price, fill, entry_time_ts, ts,
                                      pnl_dollars, position_units, fees_paid_open + fee_close))
            pos = 0; entry_price = np.nan; position_units = 0.0; fees_paid_open = 0.0
        elif pos == -1 and xs[t]:
            fill = c * (1.0 + slippage)
            notional_close = abs(fill * position_units)
            fee_close = fee_flat + notional_close * fee_pct
            pnl_dollars = (entry_price - fill) * position_units - fees_paid_open - fee_close
            equity += pnl_dollars
            trades_list.append(_trade("short", entry_price, fill, entry_time_ts, ts,
                                      pnl_dollars, position_units, fees_paid_open + fee_close))
            pos = 0; entry_price = np.nan; position_units = 0.0; fees_paid_open = 0.0

        # entries
        if pos == 0 and (el[t] or es[t]):
            side = 1 if el[t] else -1
            fill = c * (1.0 + slippage * side)      # adverse fill on entry
            if fill <= 0:
                continue
            position_units = (equity * risk_frac) / fill
            notional_open = fill * position_units
            fees_paid_open = fee_flat + abs(notional_open) * fee_pct
            entry_price = fill
            entry_time_ts = ts
            pos = side

        peak = max(peak, equity)
        equity_arr[t] = equity
        dd_dollars_arr[t] = equity - peak  # ≤ 0

    equity_curve = []
    for t in range(n):
        eq = float(equity_arr[t])
        equity_curve.append({
            "time": int(time_a[t]),
            "equity": eq,
            "value": eq / starting_capital * 100.0,
            "drawdown": float(dd_dollars_arr[t]) / starting_capital * 100.0,
            "drawdown_dollars": float(dd_dollars_arr[t]),
        })

    stats = _compute_stats(trades_list, equity, dd_dollars_arr, time_a, starting_capital)
    analytics = _compute_analytics(trades_list, equity_curve, sig_df, strategy, starting_capital)

    log.info("[hindsight %s/%s/%s] %d bars, %d trades, final $%s (%.2f%%)",
             strategy_id, symbol, timeframe, n, len(trades_list),
             f"{equity:,.2f}", (equity / starting_capital - 1.0) * 100.0)

    return {
        "strategy_id": strategy_id,
        "symbol": symbol,
        "timeframe": timeframe,
        "risk_config": rc,
        "params": strategy.p,                       # effective merged params
        "candles": _serialize_candles(sig_df[["time", "open", "high", "low", "close", "volume"]]),
        "overlays": _build_overlays(strategy, sig_df, time_a),
        "trades": trades_list,
        "equity": equity_curve,
        "stats": stats,
        "analytics": analytics,
    }


# ---------------------------------------------------------------------------
# Trade record
# ---------------------------------------------------------------------------

def _trade(side, entry_p, exit_p, entry_t, exit_t, pnl_dollars, units, fees):
    pnl_pct_price = (exit_p - entry_p) / entry_p * 100.0
    if side == "short":
        pnl_pct_price = -pnl_pct_price
    duration_min = max(0, int((exit_t - entry_t) / 60))
    return {
        "side": side,
        "entry_price": float(entry_p),
        "exit_price": float(exit_p),
        "entry_time": int(entry_t),
        "exit_time": int(exit_t),
        "pnl_dollars": float(pnl_dollars),
        "pnl_pct": float(pnl_pct_price),
        "units": float(units),
        "fees": float(fees),
        "duration_min": duration_min,
        "win": bool(pnl_dollars >= 0),
    }


# ---------------------------------------------------------------------------
# Stats (overview)
# ---------------------------------------------------------------------------

def _compute_stats(trades, final_equity, dd_dollars_arr, time_a, starting_capital) -> dict:
    n_trades = len(trades)
    wins = sum(1 for t in trades if t["win"])
    losses = n_trades - wins
    win_rate = (wins / n_trades) if n_trades else 0.0

    pnl_arr = np.array([t["pnl_dollars"] for t in trades]) if trades else np.array([])
    gross_profit = float(pnl_arr[pnl_arr > 0].sum()) if trades else 0.0
    gross_loss = float(-pnl_arr[pnl_arr < 0].sum()) if trades else 0.0
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (None if gross_profit > 0 else 0.0)

    pct_arr = np.array([t["pnl_pct"] for t in trades]) if trades else np.array([])
    if len(pct_arr) >= 2 and pct_arr.std(ddof=1) > 0:
        sharpe = float(pct_arr.mean() / pct_arr.std(ddof=1) * math.sqrt(len(pct_arr)))
    else:
        sharpe = 0.0

    max_dd_dollars = float(dd_dollars_arr.min()) if len(dd_dollars_arr) else 0.0

    longs  = [t for t in trades if t["side"] == "long"]
    shorts = [t for t in trades if t["side"] == "short"]

    return {
        "starting_capital": float(starting_capital),
        "final_equity": float(final_equity),
        "total_return_dollars": float(final_equity - starting_capital),
        "total_return_pct": float((final_equity / starting_capital - 1.0) * 100.0),
        "trades": int(n_trades),
        "wins": int(wins),
        "losses": int(losses),
        "win_rate": float(win_rate),
        "profit_factor": profit_factor,
        "sharpe": float(sharpe),
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        "max_drawdown_pct": float(max_dd_dollars) / float(starting_capital) * 100.0,
        "max_drawdown_dollars": float(max_dd_dollars),
        "avg_pnl_dollars": float(pnl_arr.mean()) if trades else 0.0,
        "avg_pnl_pct": float(pct_arr.mean()) if trades else 0.0,
        "long":  _side_block(longs),
        "short": _side_block(shorts),
        "first_time": int(time_a[0]),
        "last_time": int(time_a[-1]),
    }


def _side_block(trades) -> dict:
    n = len(trades)
    wins = sum(1 for t in trades if t["win"])
    pnl = sum(t["pnl_dollars"] for t in trades)
    return {
        "trades": int(n),
        "wins": int(wins),
        "losses": int(n - wins),
        "pnl_dollars": float(pnl),
        "win_rate": (wins / n) if n else 0.0,
        "avg_pnl_dollars": (pnl / n) if n else 0.0,
    }


# ---------------------------------------------------------------------------
# Analytics block — quant-research-grade insights
# ---------------------------------------------------------------------------

def _compute_analytics(trades, equity_curve, sig_df, strategy, starting_capital) -> dict:
    """Heavy stuff for the Analytics page tabs."""
    sessions_cfg = (strategy.p.get("sessions") or {}) if hasattr(strategy, "p") else {}

    # ---- per-session breakdown
    by_session_dict: dict = defaultdict(lambda: {"trades": 0, "wins": 0, "pnl_dollars": 0.0,
                                                 "long_trades": 0, "short_trades": 0,
                                                 "long_pnl": 0.0, "short_pnl": 0.0})
    for t in trades:
        sess = _classify_session(t["entry_time"], sessions_cfg)
        b = by_session_dict[sess]
        b["trades"] += 1
        if t["win"]: b["wins"] += 1
        b["pnl_dollars"] += t["pnl_dollars"]
        if t["side"] == "long":
            b["long_trades"] += 1
            b["long_pnl"]    += t["pnl_dollars"]
        else:
            b["short_trades"] += 1
            b["short_pnl"]    += t["pnl_dollars"]
    by_session = []
    for name, b in by_session_dict.items():
        n = b["trades"]
        by_session.append({
            "session": name,
            "trades": n,
            "wins": b["wins"],
            "win_rate": (b["wins"] / n) if n else 0.0,
            "pnl_dollars": b["pnl_dollars"],
            "avg_pnl_dollars": (b["pnl_dollars"] / n) if n else 0.0,
            "long_trades": b["long_trades"],
            "long_pnl_dollars": b["long_pnl"],
            "short_trades": b["short_trades"],
            "short_pnl_dollars": b["short_pnl"],
        })

    # ---- hour-of-day × day-of-week heatmap (PnL + count)
    heat_pnl = [[0.0] * 24 for _ in range(7)]   # [dow][hour]
    heat_count = [[0] * 24 for _ in range(7)]
    for t in trades:
        dt = datetime.fromtimestamp(t["entry_time"], tz=timezone.utc)
        dow = dt.weekday()  # 0 = Mon
        hour = dt.hour
        heat_pnl[dow][hour] += t["pnl_dollars"]
        heat_count[dow][hour] += 1

    # ---- monthly returns (sum PnL by YYYY-MM)
    monthly_dict: dict = defaultdict(float)
    monthly_trades: dict = defaultdict(int)
    for t in trades:
        ym = datetime.fromtimestamp(t["entry_time"], tz=timezone.utc).strftime("%Y-%m")
        monthly_dict[ym] += t["pnl_dollars"]
        monthly_trades[ym] += 1
    monthly_returns = sorted(
        [{"month": m, "pnl_dollars": v, "trades": monthly_trades[m]} for m, v in monthly_dict.items()],
        key=lambda x: x["month"],
    )

    # ---- streaks
    cur_w = cur_l = max_w = max_l = 0
    for t in trades:
        if t["win"]:
            cur_w += 1; cur_l = 0
            max_w = max(max_w, cur_w)
        else:
            cur_l += 1; cur_w = 0
            max_l = max(max_l, cur_l)

    # ---- drawdown details
    dd_pcts = [p["drawdown"] for p in equity_curve] if equity_curve else [0.0]
    dd_curve = [{"time": p["time"], "drawdown": p["drawdown"]} for p in equity_curve]
    # Max DD duration: how long (in bars) we stayed below previous peak.
    peak = -math.inf
    cur_under = 0
    max_under = 0
    for p in equity_curve:
        if p["equity"] >= peak:
            peak = p["equity"]
            cur_under = 0
        else:
            cur_under += 1
            max_under = max(max_under, cur_under)

    # ---- distribution: bucket trade pnl_pct into 20 bins
    distribution = []
    if trades:
        arr = np.array([t["pnl_pct"] for t in trades])
        lo = float(arr.min())
        hi = float(arr.max())
        if hi <= lo:
            hi = lo + 1e-6
        bins = 20
        step = (hi - lo) / bins
        counts = [0] * bins
        for v in arr:
            idx = min(bins - 1, max(0, int((v - lo) / step)))
            counts[idx] += 1
        distribution = [
            {"bin_lo": lo + i * step, "bin_hi": lo + (i + 1) * step, "count": counts[i]}
            for i in range(bins)
        ]

    # ---- duration distribution (in minutes, 12 bins)
    duration_dist = []
    if trades:
        arr = np.array([t["duration_min"] for t in trades])
        lo = float(arr.min())
        hi = float(arr.max())
        if hi <= lo:
            hi = lo + 1
        bins = 12
        step = (hi - lo) / bins
        counts = [0] * bins
        for v in arr:
            idx = min(bins - 1, max(0, int((v - lo) / step)))
            counts[idx] += 1
        duration_dist = [
            {"bin_lo": lo + i * step, "bin_hi": lo + (i + 1) * step, "count": counts[i]}
            for i in range(bins)
        ]

    # ---- best / worst single trade
    best  = max(trades, key=lambda t: t["pnl_dollars"]) if trades else None
    worst = min(trades, key=lambda t: t["pnl_dollars"]) if trades else None

    # ---- commission paid + trading days
    total_commission = float(sum(t.get("fees", 0.0) for t in trades))
    trading_days = len({datetime.fromtimestamp(t["entry_time"], tz=timezone.utc).date()
                        for t in trades})

    # ---- exposure (% of bars in a position)
    pos_bars = 0
    pos_state = 0
    for t in trades:
        # approximate via trade entry/exit times — count bars in [entry, exit]
        pass
    # cleaner: rebuild from entry/exit pairs against time index
    if trades and len(sig_df) > 0:
        ts_to_idx = {int(time_a[i]): i for i, time_a in enumerate([sig_df["time"].to_numpy()] * 1)}
        # ↑ avoid recomputing time_a; just use sig_df directly
        time_arr = sig_df["time"].to_numpy()
        idx_lookup = {int(time_arr[i]): i for i in range(len(time_arr))}
        for t in trades:
            ei = idx_lookup.get(int(t["entry_time"]))
            xi = idx_lookup.get(int(t["exit_time"]))
            if ei is not None and xi is not None and xi >= ei:
                pos_bars += (xi - ei + 1)
        exposure_pct = pos_bars / len(time_arr) * 100.0
    else:
        exposure_pct = 0.0

    return {
        "by_session": by_session,
        "heatmap": {"pnl": heat_pnl, "count": heat_count},
        "monthly_returns": monthly_returns,
        "streaks": {"max_win_streak": max_w, "max_loss_streak": max_l},
        "drawdown_curve": dd_curve,
        "max_drawdown_duration_bars": int(max_under),
        "distribution_pnl_pct": distribution,
        "distribution_duration_min": duration_dist,
        "best_trade": best,
        "worst_trade": worst,
        "exposure_pct": float(exposure_pct),
        "commission_dollars": total_commission,
        "trading_days": int(trading_days),
    }


def _empty_result(strategy_id, symbol, timeframe, rc):
    return {
        "strategy_id": strategy_id, "symbol": symbol, "timeframe": timeframe,
        "risk_config": rc,
        "candles": [], "overlays": [], "trades": [], "equity": [],
        "stats": {
            "starting_capital": float(rc["starting_capital"]),
            "final_equity": float(rc["starting_capital"]),
            "total_return_dollars": 0.0, "total_return_pct": 0.0,
            "trades": 0, "wins": 0, "losses": 0, "win_rate": 0.0,
            "profit_factor": 0.0, "sharpe": 0.0,
            "gross_profit": 0.0, "gross_loss": 0.0,
            "max_drawdown_pct": 0.0, "max_drawdown_dollars": 0.0,
            "avg_pnl_dollars": 0.0, "avg_pnl_pct": 0.0,
            "long":  {"trades": 0, "wins": 0, "losses": 0, "pnl_dollars": 0.0, "win_rate": 0.0, "avg_pnl_dollars": 0.0},
            "short": {"trades": 0, "wins": 0, "losses": 0, "pnl_dollars": 0.0, "win_rate": 0.0, "avg_pnl_dollars": 0.0},
            "first_time": None, "last_time": None,
        },
        "analytics": {
            "by_session": [], "heatmap": {"pnl": [[0]*24]*7, "count": [[0]*24]*7},
            "monthly_returns": [], "streaks": {"max_win_streak": 0, "max_loss_streak": 0},
            "drawdown_curve": [], "max_drawdown_duration_bars": 0,
            "distribution_pnl_pct": [], "distribution_duration_min": [],
            "best_trade": None, "worst_trade": None, "exposure_pct": 0.0,
            "commission_dollars": 0.0, "trading_days": 0,
        },
    }
