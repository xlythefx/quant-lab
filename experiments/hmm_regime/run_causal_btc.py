"""
Causal HMM regime read of BTCUSDT, compared against the full-sample fit.

Run:
    python experiments/hmm_regime/run_causal_btc.py
    python experiments/hmm_regime/run_causal_btc.py --states 4 --refit-every 720 --train-window 8760

Shows how much the honest (look-ahead-free) labeling differs from the full-sample
one: agreement %, extra flicker, and a side-by-side ribbon plot. This is the read to
judge before wiring the HMM into the Market Lab UI.

Outputs in experiments/hmm_regime/out/:
    causal_vs_fullsample_k{K}.png   — two price+ribbon panels + causal confidence
    causal_bars.csv                 — per-bar causal state, full-sample state, confidence
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
matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib.patches import Patch

from features import FEATURE_NAMES, build_features
from hmm_model import fit_hmm
from causal_hmm import causal_labels, state_signatures, switch_count

STATE_COLORS = ["#d62728", "#ff7f0e", "#7f7f7f", "#2ca02c", "#1f77b4", "#9467bd"]


def load_btc(symbol, timeframe):
    from services import market_data
    try:
        df = market_data.load_parquet(symbol, timeframe)
    except FileNotFoundError:
        market_data.ensure_parquet(symbol, timeframe)
        df = market_data.load_parquet(symbol, timeframe)
    return df.reset_index(drop=True)


def empirical_dwell(states, n_states):
    """Average run length per state over labeled bars."""
    s = states[states >= 0]
    out = np.zeros(n_states)
    counts = np.zeros(n_states)
    if s.size == 0:
        return out
    start = 0
    for i in range(1, len(s) + 1):
        if i == len(s) or s[i] != s[start]:
            lab = s[start]
            out[lab] += (i - start)
            counts[lab] += 1
            start = i
    return np.where(counts > 0, out / np.maximum(counts, 1), 0.0)


def shade(ax, t, states, k):
    start = 0
    for i in range(1, len(states) + 1):
        if i == len(states) or states[i] != states[start]:
            s = int(states[start])
            if s >= 0:
                ax.axvspan(t[start], t[i - 1], color=STATE_COLORS[s % len(STATE_COLORS)], alpha=0.20, lw=0)
            start = i


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--symbol", default="BTCUSDT")
    ap.add_argument("--timeframe", default="1h")
    ap.add_argument("--states", type=int, default=4)
    ap.add_argument("--trend-window", type=int, default=36)
    ap.add_argument("--rv-window", type=int, default=20)
    ap.add_argument("--hurst-window", type=int, default=250)
    ap.add_argument("--train-window", type=int, default=8760)   # ~1yr of 1h bars
    ap.add_argument("--refit-every", type=int, default=720)      # ~monthly
    ap.add_argument("--warmup", type=int, default=2160)          # ~3mo before first fit
    ap.add_argument("--expanding", action="store_true")
    ap.add_argument("--seed", type=int, default=42)
    args = ap.parse_args()
    os.makedirs(OUT_DIR, exist_ok=True)
    k = args.states

    print(f"[data] loading {args.symbol} {args.timeframe} ...")
    df = load_btc(args.symbol, args.timeframe)
    feat, X_scaled, _ = build_features(df, args.trend_window, args.rv_window, args.hurst_window)
    F = feat[FEATURE_NAMES].to_numpy(dtype=float)
    print(f"[features] {len(feat)} usable bars")

    # --- Full-sample reference (look-ahead) ---
    full = fit_hmm(X_scaled, F, n_states=k, seed=args.seed)

    # --- Causal labeling ---
    print(f"[causal] rolling refit: train_window={args.train_window}, "
          f"refit_every={args.refit_every}, warmup={args.warmup}, "
          f"expanding={args.expanding}")
    cz = causal_labels(F, n_states=k, train_window=args.train_window,
                       refit_every=args.refit_every, warmup=args.warmup,
                       expanding=args.expanding, seed=args.seed)
    cstates = cz["states"]
    cmeans, cstds, cpct, clabels = state_signatures(F, cstates, k)
    cdwell = empirical_dwell(cstates, k)

    # --- Agreement (over causal-labeled bars) ---
    labeled = cstates >= 0
    agree = float(np.mean(cstates[labeled] == full.states[labeled])) if labeled.any() else 0.0
    full_sw = switch_count(full.states)
    causal_sw = switch_count(cstates)

    # --- Report ---
    print(f"\n{'='*74}\n  CAUSAL HMM read (k={k})   {cz['n_refits']} refits   "
          f"labeled bars={int(labeled.sum())}/{len(feat)}\n{'='*74}")
    print(f"{'state':<6}{'label':<26}{'%time':>7}{'dwell':>8}   "
          + "  ".join(f"{n:>9}" for n in FEATURE_NAMES))
    for s in range(k):
        feats = "  ".join(f"{cmeans[s, j]:>9.4f}" for j in range(len(FEATURE_NAMES)))
        print(f"S{s:<5}{clabels[s]:<26}{cpct[s]*100:>6.1f}%{cdwell[s]:>8.0f}   {feats}")

    print(f"\n  agreement with full-sample labels : {agree*100:.1f}%")
    print(f"  regime switches  full-sample={full_sw}   causal={causal_sw}  "
          f"(causal flickers {causal_sw/max(full_sw,1):.1f}x more)")

    # --- Plot: causal ribbon vs full-sample ribbon + causal confidence ---
    t = pd.to_datetime(feat["time"].to_numpy(), unit="s", utc=True)
    close = feat["close"].to_numpy()
    conf = np.nanmax(cz["posteriors"], axis=1)

    fig, (axc, axf, axp) = plt.subplots(
        3, 1, figsize=(15, 9), sharex=True, gridspec_kw={"height_ratios": [3, 3, 1]})

    shade(axc, t, cstates, k)
    axc.plot(t, close, color="black", lw=0.7)
    axc.set_yscale("log"); axc.set_ylabel("close (log)")
    axc.set_title(f"{args.symbol} {args.timeframe} — CAUSAL HMM k={k} "
                  f"({cz['n_refits']} refits, online filtering)  switches={causal_sw}")
    axc.legend(handles=[Patch(facecolor=STATE_COLORS[s % len(STATE_COLORS)], alpha=0.45,
               label=f"S{s}: {clabels[s]} ({cpct[s]*100:.0f}%)") for s in range(k)],
               loc="upper left", fontsize=8, framealpha=0.9)

    shade(axf, t, full.states, k)
    axf.plot(t, close, color="black", lw=0.7)
    axf.set_yscale("log"); axf.set_ylabel("close (log)")
    axf.set_title(f"FULL-SAMPLE HMM k={k} (look-ahead reference)  "
                  f"switches={full_sw}  agreement={agree*100:.0f}%")

    axp.plot(t, conf, color="#2c7fb8", lw=0.5)
    axp.axhline(1.0 / k, color="k", lw=0.5, ls=":")   # chance level
    axp.set_ylabel("causal\nconfidence"); axp.set_ylim(0, 1); axp.set_xlabel("time (UTC)")

    fig.tight_layout()
    png = os.path.join(OUT_DIR, f"causal_vs_fullsample_k{k}.png")
    fig.savefig(png, dpi=110)
    plt.close(fig)

    out = feat[["time", "close", *FEATURE_NAMES]].copy()
    out["causal_state"] = cstates
    out["causal_label"] = [clabels[s] if s >= 0 else "warmup" for s in cstates]
    out["causal_conf"] = conf
    out["fullsample_state"] = full.states
    csv = os.path.join(OUT_DIR, "causal_bars.csv")
    out.to_csv(csv, index=False)

    print(f"\n[out] plot: {png}")
    print(f"[out] csv:  {csv}")
    print("[note] Causal labels use only data up to each bar (rolling refit + forward "
          "filtering) — these ARE look-ahead-free and safe to condition trades on.")


if __name__ == "__main__":
    main()
