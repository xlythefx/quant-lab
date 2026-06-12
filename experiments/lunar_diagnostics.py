"""
Lunar diagnostics — is the moon edge real, or exits + beta + a non-stationary stop?

One single-position event simulator (validated against backtest_engine) drives
three tests on lunar_ts_test / ES 1h, 2018-01-01 -> 2026-04-30:

  #3  Null test     : moon-timed entries vs RANDOM session-open entries (same
                      exits, same L/S mix). If moon lands inside the random P&L
                      distribution, the entry signal adds nothing.
  #2  Beta decomp   : long vs short P&L in isolation, vs ES buy&hold and an
                      always-long-at-session-open baseline.
  #1  Stop regime   : fixed $-stops (35/65pt) vs %-stops, split by era, to show
                      the dollar stop's risk geometry drifts over the window.

Read-only research (lives in experiments/, per CLAUDE.md). Costs are zeroed so
all arms are compared on identical terms; the question here is signal, not net.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from datetime import datetime, timezone

from services.market_data import load_parquet
from services import backtest_engine
from services.strategies.lunar_ts_test import _moon_phase, _session_ids, _session_atr_rising

PV       = 50.0       # $/pt ES
CONTRACTS = 1
STOP_PTS = 1750.0 / PV   # 35.0
TGT_PTS  = 3250.0 / PV   # 65.0
MAXBARS  = 345
BE_ARM   = 1750.0        # dollars
BE_OFF   = 2.5           # pts (10 ticks)
START = int(datetime(2018, 1, 1, tzinfo=timezone.utc).timestamp())
END   = int(datetime(2026, 4, 30, tzinfo=timezone.utc).timestamp())


def load() -> pd.DataFrame:
    df = load_parquet("ES", "1h", broker="databento")
    df = df[(df["time"] >= START) & (df["time"] <= END)].reset_index(drop=True)
    return df


def session_structure(df):
    t = df["time"].to_numpy(float)
    n = len(t)
    is_sess = np.zeros(n, bool)
    if n:
        is_sess[0] = True
    for i in range(1, n):
        if t[i] - t[i - 1] > 3600:
            is_sess[i] = True
    return is_sess


def moon_signals(df, is_sess, l1=1, l2=35, l3=65, atr_period=11, atr_mult=1.0):
    """Return per-bar side at session-open bars: +1 long (peak), -1 short
    (trough & ATR rising), 0 none. Mirrors lunar_ts_test.vectorized entry gate."""
    phase = _moon_phase(df["time"].astype(float)).to_numpy()
    high = df["high"].to_numpy(float); low = df["low"].to_numpy(float)
    n = len(phase)
    lag_max = max(l1, l2, l3)
    atr_rising = _session_atr_rising(df, atr_period, atr_mult)
    side = np.zeros(n, int)
    for i in range(lag_max, n):
        if not is_sess[i] or high[i] == low[i]:
            continue
        p1, p2, p3 = phase[i - l1], phase[i - l2], phase[i - l3]
        if (p1 < p2) and (p2 > p3):
            side[i] = 1
        elif (p1 > p2) and (p2 < p3) and atr_rising[i]:
            side[i] = -1
    return side


def simulate(df, signal_side, *, stop_pts=None, tgt_pts=None, stop_pct=None,
             tgt_pct=None, maxbars=MAXBARS, be_arm=BE_ARM, be_off=BE_OFF,
             pv=PV, contracts=CONTRACTS):
    """Single-position sim. signal_side[t] in {+1,-1,0} = decide at bar t, fill at
    open[t+1]. Exits (priority): stop, target, maxbars, breakeven. Returns trades
    list of dicts. Stop/target either pts (fixed) or pct (of entry)."""
    open_ = df["open"].to_numpy(float); high = df["high"].to_numpy(float)
    low = df["low"].to_numpy(float); close = df["close"].to_numpy(float)
    time = df["time"].to_numpy("int64")
    n = len(open_)
    trades = []
    pos = 0; entry = np.nan; entry_bar = -1; mfe = np.nan; entry_t = 0

    for t in range(n):
        if pos != 0 and np.isfinite(entry):
            if pos == 1:
                mfe = max(mfe, high[t])
                slv = entry - stop_pts if stop_pts is not None else entry * (1 - stop_pct)
                tlv = entry + tgt_pts if tgt_pts is not None else entry * (1 + tgt_pct)
                be_armed = (mfe - entry) * pv >= be_arm
                be_lv = entry + be_off
                reason = None; fill = None
                if low[t] <= slv:                 reason, fill = "stop", min(slv, open_[t])
                elif high[t] >= tlv:              reason, fill = "target", max(tlv, open_[t])
                elif (t - entry_bar) >= maxbars:  reason, fill = "maxbars", open_[t]
                elif be_armed and low[t] <= be_lv: reason, fill = "be", min(be_lv, open_[t])
                if reason:
                    trades.append({"side": 1, "pnl": (fill - entry) * pv * contracts,
                                   "entry_t": entry_t, "reason": reason})
                    pos = 0; entry = np.nan; entry_bar = -1; mfe = np.nan
            else:
                mfe = min(mfe, low[t])
                slv = entry + stop_pts if stop_pts is not None else entry * (1 + stop_pct)
                tlv = entry - tgt_pts if tgt_pts is not None else entry * (1 - tgt_pct)
                be_armed = (entry - mfe) * pv >= be_arm
                be_lv = entry - be_off
                reason = None; fill = None
                if high[t] >= slv:                reason, fill = "stop", max(slv, open_[t])
                elif low[t] <= tlv:               reason, fill = "target", min(tlv, open_[t])
                elif (t - entry_bar) >= maxbars:  reason, fill = "maxbars", open_[t]
                elif be_armed and high[t] >= be_lv: reason, fill = "be", max(be_lv, open_[t])
                if reason:
                    trades.append({"side": -1, "pnl": (entry - fill) * pv * contracts,
                                   "entry_t": entry_t, "reason": reason})
                    pos = 0; entry = np.nan; entry_bar = -1; mfe = np.nan

        if pos == 0 and signal_side[t] != 0 and t + 1 < n:
            pos = int(signal_side[t]); entry = open_[t + 1]; entry_bar = t + 1
            mfe = entry; entry_t = int(time[t + 1])

    # force-close last open position at final close
    if pos != 0 and np.isfinite(entry):
        fill = close[-1]
        pnl = (fill - entry) * pv * contracts if pos == 1 else (entry - fill) * pv * contracts
        trades.append({"side": pos, "pnl": pnl, "entry_t": entry_t, "reason": "eod"})
    return trades


def summary(trades):
    if not trades:
        return dict(n=0, net=0.0, win=0.0, avg=0.0)
    pnl = np.array([x["pnl"] for x in trades])
    return dict(n=len(pnl), net=float(pnl.sum()), win=float((pnl > 0).mean()),
                avg=float(pnl.mean()))


def main():
    df = load()
    is_sess = session_structure(df)
    side = moon_signals(df, is_sess)
    sess_open_idx = np.where(is_sess)[0]
    sess_open_idx = sess_open_idx[sess_open_idx + 1 < len(df)]  # need a next bar to fill

    # ---- VALIDATION: sim vs production engine (phase_flip off, zero cost) ----
    res = backtest_engine.run("lunar_ts_test", "ES", "1h",
                              params={"phase_flip_exit": False},
                              risk_overrides={"slippage_bps": 0, "fee_flat": 0,
                                              "futures_commission": 0,
                                              "starting_capital": 100000})
    eng_net = res["stats"]["total_return_dollars"]
    eng_n = res["stats"]["trades"]
    moon = simulate(df, side, stop_pts=STOP_PTS, tgt_pts=TGT_PTS)
    sm = summary(moon)
    print("=" * 70)
    print("VALIDATION  (phase_flip OFF, zero cost, 1 contract)")
    print(f"  engine : {eng_n:3d} trades   net ${eng_net:12,.0f}")
    print(f"  sim    : {sm['n']:3d} trades   net ${sm['net']:12,.0f}   "
          f"(sim within {abs(sm['net']-eng_net)/max(1,abs(eng_net))*100:.1f}% of engine)")

    # ---- #3 NULL TEST: moon vs random session-open entries ----
    n_long = sum(1 for x in moon if x["side"] == 1)
    n_short = sum(1 for x in moon if x["side"] == -1)
    n_tot = n_long + n_short
    p_long = n_long / n_tot if n_tot else 0.5
    base_rate = n_tot / len(sess_open_idx)  # entries per session-open opportunity
    rng = np.random.default_rng(7)
    N = 500
    rand_nets = np.empty(N); rand_avgs = np.empty(N)
    for k in range(N):
        rs = np.zeros(len(df), int)
        draw = rng.random(len(sess_open_idx)) < base_rate
        sides = np.where(rng.random(len(sess_open_idx)) < p_long, 1, -1)
        rs[sess_open_idx[draw]] = sides[draw]
        rt = simulate(df, rs, stop_pts=STOP_PTS, tgt_pts=TGT_PTS)
        s = summary(rt); rand_nets[k] = s["net"]; rand_avgs[k] = s["avg"]
    pct = float((rand_nets < sm["net"]).mean()) * 100
    z = (sm["net"] - rand_nets.mean()) / (rand_nets.std() + 1e-9)
    p_one_sided = float((rand_nets >= sm["net"]).mean())
    print("=" * 70)
    print(f"#3 NULL TEST  ({N} random arms, matched n~{n_tot} & L/S~{p_long:.0%})")
    print(f"  moon net      : ${sm['net']:12,.0f}   avg/trade ${sm['avg']:,.0f}   win {sm['win']:.1%}")
    print(f"  random net    : ${rand_nets.mean():12,.0f} +/- ${rand_nets.std():,.0f}  "
          f"[p5 ${np.percentile(rand_nets,5):,.0f}  p95 ${np.percentile(rand_nets,95):,.0f}]")
    print(f"  moon percentile vs random: {pct:.1f}%   z={z:+.2f}   p(one-sided)={p_one_sided:.3f}")
    verdict = ("SIGNAL: moon beats random" if p_one_sided < 0.05
               else "NO EDGE: moon indistinguishable from random timing")
    print(f"  -> {verdict}")

    # ---- #2 BETA DECOMP: long vs short, vs buy&hold / always-long ----
    longs = [x for x in moon if x["side"] == 1]
    shorts = [x for x in moon if x["side"] == -1]
    sl, ss = summary(longs), summary(shorts)
    bh_pts = (df["close"].iloc[-1] - df["close"].iloc[0])
    bh_dollars = bh_pts * PV  # 1 contract held throughout
    # always-long at every session-open (same exits)
    alllong = simulate(df, np.where(is_sess, 1, 0), stop_pts=STOP_PTS, tgt_pts=TGT_PTS)
    al = summary(alllong)
    print("=" * 70)
    print("#2 BETA DECOMP")
    print(f"  moon LONG  : {sl['n']:3d} tr  net ${sl['net']:11,.0f}  win {sl['win']:.1%}  avg ${sl['avg']:,.0f}")
    print(f"  moon SHORT : {ss['n']:3d} tr  net ${ss['net']:11,.0f}  win {ss['win']:.1%}  avg ${ss['avg']:,.0f}")
    print(f"  ES buy&hold 1 contract        : ${bh_dollars:11,.0f}  ({bh_pts:.0f} pts)")
    print(f"  always-long-at-open (same exits): {al['n']:3d} tr  net ${al['net']:11,.0f}  win {al['win']:.1%}")
    shorts_help = "shorts ADD value" if ss["net"] > 0 else "shorts LOSE money (long-only beta play)"
    print(f"  -> {shorts_help}")

    # ---- #1 STOP REGIME: $-stop vs %-stop, by era ----
    eras = [("2018-2021", START, int(datetime(2022,1,1,tzinfo=timezone.utc).timestamp())),
            ("2022-2026", int(datetime(2022,1,1,tzinfo=timezone.utc).timestamp()), END)]
    print("=" * 70)
    print("#1 STOP REGIME  (fixed $1750/$3250 = 35/65pt  vs  %-stop 0.73%/1.36%)")
    dollar_tr = moon
    pct_tr = simulate(df, side, stop_pct=0.0073, tgt_pct=0.0136)  # ~2024 equiv of 35/65pt
    for label, lo, hi in eras:
        def in_era(trs): return [x for x in trs if lo <= x["entry_t"] < hi]
        d, p = summary(in_era(dollar_tr)), summary(in_era(pct_tr))
        print(f"  {label}:  $-stop  {d['n']:3d}tr net ${d['net']:10,.0f} win {d['win']:.1%}"
              f"   |  %-stop {p['n']:3d}tr net ${p['net']:10,.0f} win {p['win']:.1%}")
    print("  (if $-stop win% jumps era-to-era while %-stop holds, the dollar stop's")
    print("   geometry — not the moon edge — is what changed across the window)")
    print("=" * 70)


if __name__ == "__main__":
    main()
