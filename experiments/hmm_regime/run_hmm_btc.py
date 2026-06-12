"""
Entry point — Gaussian-HMM regime read of BTCUSDT, fully isolated.

Run:
    pip install -r experiments/hmm_regime/requirements-hmm.txt
    python experiments/hmm_regime/run_hmm_btc.py
    # options:
    python experiments/hmm_regime/run_hmm_btc.py --symbol BTCUSDT --timeframe 1h --states 2 3 4

Outputs (in experiments/hmm_regime/out/):
    hmm_regimes_k{K}.png   — price with regime ribbon + feature panels (the visual "read")
    hmm_bars.csv           — per-bar features, state per k, and confidence
    console report         — convergence, AIC/BIC, state tables, dwell, cross-tab vs deterministic

This NEVER mutates anything in backend/. It only READS market data and imports the
existing deterministic labels for an apples-to-apples comparison.
"""
from __future__ import annotations

import argparse
import os
import sys

import numpy as np
import pandas as pd

HERE = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.abspath(os.path.join(HERE, "..", ".."))
BACKEND = os.path.join(REPO, "backend")
OUT_DIR = os.path.join(HERE, "out")
for p in (HERE, BACKEND):
    if p not in sys.path:
        sys.path.insert(0, p)

import matplotlib
matplotlib.use("Agg")  # headless — write PNGs, no display
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

from features import FEATURE_NAMES, build_features
from hmm_model import fit_hmm

# Stable per-state colors (cool->warm == bear->bull after relabeling).
STATE_COLORS = ["#d62728", "#ff7f0e", "#7f7f7f", "#2ca02c", "#1f77b4"]


def load_btc(symbol: str, timeframe: str) -> pd.DataFrame:
    """Load OHLCV from the backend's parquet cache (read-only)."""
    from services import market_data
    try:
        df = market_data.load_parquet(symbol, timeframe)
    except FileNotFoundError:
        print(f"[data] {symbol} {timeframe} not cached — fetching via ensure_parquet ...")
        market_data.ensure_parquet(symbol, timeframe)
        df = market_data.load_parquet(symbol, timeframe)
    return df.reset_index(drop=True)


def deterministic_labels(df: pd.DataFrame) -> pd.Series:
    """Existing rule-based 5-regime labels, indexed by bar time (read-only import)."""
    from services.strategies.regime import _regime_labels, _regime_params
    labels = _regime_labels(df, _regime_params({}))
    return pd.Series(labels, index=df["time"].to_numpy())


def plot_run(feat: pd.DataFrame, res, symbol: str, timeframe: str, path: str):
    """Price with regime-shaded background + the three observation panels."""
    t = pd.to_datetime(feat["time"].to_numpy(), unit="s", utc=True)
    close = feat["close"].to_numpy()
    states = res.states
    k = res.n_states

    fig, axes = plt.subplots(
        4, 1, figsize=(15, 11), sharex=True,
        gridspec_kw={"height_ratios": [3, 1, 1, 1]},
    )
    ax_price, ax_trend, ax_vol, ax_h = axes

    # --- Regime ribbon: shade contiguous runs of the same state ---
    start = 0
    for i in range(1, len(states) + 1):
        if i == len(states) or states[i] != states[start]:
            s = int(states[start])
            for ax in axes:
                ax.axvspan(t[start], t[i - 1], color=STATE_COLORS[s % len(STATE_COLORS)], alpha=0.18, lw=0)
            start = i

    ax_price.plot(t, close, color="black", lw=0.8)
    ax_price.set_yscale("log")
    ax_price.set_ylabel("close (log)")
    ax_price.set_title(
        f"{symbol} {timeframe} — Gaussian HMM, k={k} states  "
        f"(AIC={res.aic:,.0f}  BIC={res.bic:,.0f}  converged={res.converged})"
    )
    legend = [
        Patch(facecolor=STATE_COLORS[s % len(STATE_COLORS)], alpha=0.4,
              label=f"S{s}: {res.labels[s]}  ({res.pct_time[s]*100:.0f}%)")
        for s in range(k)
    ]
    ax_price.legend(handles=legend, loc="upper left", fontsize=8, framealpha=0.9)

    ax_trend.plot(t, feat["trend"].to_numpy(), color="#333", lw=0.5)
    ax_trend.axhline(0, color="k", lw=0.5, ls=":")
    ax_trend.set_ylabel("trend (%/bar)")

    ax_vol.plot(t, feat["rv20"].to_numpy(), color="#8c564b", lw=0.6)
    ax_vol.set_ylabel("RV(20)")

    ax_h.plot(t, feat["hurst"].to_numpy(), color="#9467bd", lw=0.6)
    ax_h.axhline(0.5, color="k", lw=0.5, ls=":")
    ax_h.set_ylabel("Hurst")
    ax_h.set_xlabel("time (UTC)")

    fig.tight_layout()
    fig.savefig(path, dpi=110)
    plt.close(fig)


def print_report(res, det_aligned: pd.Series | None):
    """Console diagnostics for judging the read of one k."""
    k = res.n_states
    print(f"\n{'='*78}\n  k = {k} states   loglik={res.loglik:,.1f}   "
          f"AIC={res.aic:,.1f}   BIC={res.bic:,.1f}   converged={res.converged}\n{'='*78}")

    print(f"{'state':<6}{'label':<26}{'%time':>7}{'dwell':>8}   "
          + "  ".join(f"{n:>9}" for n in FEATURE_NAMES))
    for s in range(k):
        dwell = "inf" if not np.isfinite(res.dwell[s]) else f"{res.dwell[s]:.0f}"
        feats = "  ".join(f"{res.means[s, j]:>9.4f}" for j in range(len(FEATURE_NAMES)))
        print(f"S{s:<5}{res.labels[s]:<26}{res.pct_time[s]*100:>6.1f}%{dwell:>8}   {feats}")

    print("\n  transition matrix (rows = from, cols = to):")
    header = "        " + "".join(f"   ->S{j}" for j in range(k))
    print(header)
    for s in range(k):
        row = "".join(f"  {res.transmat[s, j]:.3f}" for j in range(k))
        print(f"    S{s} {row}")

    # --- Cross-tab vs deterministic 5-regime labels (read-only comparison) ---
    if det_aligned is not None:
        det = det_aligned.to_numpy()
        det_names = sorted(pd.unique(det))
        print("\n  HMM state vs deterministic 5-regime label (row-normalized %):")
        print("        " + "".join(f"{dn[:11]:>13}" for dn in det_names))
        for s in range(k):
            mask = res.states == s
            total = int(mask.sum())
            cells = []
            for dn in det_names:
                pct = 100.0 * np.sum(det[mask] == dn) / total if total else 0.0
                cells.append(f"{pct:>12.0f}%")
            print(f"    S{s} " + "".join(cells))


def main():
    ap = argparse.ArgumentParser(description="Gaussian-HMM regime read (isolated experiment)")
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--timeframe", default="1h")
    ap.add_argument("--states", type=int, nargs="+", default=[2, 3, 4, 5, 6])
    ap.add_argument("--trend-window", type=int, default=36)
    ap.add_argument("--rv-window", type=int, default=20)
    ap.add_argument("--hurst-window", type=int, default=250)
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()

    os.makedirs(OUT_DIR, exist_ok=True)

    print(f"[data] loading {args.symbol} {args.timeframe} ...")
    df = load_btc(args.symbol, args.timeframe)
    print(f"[data] {len(df)} bars  "
          f"{pd.to_datetime(df['time'].iloc[0], unit='s', utc=True)} -> "
          f"{pd.to_datetime(df['time'].iloc[-1], unit='s', utc=True)}")

    feat, X_scaled, _scaler = build_features(
        df, args.trend_window, args.rv_window, args.hurst_window)
    X_raw = feat[FEATURE_NAMES].to_numpy(dtype=float)
    print(f"[features] {len(feat)} usable bars after warmup "
          f"(trend_window={args.trend_window}, rv_window={args.rv_window}, "
          f"hurst_window={args.hurst_window})")

    # Deterministic labels aligned to the surviving feature bars (read-only).
    try:
        det_full = deterministic_labels(df)
        det_aligned = det_full.reindex(feat["time"].to_numpy())
    except Exception as e:  # never let the comparison break the experiment
        print(f"[warn] deterministic comparison unavailable: {e}")
        det_aligned = None

    csv = feat.copy()
    summary = []
    for k in args.states:
        res = fit_hmm(X_scaled, X_raw, n_states=k, seed=args.seed)
        csv[f"state_k{k}"] = res.states
        csv[f"label_k{k}"] = [res.labels[s] for s in res.states]
        csv[f"conf_k{k}"] = res.posteriors.max(axis=1)
        png = os.path.join(OUT_DIR, f"hmm_regimes_k{k}.png")
        plot_run(feat, res, args.symbol, args.timeframe, png)
        print_report(res, det_aligned)
        print(f"  -> plot: {png}")
        summary.append((k, res.aic, res.bic, res.converged))

    csv_path = os.path.join(OUT_DIR, "hmm_bars.csv")
    csv.to_csv(csv_path, index=False)

    print(f"\n{'='*78}\n  MODEL SELECTION (lower AIC/BIC = better-supported by the data)\n{'='*78}")
    print(f"{'k':>4}{'AIC':>14}{'BIC':>14}{'dAIC':>12}{'dBIC':>12}{'converged':>12}")
    prev_aic = prev_bic = None
    for k, aic, bic, conv in summary:
        d_aic = "" if prev_aic is None else f"{aic - prev_aic:>+12,.0f}"
        d_bic = "" if prev_bic is None else f"{bic - prev_bic:>+12,.0f}"
        print(f"{k:>4}{aic:>14,.0f}{bic:>14,.0f}{d_aic:>12}{d_bic:>12}{str(conv):>12}")
        prev_aic, prev_bic = aic, bic

    # --- Elbow plot: AIC & BIC vs k (look for where the drop flattens) ---
    ks = [s[0] for s in summary]
    fig, ax = plt.subplots(figsize=(8, 5))
    ax.plot(ks, [s[1] for s in summary], "o-", label="AIC")
    ax.plot(ks, [s[2] for s in summary], "s-", label="BIC")
    ax.set_xlabel("number of states (k)")
    ax.set_ylabel("information criterion (lower = better)")
    ax.set_title(f"{args.symbol} {args.timeframe} — HMM model selection")
    ax.set_xticks(ks)
    ax.legend()
    ax.grid(alpha=0.3)
    elbow_path = os.path.join(OUT_DIR, "model_selection.png")
    fig.tight_layout()
    fig.savefig(elbow_path, dpi=110)
    plt.close(fig)

    print(f"\n[out] per-bar CSV: {csv_path}")
    print(f"[out] elbow plot:  {elbow_path}")
    print("[note] Full-sample fit (look-ahead) — diagnostic read only, not tradeable as-is.")


if __name__ == "__main__":
    main()
