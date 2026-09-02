"""
Download Binance USDⓈ-M perpetual funding-rate history -> parquet.

Run:
    python experiments/funding_carry/pull_funding.py
    python experiments/funding_carry/pull_funding.py --symbols BTCUSDT ETHUSDT --since 2019-09-01

Writes experiments/funding_carry/data/{SYMBOL}_funding.parquet with columns:
    time            int seconds  — UTC instant the funding was settled
    funding_rate    float        — 0.0001 == 0.01%, paid BY longs TO shorts when positive
    mark_price      float        — mark price at settlement (reference only)
    interval_hours  float        — hours since the previous funding event

Two notes on the design:

1. `interval_hours` is measured from the timestamps themselves rather than read
   from /fapi/v1/fundingInfo. That endpoint reports only the CURRENT interval,
   and Binance has moved pairs from 8h to 4h partway through their life. Using
   today's interval to annualise a 7-year history would silently double or
   halve the yield for those pairs.

2. The endpoint is public — no API key, no signing. This talks to
   fapi.binance.com, which is a DIFFERENT host to the spot client in
   backend/services/market_data.py; funding does not exist on spot.

Isolation: this script only writes into experiments/funding_carry/data/ and
never imports or mutates anything under backend/.
"""
from __future__ import annotations

import argparse
import os
import time
from datetime import datetime, timezone

import ccxt
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")

# USDⓈ-M (linear) futures client. enableRateLimit keeps us under the shared
# 500-requests/5min/IP budget on /fapi/v1/fundingRate.
_exchange = ccxt.binanceusdm({"enableRateLimit": True, "timeout": 20000})

_QUOTES = ("USDT", "USDC", "BUSD", "FDUSD", "TUSD", "BNB", "BTC", "ETH")

MAX_LIMIT = 1000  # per-call cap on /fapi/v1/fundingRate


def _fmt_date(epoch_s: int) -> str:
    """Mon DD, YYYY — the project's display convention."""
    return datetime.fromtimestamp(int(epoch_s), tz=timezone.utc).strftime("%b %d, %Y")


def to_perp_symbol(symbol: str) -> str:
    """BTCUSDT -> BTC/USDT:USDT (CCXT's linear-perpetual notation)."""
    s = symbol.upper()
    for q in sorted(_QUOTES, key=len, reverse=True):
        if s.endswith(q) and len(s) > len(q):
            return f"{s[:-len(q)]}/{q}:{q}"
    raise ValueError(f"cannot parse symbol {symbol!r} into a perp pair")


def fetch_funding_history(symbol: str, since_ms: int) -> pd.DataFrame:
    """Page through the full funding history from `since_ms` to now."""
    pair = to_perp_symbol(symbol)
    rows: list[dict] = []
    cursor = since_ms

    while True:
        try:
            batch = _exchange.fetch_funding_rate_history(pair, since=cursor, limit=MAX_LIMIT)
        except (ccxt.NetworkError, ccxt.ExchangeError) as e:
            print(f"  [warn] {symbol}: {e} — retrying once in 3s")
            time.sleep(3)
            batch = _exchange.fetch_funding_rate_history(pair, since=cursor, limit=MAX_LIMIT)

        if not batch:
            break

        for ev in batch:
            info = ev.get("info") or {}
            mark = info.get("markPrice")
            rows.append({
                "time": int(ev["timestamp"] // 1000),
                "funding_rate": float(ev["fundingRate"]),
                # markPrice is blank on some early records -> NaN. The study
                # works off the rate alone, so this is reference data only.
                "mark_price": float(mark) if mark not in (None, "", "0") else float("nan"),
            })

        last = int(batch[-1]["timestamp"])
        print(f"  ... {len(rows):,} events, through {_fmt_date(last // 1000)}")
        # Short batch == we reached the end; non-advancing cursor == guard
        # against an endpoint that keeps handing back the same page.
        if len(batch) < MAX_LIMIT or last <= cursor:
            break
        cursor = last + 1

    if not rows:
        return pd.DataFrame(columns=["time", "funding_rate", "mark_price", "interval_hours"])

    df = (
        pd.DataFrame(rows)
        .drop_duplicates(subset="time")
        .sort_values("time")
        .reset_index(drop=True)
    )
    # Measured, not assumed — see module docstring.
    df["interval_hours"] = (df["time"].diff() / 3600.0).bfill().round(2)
    return df


def summarise(symbol: str, df: pd.DataFrame) -> None:
    """One-line sanity read so a bad download is obvious immediately."""
    if df.empty:
        print(f"  {symbol}: NO DATA")
        return
    intervals = df["interval_hours"].value_counts().head(3)
    mix = ", ".join(f"{h:g}h x {n:,}" for h, n in intervals.items())
    print(
        f"  {symbol}: {len(df):,} events | "
        f"{_fmt_date(df['time'].iloc[0])} – {_fmt_date(df['time'].iloc[-1])} | "
        f"intervals: {mix}"
    )


def main() -> None:
    ap = argparse.ArgumentParser(description="Pull Binance perp funding-rate history.")
    ap.add_argument("--symbols", nargs="+", default=["BTCUSDT", "ETHUSDT"])
    ap.add_argument("--since", default="2019-09-01", help="YYYY-MM-DD (BTC perp starts Sep 2019)")
    args = ap.parse_args()

    since_ms = int(datetime.strptime(args.since, "%Y-%m-%d")
                   .replace(tzinfo=timezone.utc).timestamp() * 1000)
    os.makedirs(DATA_DIR, exist_ok=True)

    for symbol in args.symbols:
        print(f"[pull] {symbol} from {_fmt_date(since_ms // 1000)} ...")
        df = fetch_funding_history(symbol, since_ms)
        if df.empty:
            print(f"  {symbol}: nothing returned — skipping write")
            continue
        path = os.path.join(DATA_DIR, f"{symbol}_funding.parquet")
        df.to_parquet(path, index=False)
        summarise(symbol, df)
        print(f"  -> {path}")


if __name__ == "__main__":
    main()
