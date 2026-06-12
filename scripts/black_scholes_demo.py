"""
Black-Scholes fade-safety demo — friendly, runs on your real cached data.

This does NOT trade anything and does NOT touch your strategies. It just reads a
symbol's price history and prints a plain-English report on when the
VWMA-reversion idea is "safe to fade" vs walking into a tail move.

    python scripts/black_scholes_demo.py                      # BTCUSDT 15m (default)
    python scripts/black_scholes_demo.py --symbol BTCUSDT --timeframe 1h
    python scripts/black_scholes_demo.py --symbol ES --timeframe 1h --broker databento

Cached crypto symbols today: BTCUSDT, FETUSDT at 1m/5m/15m/1h.
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))   # so `services...` imports resolve

from services import market_data            # noqa: E402
from services import black_scholes as bs    # noqa: E402


def main():
    ap = argparse.ArgumentParser(description="Black-Scholes fade-safety report")
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--timeframe", default="15m")
    ap.add_argument("--broker", default=None, help="binance/databento/... (default: auto)")
    ap.add_argument("--vol-window", type=int, default=20,
                    help="bars used to measure volatility (default 20)")
    ap.add_argument("--n-sigma", type=float, default=1.0,
                    help="how many std-devs counts as a 'normal' move (default 1.0)")
    args = ap.parse_args()

    try:
        df = market_data.load_parquet(args.symbol, args.timeframe, broker=args.broker)
    except FileNotFoundError:
        print(f"No cached data for {args.symbol} {args.timeframe}. "
              f"Download it first (Downloads page or ensure_parquet).")
        return

    label = f"{args.symbol} {args.timeframe}"
    print()
    print(bs.summarize_fade_safety(df, vol_window=args.vol_window,
                                   n_sigma=args.n_sigma, label=label))
    print()


if __name__ == "__main__":
    main()
