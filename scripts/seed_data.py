"""
Seed the local parquet cache with Binance crypto history.

The .parquet data files are gitignored (not synced via git), so a fresh clone
has no candles to backtest. Run this once after cloning — it downloads the full
history for every research symbol straight from Binance via CCXT. No API key
and no account are needed; Binance's public OHLCV endpoint is open.

    python scripts/seed_data.py                        # all symbols, 15m, full history
    python scripts/seed_data.py --symbols BTCUSDT ETHUSDT
    python scripts/seed_data.py --timeframe 1h --start 2020-01-01
    python scripts/seed_data.py --force                # re-download even if cached

Each symbol starts from its Binance listing date, so `--start 2017-01-01`
simply means "as far back as Binance will go". Expect roughly 30-60 minutes
and ~140 MB for the full default run — the download is rate-limited on
purpose so Binance doesn't throttle you. Re-running is cheap: cached symbols
are skipped, and `download_range` merges new bars into the existing file.
"""
from __future__ import annotations

import argparse
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))   # so `services...` imports resolve

import pandas as pd  # noqa: E402
from services import market_data  # noqa: E402

# The symbols this project researches on. Matches the maintainer's local cache
# so a fresh clone can reproduce the backtests and walk-forward runs.
DEFAULT_SYMBOLS = [
    "AAVEUSDT", "ADAUSDT", "ATOMUSDT", "AVAXUSDT", "BCHUSDT", "BICOUSDT",
    "BTCUSDT", "CRVUSDT", "DOTUSDT", "ETHUSDT", "FETUSDT", "FLOWUSDT",
    "GRTUSDT", "HBARUSDT", "ICPUSDT", "INJUSDT", "LTCUSDT", "OPUSDT",
    "RENDERUSDT", "SOLUSDT", "STXUSDT", "SUNUSDT", "TRXUSDT", "UNIUSDT",
    "XRPUSDT", "ZECUSDT",
]


def _describe(path: str) -> str:
    """Row count + date span of an existing parquet, for the skip message."""
    df = pd.read_parquet(path, columns=["time"])
    if df.empty:
        return "0 rows"
    first = datetime.fromtimestamp(int(df["time"].min()), timezone.utc).date()
    last = datetime.fromtimestamp(int(df["time"].max()), timezone.utc).date()
    return f"{len(df):,} rows  {first} -> {last}"


def main():
    ap = argparse.ArgumentParser(
        description="Download Binance crypto history into the local parquet cache."
    )
    ap.add_argument("--symbols", nargs="+", default=DEFAULT_SYMBOLS)
    ap.add_argument("--timeframe", default="15m", help="15m (default), 1h, 1m, ...")
    ap.add_argument("--start", default="2017-01-01",
                    help="YYYY-MM-DD; clamped to each symbol's listing date")
    ap.add_argument("--end", default=None, help="YYYY-MM-DD (default: now)")
    ap.add_argument("--force", action="store_true",
                    help="re-download symbols that are already cached")
    args = ap.parse_args()

    start = datetime.strptime(args.start, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    end = (datetime.strptime(args.end, "%Y-%m-%d").replace(tzinfo=timezone.utc)
           if args.end else datetime.now(timezone.utc))
    start_ms = int(start.timestamp() * 1000)
    end_ms = int(end.timestamp() * 1000)

    total = len(args.symbols)
    print(f"Seeding {total} symbol(s) at {args.timeframe}, "
          f"{start.date()} -> {end.date()} from Binance.")
    print("Cached symbols are skipped (pass --force to re-download).\n")

    downloaded = skipped = failed = 0
    t0 = time.time()

    for i, sym in enumerate(args.symbols, 1):
        label = f"[{i}/{total}] {sym:<11} {args.timeframe}"
        path = market_data.parquet_path(sym, args.timeframe)

        if os.path.exists(path) and not args.force:
            print(f"{label}: cached  ({_describe(path)})")
            skipped += 1
            continue

        try:
            res = market_data.download_range(sym, args.timeframe, start_ms, end_ms)
            first = datetime.fromtimestamp(res["first_time"], timezone.utc).date()
            last = datetime.fromtimestamp(res["last_time"], timezone.utc).date()
            print(f"{label}: {res['rows_total']:>9,} rows (+{res['rows_added']:,})  "
                  f"{first} -> {last}")
            downloaded += 1
        except KeyboardInterrupt:
            print("\nInterrupted. Partial downloads were merged — re-run to continue.")
            sys.exit(1)
        except Exception as e:  # noqa: BLE001
            print(f"{label}: FAILED - {e}")
            failed += 1

    mins = (time.time() - t0) / 60
    print(f"\nDone in {mins:.1f} min - {downloaded} downloaded, "
          f"{skipped} already cached, {failed} failed.")
    if failed:
        print("Re-run the script to retry the failures; cached symbols are skipped.")


if __name__ == "__main__":
    main()
