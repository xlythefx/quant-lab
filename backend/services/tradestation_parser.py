"""
Parse TradeStation Strategy Performance Report CSVs into clean trade DataFrames.

A TS report CSV stacks several sections (Performance Summary, Efficiency
Analysis, Trades List, Periodical Returns ...). We only care about the
Trades List, which uses a paired entry+exit row format:

    1,Buy,4/6/2018 01:00,LE - Full Moon,$3339.25,$0.00,1,($1750.21),...
     ,Sell,4/6/2018 14:00,Stop Loss,$3304.25,,($1750.00),($1750.21),...

The entry row has the trade number; the exit row immediately follows with
an empty number column. parse_csv extracts this section, pairs the rows,
and returns a DataFrame with one row per round-trip trade.
"""
from __future__ import annotations

import io
import re
from pathlib import Path
from typing import Optional

import pandas as pd


TRADES_LIST_HEADER_PREFIX = "#,Type,Date/Time"

# Known futures tickers we expect in filenames like "BD MD MOON ES TILL 25 APRIL.csv"
_FUTURES_TICKERS = {
    "ES", "MES", "NQ", "MNQ", "YM", "MYM", "RTY",
    "CL", "MCL", "GC", "MGC", "SI", "HG", "NG", "HO", "RB", "PL",
    "EC", "JY", "BP", "AD", "CD", "SF",
    "S", "C", "W", "CT", "FC", "LC", "LH",
}


def _money(value) -> Optional[float]:
    """$2873.75 -> 2873.75 ; ($80.00) -> -80.00 ; '' / NaN -> None."""
    if value is None:
        return None
    if isinstance(value, float) and pd.isna(value):
        return None
    s = str(value).strip().replace(",", "").replace("$", "").replace(" ", "")
    if not s or s.lower() == "nan":
        return None
    neg = s.startswith("(") and s.endswith(")")
    s = s.strip("()").rstrip("%")
    try:
        v = float(s)
        return -v if neg else v
    except ValueError:
        return None


def _split_filename(name: str) -> tuple[str, Optional[str]]:
    """
    'BD MD MOON ES TILL 25 APRIL.csv' -> ('BD MD MOON', 'ES')
    'TF MD ORB ES TILL 25 APRIL.csv'  -> ('TF MD ORB', 'ES')
    Falls back to (stem, None) if no known ticker is found.
    """
    stem = Path(name).stem
    tokens = stem.split()
    for i, tok in enumerate(tokens):
        if tok.upper() in _FUTURES_TICKERS:
            strategy = " ".join(tokens[:i]).strip()
            return strategy or stem, tok.upper()
    return stem, None


def _extract_trades_list_block(text: str) -> Optional[str]:
    """
    Find the 'TradeStation Trades List' section and return it as a CSV string
    containing the header row + data rows only. Returns None if not found.
    """
    lines = text.splitlines()
    header_idx = None
    for i, ln in enumerate(lines):
        if ln.startswith(TRADES_LIST_HEADER_PREFIX):
            header_idx = i
            break
    if header_idx is None:
        return None

    out = [lines[header_idx]]
    for ln in lines[header_idx + 1:]:
        if not ln.strip():
            continue
        # The Trades List section ends when we hit a row that isn't a trade row.
        # Trade rows either start with a digit (entry: "1,Buy,...") or a comma
        # (exit: ",Sell,..."). Anything else marks the start of a new section
        # (e.g. "TradeStation Periodical Returns:Annual").
        first = ln.lstrip()[:1]
        if first.isdigit() or ln.startswith(","):
            out.append(ln)
        else:
            break
    return "\n".join(out)


def parse_csv(path: Path | str) -> pd.DataFrame:
    """
    Parse a TradeStation report CSV. Returns a DataFrame with one row per
    round-trip trade. Strategy and symbol are inferred from the filename.

    Columns:
      strategy, symbol, trade_num, side, qty,
      entry_dt, entry_price, entry_signal,
      exit_dt, exit_price, exit_signal,
      pnl, pct_profit, runup, drawdown, efficiency, total_eff,
      commission, slippage
    """
    path = Path(path)
    text = path.read_text(encoding="utf-8-sig", errors="replace")

    block = _extract_trades_list_block(text)
    if block is None:
        raise ValueError(f"No 'Trades List' section found in {path.name}")

    df = pd.read_csv(io.StringIO(block), dtype=str, keep_default_na=False)

    strategy, symbol = _split_filename(path.name)

    trades = []
    rows = df.to_dict(orient="records")
    i = 0
    while i < len(rows):
        entry = rows[i]
        trade_num_raw = entry.get("#", "").strip()
        if not trade_num_raw:
            i += 1  # orphaned exit row — skip
            continue

        exit_row = None
        if i + 1 < len(rows) and not rows[i + 1].get("#", "").strip():
            exit_row = rows[i + 1]
            i += 2
        else:
            i += 1  # entry with no exit (position still open at end of file)

        # TS entry types: "Buy" -> long, "Sell Short" / "Short" -> short.
        # (Exit rows use "Sell" / "Buy to Cover" but never appear as entries here.)
        side_word = entry.get("Type", "").strip().lower()
        if side_word == "buy":
            side = "long"
        elif side_word in ("sell short", "short"):
            side = "short"
        else:
            side = side_word

        qty = _money(entry.get("Shares/Ctrts - Profit/Loss"))
        # Entry-row qty is a plain integer; if it parsed as a parenthesised
        # negative (i.e. it was actually a P/L value), drop it.
        if qty is not None and qty < 0:
            qty = None

        trades.append({
            "strategy":     strategy,
            "symbol":       symbol,
            "trade_num":    int(trade_num_raw) if trade_num_raw.isdigit() else None,
            "side":         side,
            "qty":          qty,
            "entry_dt":     pd.to_datetime(entry.get("Date/Time"), errors="coerce"),
            "entry_price":  _money(entry.get("Price")),
            "entry_signal": (entry.get("Signal") or "").strip() or None,
            "exit_dt":      pd.to_datetime(exit_row.get("Date/Time"), errors="coerce") if exit_row else pd.NaT,
            "exit_price":   _money(exit_row.get("Price")) if exit_row else None,
            "exit_signal":  ((exit_row.get("Signal") or "").strip() or None) if exit_row else None,
            "pnl":          _money(exit_row.get("Shares/Ctrts - Profit/Loss")) if exit_row else None,
            "pct_profit":   _money(entry.get("% Profit")),
            "runup":        _money(entry.get("Run-up/Drawdown")),
            "drawdown":     _money(exit_row.get("Run-up/Drawdown")) if exit_row else None,
            "efficiency":   _money(entry.get("Efficiency")),
            "total_eff":    _money(exit_row.get("Total Eff.")) if exit_row else None,
            "commission":   _money(entry.get("Comm.")),
            "slippage":     _money(entry.get("Slippage")),
        })

    out = pd.DataFrame(trades)
    if not out.empty:
        out = out.sort_values("entry_dt").reset_index(drop=True)
    return out


def write_parquet(df: pd.DataFrame, out_path: Path | str) -> None:
    """Write a parsed trades DataFrame to parquet."""
    out_path = Path(out_path)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(out_path, index=False)
