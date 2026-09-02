"""
Honest-numbers report on the Binance perpetual funding carry.

The trade being measured: hold $N of spot and short $N of the perp, so the
price exposure cancels out. Every funding settlement you receive
`notional * funding_rate` (and PAY it when the rate is negative). There is no
price prediction anywhere in this — the return series IS the published funding
rate.

Run (after pull_funding.py):
    python experiments/funding_carry/study_funding.py
    python experiments/funding_carry/study_funding.py --symbols BTCUSDT --lookback 21 --cost-bps 30

Outputs (experiments/funding_carry/out/):
    funding_carry_{SYMBOL}.png   — funding rate over time + equity curves
    funding_summary.csv          — per-symbol, per-year figures
    console report               — the numbers that decide go / no-go

Two variants are measured:

  ALWAYS-ON   hold the carry continuously. One entry, one exit, so costs are
              negligible — but you eat every negative-funding stretch.

  SWITCHED    hold only while the trailing mean funding rate is positive.
              Strictly causal: the decision for event i uses events <= i-1.
              Each re-entry pays a full round trip of costs.

What matters is not the headline yield. It is the WORST NEGATIVE STRETCH and
the drawdown: those tell you whether this is a steady yield or a trap that
pays for two years and then takes it back.

Isolation: reads only experiments/funding_carry/data/. Never touches backend/.
"""
from __future__ import annotations

import argparse
import os
from datetime import datetime, timezone

import numpy as np
import pandas as pd

import matplotlib
matplotlib.use("Agg")  # headless — write PNGs, no display
import matplotlib.pyplot as plt

HERE = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(HERE, "data")
OUT_DIR = os.path.join(HERE, "out")

HOURS_PER_YEAR = 24 * 365.25


# ---------------------------------------------------------------- formatting

def fmt_num(v: float, dp: int = 2) -> str:
    """132,312.00 — the project's number convention."""
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "n/a"
    return f"{v:,.{dp}f}"


def fmt_pct(v: float, signed: bool = True) -> str:
    """+3.46% / -1.20%"""
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "n/a"
    return f"{v:+,.2f}%" if signed else f"{v:,.2f}%"


def fmt_date(epoch_s) -> str:
    """Mon DD, YYYY"""
    return datetime.fromtimestamp(int(epoch_s), tz=timezone.utc).strftime("%b %d, %Y")


# ------------------------------------------------------------------- metrics

def equity_curve(returns: pd.Series) -> pd.Series:
    """Compound the per-event returns. Assumes the position is rescaled to
    equity — the standard convention, and it keeps the numbers comparable to
    every other return series in the project."""
    return (1.0 + returns).cumprod()


def max_drawdown_pct(eq: pd.Series) -> float:
    """Worst peak-to-trough fall, in percent."""
    peak = eq.cummax()
    return float(((eq / peak) - 1.0).min() * 100.0)


def longest_underwater_days(eq: pd.Series, hours: pd.Series) -> float:
    """Longest stretch between an equity peak and its recovery, in days.

    This is the number that hurts in practice: not how deep the loss was, but
    how long you sat there wondering whether the trade was broken."""
    peak = eq.cummax()
    underwater = eq < peak
    worst = run = 0.0
    for wet, h in zip(underwater.to_numpy(), hours.to_numpy()):
        run = run + (h / 24.0) if wet else 0.0
        worst = max(worst, run)
    return float(worst)


def longest_negative_run_days(rates: pd.Series, hours: pd.Series) -> float:
    """Longest unbroken run of negative funding, in days — the stretch where
    you would have been paying the crowd instead of collecting from it."""
    worst = run = 0.0
    for r, h in zip(rates.to_numpy(), hours.to_numpy()):
        run = run + (h / 24.0) if r < 0 else 0.0
        worst = max(worst, run)
    return float(worst)


def apr_pct(eq_final: float, total_hours: float) -> float:
    """Annualised percentage rate implied by the compounded total."""
    if total_hours <= 0 or eq_final <= 0:
        return float("nan")
    years = total_hours / HOURS_PER_YEAR
    return float((eq_final ** (1.0 / years) - 1.0) * 100.0)


# ------------------------------------------------------------------ variants

def build_variants(df: pd.DataFrame, lookback: int, cost_bps: float) -> pd.DataFrame:
    """Attach the ALWAYS-ON and SWITCHED return series to the frame."""
    d = df.copy()
    rate = d["funding_rate"]

    # As the short leg you RECEIVE positive funding, so the carry return is
    # simply the published rate.
    d["ret_always"] = rate

    # Causal signal: mean of the last `lookback` events, shifted so event i
    # never sees its own rate. Positive -> the crowd is paying, so hold.
    signal = rate.rolling(lookback).mean().shift(1)
    hold = (signal > 0).fillna(False)
    entered = hold & ~hold.shift(1, fill_value=False)

    cost = cost_bps / 10_000.0  # full round trip: both legs, in and out
    d["hold"] = hold
    d["ret_switched"] = np.where(hold, rate, 0.0) - np.where(entered, cost, 0.0)
    d["_entries"] = entered
    return d


# ------------------------------------------------------------------ reporting

def per_year_rows(symbol: str, d: pd.DataFrame) -> list[dict]:
    """Calendar-year breakdown — the consistency check."""
    year = pd.to_datetime(d["time"], unit="s", utc=True).dt.year
    rows = []
    for y, g in d.groupby(year):
        rows.append({
            "symbol": symbol,
            "year": int(y),
            "events": len(g),
            "always_pct": float((equity_curve(g["ret_always"]).iloc[-1] - 1.0) * 100.0),
            "switched_pct": float((equity_curve(g["ret_switched"]).iloc[-1] - 1.0) * 100.0),
            "pct_events_negative": float((g["funding_rate"] < 0).mean() * 100.0),
            "days_held_pct": float(g["hold"].mean() * 100.0),
        })
    return rows


def report(symbol: str, d: pd.DataFrame, lookback: int, cost_bps: float) -> list[dict]:
    hours = d["interval_hours"]
    total_hours = float(hours.sum())

    eq_a = equity_curve(d["ret_always"])
    eq_s = equity_curve(d["ret_switched"])

    print("")
    print("=" * 72)
    print(f"  {symbol} — perpetual funding carry (delta-neutral)")
    print("=" * 72)
    print(f"  Period            {fmt_date(d['time'].iloc[0])} – {fmt_date(d['time'].iloc[-1])}")
    print(f"  Funding events    {len(d):,}  (~{fmt_num(total_hours / 24 / 365.25, 2)} years)")
    print(f"  Negative events   {fmt_pct((d['funding_rate'] < 0).mean() * 100, False)} of the time")
    print(f"  Mean rate/event   {fmt_pct(d['funding_rate'].mean() * 100, False)}")
    print("")
    print(f"  ALWAYS-ON — hold continuously")
    print(f"    Total return      {fmt_pct((eq_a.iloc[-1] - 1) * 100)}")
    print(f"    APR               {fmt_pct(apr_pct(float(eq_a.iloc[-1]), total_hours))}")
    print(f"    Max drawdown      {fmt_pct(max_drawdown_pct(eq_a))}")
    print(f"    Longest underwater{fmt_num(longest_underwater_days(eq_a, hours), 1):>12} days")
    print(f"    Worst negative run{fmt_num(longest_negative_run_days(d['funding_rate'], hours), 1):>12} days")
    print("")
    print(f"  SWITCHED — hold only while trailing {lookback}-event mean > 0, "
          f"{fmt_num(cost_bps, 0)}bp round trip")
    print(f"    Total return      {fmt_pct((eq_s.iloc[-1] - 1) * 100)}")
    print(f"    APR               {fmt_pct(apr_pct(float(eq_s.iloc[-1]), total_hours))}")
    print(f"    Max drawdown      {fmt_pct(max_drawdown_pct(eq_s))}")
    print(f"    Longest underwater{fmt_num(longest_underwater_days(eq_s, hours), 1):>12} days")
    print(f"    Time in position  {fmt_pct(d['hold'].mean() * 100, False)}")
    print(f"    Round trips       {int(d['_entries'].sum()):,}  "
          f"(costing {fmt_pct(int(d['_entries'].sum()) * cost_bps / 100.0, False)} in total)")
    print("")

    rows = per_year_rows(symbol, d)
    print("  By calendar year")
    print(f"    {'year':<6}{'events':>8}{'always':>11}{'switched':>11}{'neg events':>13}{'in mkt':>9}")
    for r in rows:
        print(f"    {r['year']:<6}{r['events']:>8,}"
              f"{fmt_pct(r['always_pct']):>11}{fmt_pct(r['switched_pct']):>11}"
              f"{fmt_pct(r['pct_events_negative'], False):>13}"
              f"{fmt_pct(r['days_held_pct'], False):>9}")
    return rows


def plot(symbol: str, d: pd.DataFrame, path: str) -> None:
    t = pd.to_datetime(d["time"].to_numpy(), unit="s", utc=True)
    eq_a = equity_curve(d["ret_always"])
    eq_s = equity_curve(d["ret_switched"])

    fig, (ax1, ax2) = plt.subplots(2, 1, figsize=(13, 8), sharex=True,
                                   gridspec_kw={"height_ratios": [1, 1.4]})

    ax1.axhline(0, color="#888", lw=0.8)
    ax1.plot(t, d["funding_rate"] * 100, lw=0.4, color="#1f77b4")
    ax1.fill_between(t, 0, d["funding_rate"] * 100,
                     where=(d["funding_rate"] < 0), color="#d62728", alpha=0.5,
                     label="negative (you pay)")
    ax1.set_ylabel("funding rate per event (%)")
    ax1.set_title(f"{symbol} — perpetual funding rate")
    ax1.legend(loc="upper right", fontsize=8)

    ax2.plot(t, (eq_a - 1) * 100, lw=1.4, color="#7f7f7f", label="always-on")
    ax2.plot(t, (eq_s - 1) * 100, lw=1.4, color="#2ca02c", label="switched (after costs)")
    ax2.axhline(0, color="#888", lw=0.8)
    ax2.set_ylabel("cumulative carry (%)")
    ax2.set_title("Delta-neutral carry — no price exposure")
    ax2.legend(loc="upper left", fontsize=8)

    fig.tight_layout()
    fig.savefig(path, dpi=120)
    plt.close(fig)


def main() -> None:
    ap = argparse.ArgumentParser(description="Funding-carry honest-numbers report.")
    ap.add_argument("--symbols", nargs="+", default=["BTCUSDT", "ETHUSDT"])
    ap.add_argument("--lookback", type=int, default=21,
                    help="funding events in the trailing mean (21 ~= 7 days at 8h)")
    ap.add_argument("--cost-bps", type=float, default=30.0,
                    help="round-trip cost on BOTH legs, in basis points "
                         "(spot taker 10bp + perp taker 5bp, in and out)")
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)
    all_rows: list[dict] = []

    for symbol in args.symbols:
        path = os.path.join(DATA_DIR, f"{symbol}_funding.parquet")
        if not os.path.exists(path):
            print(f"[skip] {symbol}: no data — run pull_funding.py first ({path})")
            continue
        df = pd.read_parquet(path).sort_values("time").reset_index(drop=True)
        d = build_variants(df, args.lookback, args.cost_bps)
        all_rows += report(symbol, d, args.lookback, args.cost_bps)

        png = os.path.join(OUT_DIR, f"funding_carry_{symbol}.png")
        plot(symbol, d, png)
        print(f"\n  -> {png}")

    if all_rows:
        csv = os.path.join(OUT_DIR, "funding_summary.csv")
        pd.DataFrame(all_rows).to_csv(csv, index=False)
        print(f"  -> {csv}")


if __name__ == "__main__":
    main()
