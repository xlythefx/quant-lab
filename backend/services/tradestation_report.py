"""
TradeStation Performance Report parser.

Turns a raw TradeStation "Performance Report" CSV export (the multi-section
report you get from File → Print/Export on the Performance Report tab) into a
single structured dict the frontend dashboard can render.

The export is NOT a flat trade log. It is several stacked tables glued into one
CSV, each introduced by a title line and separated by blank lines, with lots of
trailing empty columns. The interesting blocks are:

  Performance Summary   — key, All / Long / Short columns (we read the "All" col)
  Trades List           — one trade encoded as a PAIR of rows (entry + exit)
  Periodical Returns     — Annual / Monthly / Weekly / Daily aggregate tables

We do two things with it, deliberately side by side (see CLAUDE.md "honest" tone):

  reported    — the numbers TradeStation already printed (parsed verbatim)
  recomputed  — the same numbers re-derived from the parsed trades ourselves,
                so the two can be eyeballed against each other for sanity.

Pure functions, no I/O. `parse_report(csv_text)` is the only public entry.
"""
from __future__ import annotations

import csv
import io
import math
from collections import defaultdict
from datetime import datetime, timezone

# Type cell on the ENTRY row of a trade → direction.
_ENTRY_LONG = {"buy"}
_ENTRY_SHORT = {"sell short"}
_EXIT_TYPES = {"sell", "buy to cover"}
_TRADE_TYPES = _ENTRY_LONG | _ENTRY_SHORT | _EXIT_TYPES

# Accepted Date/Time layouts. TradeStation mixes a 4-digit-year form in the
# trades list with a 2-digit-year form in a couple of drawdown date cells.
_DT_FORMATS = (
    "%m/%d/%Y %H:%M",
    "%m/%d/%y %H:%M",
    "%m/%d/%Y",
    "%m/%d/%y",
)


# ---------------------------------------------------------------------------
# Cell parsers
# ---------------------------------------------------------------------------

def _money(s):
    """'$1234.56' / '($303.61)' / '12.5%' / 'n/a' -> float | None.

    Parentheses mean negative; '$', ',', '%' are stripped; blank / n/a -> None.
    """
    if s is None:
        return None
    s = str(s).strip()
    if not s or s.lower() in ("n/a", "na", "--", "-"):
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()").replace("$", "").replace(",", "").replace("%", "").strip()
    if not s:
        return None
    try:
        v = float(s)
    except ValueError:
        return None
    return -v if neg else v


def _int(s):
    v = _money(s)
    return int(round(v)) if v is not None else None


def _dt(s):
    """'8/29/2016 04:00' -> epoch seconds (UTC-anchored). None on failure.

    Times in the report are a backtest wall clock with no real timezone; we
    anchor every parse to UTC so epoch round-trips (and month bucketing) stay
    self-consistent.
    """
    if not s:
        return None
    s = str(s).strip()
    for fmt in _DT_FORMATS:
        try:
            dt = datetime.strptime(s, fmt)
            return int(dt.replace(tzinfo=timezone.utc).timestamp())
        except ValueError:
            continue
    return None


# ---------------------------------------------------------------------------
# Trades list
# ---------------------------------------------------------------------------

def _find_trades_header(rows):
    """Index of the trades-list column header row, or -1."""
    for i, r in enumerate(rows):
        if r and str(r[0]).strip() == "#" and len(r) > 2 and "Date/Time" in str(r[2]):
            return i
    return -1


def _cell(row, i):
    return row[i].strip() if i < len(row) and row[i] is not None else ""


def _parse_trades(rows):
    """Walk the trades list into a list of trade dicts.

    A trade is a group of consecutive rows that starts at a numbered (`#`) row.
    The numbered row is the ENTRY; the last row of the group is the EXIT. With
    fixed 1-contract sizing every group is exactly two rows, but grouping by the
    next number tolerates multi-leg fills too.

    Column layout (0-indexed):
      0 #   1 Type   2 Date/Time   3 Signal   4 Price   5 RollOver
      6 Shares/Ctrts | P/L         7 NetProfit | CumNetProfit
      8 %Profit   9 RunUp/DD   10 Eff   11 TotalEff   12 Comm   13 Slippage

    On the ENTRY row col6=contracts and col7=this trade's net profit; on the
    EXIT row col6=gross P/L and col7=the running cumulative net profit.
    """
    hi = _find_trades_header(rows)
    if hi < 0:
        return []

    groups = []
    cur = None
    for r in rows[hi + 1:]:
        c0 = _cell(r, 0)
        c1 = _cell(r, 1).lower()
        if not c0 and not c1:
            continue  # blank separator inside the section
        if c0.isdigit():
            if cur:
                groups.append(cur)
            cur = [r]
        elif cur is not None and c1 in _TRADE_TYPES:
            cur.append(r)
        else:
            break  # left the trades section (e.g. "Annual")
    if cur:
        groups.append(cur)

    trades = []
    for g in groups:
        entry, exit_ = g[0], g[-1]
        etype = _cell(entry, 1).lower()
        direction = "long" if etype in _ENTRY_LONG else "short"
        net = _money(_cell(entry, 7))
        cum = _money(_cell(exit_, 7))
        if net is None or cum is None:
            continue
        comm = sum(_money(_cell(x, 12)) or 0.0 for x in g)
        slip = sum(_money(_cell(x, 13)) or 0.0 for x in g)
        trades.append({
            "n": _int(_cell(entry, 0)),
            "direction": direction,
            "entry_time": _dt(_cell(entry, 2)),
            "entry_signal": _cell(entry, 3),
            "entry_price": _money(_cell(entry, 4)),
            "exit_time": _dt(_cell(exit_, 2)),
            "exit_signal": _cell(exit_, 3),
            "exit_price": _money(_cell(exit_, 4)),
            "contracts": _int(_cell(entry, 6)),
            "net_profit": net,
            "cum_profit": cum,
            "pct_profit": _money(_cell(entry, 8)),
            "commission": round(comm, 2),
            "slippage": round(slip, 2),
        })
    return trades


# ---------------------------------------------------------------------------
# Performance Summary (the "reported" numbers, All-Trades column)
# ---------------------------------------------------------------------------

# label in the report -> (key, parser)
_SUMMARY_MAP = {
    "Total Net Profit":               ("net_profit", _money),
    "Gross Profit":                   ("gross_profit", _money),
    "Gross Loss":                     ("gross_loss", _money),
    "Profit Factor":                  ("profit_factor", _money),
    "Total Number of Trades":         ("total_trades", _int),
    "Percent Profitable":             ("percent_profitable", _money),
    "Winning Trades":                 ("winning_trades", _int),
    "Losing Trades":                  ("losing_trades", _int),
    "Avg. Trade Net Profit":          ("avg_trade", _money),
    "Avg. Winning Trade":             ("avg_win", _money),
    "Avg. Losing Trade":              ("avg_loss", _money),
    "Ratio Avg. Win:Avg. Loss":       ("payoff_ratio", _money),
    "Largest Winning Trade":          ("largest_win", _money),
    "Largest Losing Trade":           ("largest_loss", _money),
    "Max. Consecutive Winning Trades": ("max_consec_win", _int),
    "Max. Consecutive Losing Trades":  ("max_consec_loss", _int),
    "Sharpe Ratio":                   ("sharpe", _money),
    "Return on Initial Capital":      ("return_on_initial", _money),
    "Annual Rate of Return":          ("annual_return", _money),
    "Return on Account":              ("return_on_account", _money),
    "Account Size Required":          ("account_size_required", _money),
    "Total Commission":               ("total_commission", _money),
    "Total Slippage":                 ("total_slippage", _money),
    "Avg. Bars in Total Trades":      ("avg_bars", _money),
}


def _parse_summary(rows):
    """Read the Performance Summary block's All-Trades column into a dict.

    Bounded to the rows between the 'TradeStation Performance Summary' title and
    the 'Trade Analysis' title so labels that repeat later (e.g. 'Avg. Trade Net
    Profit') don't get clobbered.
    """
    start = end = None
    for i, r in enumerate(rows):
        c0 = _cell(r, 0)
        if c0 == "TradeStation Performance Summary":
            start = i
        elif c0 == "Trade Analysis" and start is not None:
            end = i
            break
    if start is None:
        return {}
    block = rows[start:end] if end else rows[start:]

    out = {}
    for r in block:
        label = _cell(r, 0)
        spec = _SUMMARY_MAP.get(label)
        if spec and label not in (None, ""):
            key, fn = spec
            if key not in out:  # first occurrence (the summary one) wins
                out[key] = fn(_cell(r, 1))

    # The two max-drawdown blocks: a title row, then a "Value" row.
    out["max_drawdown_intraday"] = _drawdown_value(block, "Max. Drawdown (Intra-Day")
    out["max_drawdown_close"] = _drawdown_value(block, "Max. Drawdown (Trade Close")
    return out


def _drawdown_value(block, title_prefix):
    for i, r in enumerate(block):
        if _cell(r, 0).startswith(title_prefix):
            for r2 in block[i + 1:i + 4]:
                if _cell(r2, 0) == "Value":
                    return _money(_cell(r2, 1))
    return None


# ---------------------------------------------------------------------------
# Periodical: Annual "Mark-To-Market Period Analysis" table (reported)
# ---------------------------------------------------------------------------

def _parse_annual_reported(rows):
    """The Annual section's per-year Net Profit / PF / #Trades table."""
    start = None
    for i, r in enumerate(rows):
        if _cell(r, 0) == "TradeStation Periodical Returns:Annual":
            start = i
            break
    if start is None:
        return []
    # Find the first "Period,Net Profit,..." header after the title.
    out = []
    seen_header = False
    for r in rows[start:]:
        c0 = _cell(r, 0)
        if c0 == "Period" and "Net Profit" in _cell(r, 1):
            seen_header = True
            continue
        if not seen_header:
            continue
        if not c0:
            break  # blank line ends the first (period) table
        if c0.lower().startswith("last 12"):
            continue  # skip the rolling "Last 12 Months" convenience row
        net = _money(_cell(r, 1))
        if net is None:
            continue
        # Period cell is like "1/1/2023"; take the year.
        year = None
        try:
            year = int(c0.split("/")[-1])
        except (ValueError, IndexError):
            pass
        out.append({
            "period": c0,
            "year": year,
            "net_profit": net,
            "pct_gain": _money(_cell(r, 2)),
            "profit_factor": _money(_cell(r, 3)),
            "trades": _int(_cell(r, 4)),
            "percent_profitable": _money(_cell(r, 5)),
        })
    return out


# ---------------------------------------------------------------------------
# Recompute from the parsed trades (our independent numbers)
# ---------------------------------------------------------------------------

def _max_consecutive(flags):
    best = run = 0
    for f in flags:
        run = run + 1 if f else 0
        best = max(best, run)
    return best


def _histogram(vals, bins=31):
    if not vals:
        return {"counts": [], "bin_edges": [], "mean": None, "std": None}
    lo, hi = min(vals), max(vals)
    if lo == hi:
        lo, hi = lo - 1, hi + 1
    width = (hi - lo) / bins
    edges = [lo + i * width for i in range(bins + 1)]
    counts = [0] * bins
    for v in vals:
        idx = int((v - lo) / width)
        if idx >= bins:
            idx = bins - 1
        elif idx < 0:
            idx = 0
        counts[idx] += 1
    mean = sum(vals) / len(vals)
    std = math.sqrt(sum((v - mean) ** 2 for v in vals) / len(vals)) if len(vals) > 1 else 0.0
    return {"counts": counts, "bin_edges": [round(e, 2) for e in edges],
            "mean": round(mean, 4), "std": round(std, 4)}


def _direction_stats(trades):
    out = {}
    for d in ("long", "short"):
        nets = [t["net_profit"] for t in trades if t["direction"] == d]
        if not nets:
            out[d] = {"trades": 0, "net_profit": 0.0, "win_rate": None}
            continue
        wins = sum(1 for n in nets if n > 0)
        out[d] = {
            "trades": len(nets),
            "net_profit": round(sum(nets), 2),
            "win_rate": round(100 * wins / len(nets), 2),
        }
    return out


def _recompute(trades, initial_capital):
    nets = [t["net_profit"] for t in trades]
    n = len(nets)
    if n == 0:
        return {}, [], [], {"counts": [], "bin_edges": [], "mean": None, "std": None}

    wins = [x for x in nets if x > 0]
    losses = [x for x in nets if x < 0]
    gross_profit = sum(wins)
    gross_loss = sum(losses)  # negative
    net_profit = sum(nets)

    # Equity + drawdown, walked in trade order.
    equity_curve, drawdown_curve = [], []
    run = 0.0
    peak_equity = initial_capital
    max_dd = 0.0
    max_dd_pct = 0.0
    for t in trades:
        run += t["net_profit"]
        eq = initial_capital + run
        peak_equity = max(peak_equity, eq)
        dd = eq - peak_equity            # <= 0, dollars
        dd_pct = (dd / peak_equity * 100) if peak_equity else 0.0
        max_dd = min(max_dd, dd)
        max_dd_pct = min(max_dd_pct, dd_pct)
        ts = t["exit_time"] or t["entry_time"]
        equity_curve.append({"time": ts, "value": round(eq, 2), "pnl": round(run, 2)})
        drawdown_curve.append({"time": ts, "value": round(dd, 2), "pct": round(dd_pct, 3)})

    # Per-trade Sharpe (reward/risk per trade, no annualization claim) plus a
    # monthly-basis annualized Sharpe — the closest like-for-like to the figure
    # TradeStation prints (it Sharpe-ratios monthly returns).
    mean = net_profit / n
    std = math.sqrt(sum((x - mean) ** 2 for x in nets) / n) if n > 1 else 0.0
    sharpe_trade = (mean / std) if std else None
    times = [t["exit_time"] for t in trades if t["exit_time"]]
    years = ((max(times) - min(times)) / (365.25 * 86400)) if len(times) > 1 else None
    trades_per_year = (n / years) if years else None

    monthly = defaultdict(float)
    for t in trades:
        ts = t["exit_time"] or t["entry_time"]
        if ts is not None:
            d = datetime.fromtimestamp(ts, timezone.utc)
            monthly[(d.year, d.month)] += t["net_profit"]
    m_rets = [v / initial_capital for v in monthly.values()] if initial_capital else []
    sharpe_monthly_ann = None
    if len(m_rets) > 1:
        mm = sum(m_rets) / len(m_rets)
        ms = math.sqrt(sum((x - mm) ** 2 for x in m_rets) / len(m_rets))
        if ms:
            sharpe_monthly_ann = (mm / ms) * math.sqrt(12)

    win_flags = [x > 0 for x in nets]

    metrics = {
        "total_trades": n,
        "winning_trades": len(wins),
        "losing_trades": len(losses),
        "even_trades": n - len(wins) - len(losses),
        "percent_profitable": round(100 * len(wins) / n, 2),
        "net_profit": round(net_profit, 2),
        "gross_profit": round(gross_profit, 2),
        "gross_loss": round(gross_loss, 2),
        "profit_factor": round(gross_profit / abs(gross_loss), 4) if gross_loss else None,
        "avg_trade": round(mean, 2),
        "avg_win": round(sum(wins) / len(wins), 2) if wins else None,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else None,
        "payoff_ratio": (round((sum(wins) / len(wins)) / abs(sum(losses) / len(losses)), 3)
                         if wins and losses else None),
        "expectancy": round(mean, 2),
        "largest_win": round(max(nets), 2),
        "largest_loss": round(min(nets), 2),
        "max_consec_win": _max_consecutive(win_flags),
        "max_consec_loss": _max_consecutive([not f for f in win_flags]),
        "max_drawdown": round(max_dd, 2),
        "max_drawdown_pct": round(max_dd_pct, 3),
        "sharpe_trade": round(sharpe_trade, 4) if sharpe_trade is not None else None,
        "sharpe_monthly_ann": round(sharpe_monthly_ann, 4) if sharpe_monthly_ann is not None else None,
        "trades_per_year": round(trades_per_year, 1) if trades_per_year else None,
        "final_equity": round(initial_capital + net_profit, 2),
        "return_pct": round(100 * net_profit / initial_capital, 2) if initial_capital else None,
        "by_direction": _direction_stats(trades),
    }
    hist = _histogram(nets)
    return metrics, equity_curve, drawdown_curve, hist


def _monthly_yearly(trades):
    """Recompute month- and year-bucketed net P&L from the trades' exit times."""
    by_month = defaultdict(float)
    by_year = defaultdict(float)
    by_year_n = defaultdict(int)
    by_year_w = defaultdict(int)
    for t in trades:
        ts = t["exit_time"] or t["entry_time"]
        if ts is None:
            continue
        dt = datetime.fromtimestamp(ts, timezone.utc)
        by_month[(dt.year, dt.month)] += t["net_profit"]
        by_year[dt.year] += t["net_profit"]
        by_year_n[dt.year] += 1
        if t["net_profit"] > 0:
            by_year_w[dt.year] += 1

    years = sorted(by_year)
    grid = []
    for y in years:
        months = [round(by_month[(y, m)], 2) if (y, m) in by_month else None
                  for m in range(1, 13)]
        grid.append({"year": y, "months": months, "total": round(by_year[y], 2)})
    yearly = [{
        "year": y,
        "net_profit": round(by_year[y], 2),
        "trades": by_year_n[y],
        "win_rate": round(100 * by_year_w[y] / by_year_n[y], 2) if by_year_n[y] else None,
    } for y in years]
    return grid, yearly


# ---------------------------------------------------------------------------
# Initial capital — derive from the report so the equity curve is account-scaled
# ---------------------------------------------------------------------------

def _initial_capital(reported, net_profit):
    """Back out starting capital from 'Return on Initial Capital'.

    net / (roic/100) = initial. Snap to the nearest $1,000 when within 0.5% of a
    round figure (TradeStation reports roic at 2dp, so the back-out is fuzzy).
    Falls back to $100,000.
    """
    roic = reported.get("return_on_initial")
    if roic and net_profit is not None and roic != 0:
        raw = net_profit / (roic / 100.0)
        snapped = round(raw / 1000.0) * 1000.0
        if snapped > 0 and abs(raw - snapped) / snapped <= 0.005:
            return snapped, "derived (Return on Initial Capital, snapped)"
        return round(raw, 2), "derived (Return on Initial Capital)"
    return 100000.0, "default ($100,000)"


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------

def parse_report(csv_text, name=None):
    """Parse a TradeStation Performance Report CSV string into a dashboard dict.

    Raises ValueError if no trades list can be found (i.e. not a TS report).
    """
    rows = list(csv.reader(io.StringIO(csv_text)))
    if not rows:
        raise ValueError("Empty file.")

    trades = _parse_trades(rows)
    if not trades:
        raise ValueError(
            "No trades list found — is this a TradeStation Performance Report "
            "export? Expected a '#,Type,Date/Time,...' header followed by paired "
            "entry/exit rows."
        )

    reported = _parse_summary(rows)
    net_for_cap = reported.get("net_profit")
    if net_for_cap is None:
        net_for_cap = sum(t["net_profit"] for t in trades)
    initial_capital, cap_source = _initial_capital(reported, net_for_cap)

    recomputed, equity_curve, drawdown_curve, hist = _recompute(trades, initial_capital)
    monthly_grid, yearly = _monthly_yearly(trades)
    annual_reported = _parse_annual_reported(rows)

    times = [t["exit_time"] for t in trades if t["exit_time"]]
    meta = {
        "source": "tradestation",
        "name": name,
        "trade_count": len(trades),
        "first_trade_time": min(times) if times else None,
        "last_trade_time": max(times) if times else None,
        "initial_capital": initial_capital,
        "initial_capital_source": cap_source,
    }

    return {
        "meta": meta,
        "reported": reported,
        "recomputed": recomputed,
        "equity_curve": equity_curve,
        "drawdown_curve": drawdown_curve,
        "pnl_histogram": hist,
        "monthly_grid": monthly_grid,
        "yearly": yearly,
        "annual_reported": annual_reported,
        "trades": trades,
    }
