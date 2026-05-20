"""
CLI to download Dukascopy historical bars into the Stage 1 broker namespace.

Example:
  python backend/scripts/download_dukascopy.py XAUUSD --tf 15m --from 2024-01-01 --to 2025-01-01

Output goes to backend/data/dukascopy/{SYMBOL}_{TF}.parquet, where Quantlab's
list_datasets() will pick it up automatically and the Dashboard / Walk-Forward /
etc. will see XAUUSD as a tradable symbol with broker=dukascopy /
asset_class=commodity (per backend/data/assets/dukascopy.json).
"""
import argparse
import logging
import os
import sys
from datetime import datetime, timezone

# Resolve imports when running this file directly (without -m).
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from services.brokers import dukascopy
from config import DATA_DIR


def _parse_date(s: str) -> datetime:
    # Accept YYYY-MM-DD only — keep it simple. Treat as 00:00 UTC.
    try:
        return datetime.strptime(s, "%Y-%m-%d").replace(tzinfo=timezone.utc)
    except ValueError as e:
        raise argparse.ArgumentTypeError(f"bad date {s!r}, expected YYYY-MM-DD") from e


def main():
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s :: %(message)s")
    ap = argparse.ArgumentParser(description="Download Dukascopy historical bars.")
    ap.add_argument("symbol", help="e.g. XAUUSD, EURUSD")
    ap.add_argument("--tf", required=True, choices=["1m", "5m", "15m", "30m", "1h", "4h", "1d"],
                    help="timeframe for aggregation")
    ap.add_argument("--from", dest="start", type=_parse_date, required=True, help="YYYY-MM-DD (UTC)")
    ap.add_argument("--to",   dest="end",   type=_parse_date, required=True, help="YYYY-MM-DD (UTC, exclusive)")
    ap.add_argument("--workers", type=int, default=16, help="concurrent downloads (default 16; HTTP/2 multiplexes them over a small connection pool, with 503/429 retry)")
    args = ap.parse_args()

    out_dir = os.path.join(DATA_DIR, "dukascopy")

    def progress(done, total):
        pct = 100.0 * done / max(1, total)
        print(f"  [{done:>6}/{total:<6}]  {pct:5.1f}%", flush=True)

    print(f"Downloading {args.symbol} {args.tf} from {args.start.date()} to {args.end.date()}")
    print(f"  workers={args.workers}, output={out_dir}/{args.symbol}_{args.tf}.parquet")
    meta = dukascopy.download_to_parquet(
        symbol=args.symbol,
        timeframe=args.tf,
        start=args.start,
        end=args.end,
        out_dir=out_dir,
        workers=args.workers,
        progress_cb=progress,
    )
    print()
    print(f"Wrote {meta['rows']:,} bars to {meta['path']}")
    print(f"  first bar: {datetime.utcfromtimestamp(meta['first_time']).isoformat()}Z")
    print(f"  last  bar: {datetime.utcfromtimestamp(meta['last_time']).isoformat()}Z")


if __name__ == "__main__":
    main()
