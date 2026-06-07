"""
Pull Databento CME futures history into the local parquet cache.

The .parquet data files are gitignored (not synced via git), so run this on any
machine to (re)fetch them — no frontend / web UI needed, just the backend deps
and your DATABENTO_API_KEY in backend/.env.

    python scripts/pull_databento.py                       # ES NQ CL GC, 1h, 2015 -> now
    python scripts/pull_databento.py --symbols ES NQ       # subset
    python scripts/pull_databento.py --timeframe 1h --start 2020-01-01
"""
from __future__ import annotations

import argparse
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))   # so `services...` imports resolve

# Load the API key from .env (backend first, then repo root).
try:
    from dotenv import load_dotenv
    load_dotenv(BACKEND / ".env")
    load_dotenv(ROOT / ".env")
except Exception:
    pass

import pandas as pd  # noqa: E402
from services import market_data  # noqa: E402
from services.brokers import databento  # noqa: E402


def pull(symbol: str, timeframe: str, start: datetime, end: datetime):
    """Download + idempotently merge into data/databento/{symbol}_{tf}.parquet."""
    bars = databento.download(symbol, start, end, timeframe)
    if bars.empty:
        return None, 0, 0
    path = market_data.parquet_path(symbol, timeframe, broker="databento")
    rows_before = 0
    if os.path.exists(path):
        existing = pd.read_parquet(path)
        rows_before = len(existing)
        bars = pd.concat([existing, bars], ignore_index=True)
    bars = bars.drop_duplicates(subset=["time"]).sort_values("time").reset_index(drop=True)
    bars.to_parquet(path, index=False)
    return path, len(bars), len(bars) - rows_before


def main():
    ap = argparse.ArgumentParser(description="Pull Databento CME futures into the parquet cache.")
    ap.add_argument("--symbols", nargs="+", default=["ES", "NQ", "CL", "GC"])
    ap.add_argument("--timeframe", default="1h")
    ap.add_argument("--start", default="2015-01-01", help="YYYY-MM-DD")
    ap.add_argument("--end", default=None, help="YYYY-MM-DD (default: now; auto-clamped to licensed end)")
    args = ap.parse_args()

    if not os.environ.get("DATABENTO_API_KEY"):
        print("ERROR: DATABENTO_API_KEY not set — add it to backend/.env first.")
        sys.exit(1)

    start = datetime.strptime(args.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end = (datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
           if args.end else datetime.now(timezone.utc))

    print(f"Pulling {args.symbols} {args.timeframe} {start.date()} -> {end.date()} from Databento...")
    for sym in args.symbols:
        try:
            path, total, added = pull(sym, args.timeframe, start, end)
            if path is None:
                print(f"  {sym:4} {args.timeframe}: no data returned")
            else:
                print(f"  {sym:4} {args.timeframe}: {total:>7} rows (+{added})  -> {path}")
        except Exception as e:  # noqa: BLE001
            print(f"  {sym:4} {args.timeframe}: FAILED — {e}")

    print("Done.")


if __name__ == "__main__":
    main()
