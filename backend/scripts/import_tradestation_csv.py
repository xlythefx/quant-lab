"""
CLI to parse TradeStation Strategy Performance Report CSVs into parquet.

Reads from backend/data/tradestation/*.csv and writes one parquet per CSV
to backend/data/tradestation/parsed/{strategy_slug}_{symbol}.parquet.

Example:
  python backend/scripts/import_tradestation_csv.py
  python backend/scripts/import_tradestation_csv.py --file "BD MD MOON ES TILL 25 APRIL.csv"
"""
import argparse
import os
import re
import sys
from pathlib import Path

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from services.tradestation_parser import parse_csv, write_parquet
from config import DATA_DIR


def _slug(s: str) -> str:
    s = re.sub(r"\s+", "_", s.strip())
    return re.sub(r"[^A-Za-z0-9_]+", "", s)


def main():
    ap = argparse.ArgumentParser(description="Parse TradeStation CSV exports → parquet.")
    ap.add_argument("--file", help="Single CSV filename (relative to data/tradestation/) — default: all CSVs")
    ap.add_argument("--src-dir", default=os.path.join(DATA_DIR, "tradestation"))
    ap.add_argument("--out-dir", default=os.path.join(DATA_DIR, "tradestation", "parsed"))
    args = ap.parse_args()

    src_dir = Path(args.src_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    if args.file:
        files = [src_dir / args.file]
    else:
        files = sorted(src_dir.glob("*.csv"))

    if not files:
        print(f"No CSV files in {src_dir}")
        return

    print(f"Parsing {len(files)} file(s) from {src_dir}\n")
    total_trades = 0
    failed = []
    for csv_path in files:
        try:
            df = parse_csv(csv_path)
        except Exception as e:
            print(f"  [FAIL] {csv_path.name}: {e}")
            failed.append(csv_path.name)
            continue

        if df.empty:
            print(f"  [WARN] {csv_path.name}: 0 trades parsed")
            continue

        strategy = df["strategy"].iloc[0] or "unknown"
        symbol = df["symbol"].iloc[0] or "X"
        out_name = f"{_slug(strategy)}_{symbol}.parquet"
        out_path = out_dir / out_name
        write_parquet(df, out_path)

        first = df["entry_dt"].min()
        last  = df["entry_dt"].max()
        net   = df["pnl"].sum()
        print(f"  [OK]   {csv_path.name}")
        print(f"          -> {out_path.name}  ({len(df)} trades, "
              f"{first.date()} to {last.date()}, net ${net:,.2f})")
        total_trades += len(df)

    print(f"\nDone. {total_trades:,} total trades parsed across {len(files) - len(failed)} file(s).")
    if failed:
        print(f"Failed: {failed}")


if __name__ == "__main__":
    main()
