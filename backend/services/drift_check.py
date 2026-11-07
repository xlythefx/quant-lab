"""
Drift Check — when a coin pulls away from an anchor coin (BTC), does the gap keep growing?

This is the "drift keeps going" idea (momentum against BTC). The Pair Check showed that
betting a coin's gap with BTC would close lost money for most coins. Instead of trading
that, this asks directly: after a coin's gap with BTC crosses ±entry_z, what does the
gap do over the next hours and days?

Per coin (all causal):
  - z = the Pair Check's rolling z of log(coin) vs log(anchor) over `window_days`
    (pair_check.rolling_z), with the hedge ratio b re-fitted every bar.
  - Event = z crosses +entry_z from below ("pulls ahead") or −entry_z from above
    ("falls behind"). After an event, the same direction is ignored for
    `cooldown_hours`, so one long drift counts once instead of on every bar.
  - Signal on the event bar's close, in at the next bar's open, out h hours later at
    that bar's open. The move is measured two ways, both signed so that + means
    "the drift kept going":
        hedged     = coin return − b × anchor return   (the gap itself)
        coin only  = coin return                        (just buying / shorting the coin)
  - Edge = average move after events − average move over ALL bars (what any random
    moment gives), so a rising market can't pass for an edge.

Across coins, each coin with >= min_events gets one edge per horizon, and "breadth" is the
share of coins with a positive edge, so one busy coin can't carry the result. Drifts bunch
in time, though: one big BTC move makes dozens of coins drift on the same day, all sharing
that move. So the verdict is judged week by week (t_weeks: every drift in a calendar week
averaged first), not coin by coin (t_coins), which on real data (Nov 2026) was ~7x too
optimistic. The "anchor" cells split out how much of a hedged edge came from the anchor
leg's own move rather than the coin's.

Locked holdout: everything from `sealed_from` (Nov 06, 2025) on is cut off BEFORE any
research calculation, so the research numbers cannot depend on it. It opens once per
(anchor, timeframe) through open_holdout(), which computes the result with the settings
given at that moment and stores it, frozen, in data/holdout_log.json.

The headline test was chosen in advance: 1 day, both directions, hedged. Every other
cell is exploration and carries more luck.
"""
from __future__ import annotations

import datetime
import json
import math
import os
import time

import numpy as np
import pandas as pd
from scipy import stats

from config import DATA_DIR
from services import market_data, pair_check
from services.atomic_io import atomic_write_json
from services.quant_metrics import _safe

LOG_PATH = os.path.join(DATA_DIR, "holdout_log.json")
SEALED_FROM = "2025-11-06"           # agreed Nov 06, 2026: the last 12 months stay sealed
BAR_SEC = {"5m": 300, "1h": 3600}
HORIZONS = {"5m": [0.25, 1, 4, 24], "1h": [1, 4, 24, 72]}    # hours
HEADLINE_H = 24
MIN_DAYS = 180                       # research history a coin needs to count
MAX_POINTS = 400
DIRS = ("up", "dn", "both")
MODES = ("hedged", "coin")
ALL_MODES = MODES + ("anchor",)       # "anchor" = what the hedge leg alone added
WEEK = 7 * 86400


# --------------------------------------------------------------------------- #
# Holdout log
# --------------------------------------------------------------------------- #
def _read_log() -> dict:
    try:
        with open(LOG_PATH, encoding="utf-8") as fh:
            return json.load(fh)
    except FileNotFoundError:
        return {}


def _drift_log() -> dict:
    """The drift_check section, created (and the seal date fixed) on first use."""
    log = _read_log()
    dc = log.get("drift_check")
    if dc is None:
        dc = log["drift_check"] = {"sealed_from": SEALED_FROM, "opened": {}}
        atomic_write_json(LOG_PATH, log)
    return dc


def sealed_from_ts() -> int:
    d = datetime.date.fromisoformat(_drift_log()["sealed_from"])
    return int(datetime.datetime(d.year, d.month, d.day, tzinfo=datetime.timezone.utc).timestamp())


def _key(anchor: str, timeframe: str) -> str:
    return f"{anchor}|{timeframe}"


def holdout_status(anchor: str, timeframe: str) -> dict:
    dc = _drift_log()
    return {"sealed_from": sealed_from_ts(), "opened": dc["opened"].get(_key(anchor, timeframe))}


def open_holdout(anchor: str, timeframe: str, params: dict | None = None) -> dict:
    """Run the sealed months ONCE with these settings and store the result, frozen."""
    _check(anchor, timeframe)
    if holdout_status(anchor, timeframe)["opened"]:
        raise ValueError(f"The {anchor} {timeframe} holdout was already opened. It only opens once.")
    p = _params(params)
    p["coins"] = p["coins"] or universe(anchor, timeframe)
    record = {"opened_at": int(time.time()), "settings": p,
              "result": _run(anchor, timeframe, p, "holdout")}
    log = _read_log()
    log["drift_check"]["opened"][_key(anchor, timeframe)] = record
    atomic_write_json(LOG_PATH, log)
    return record


# --------------------------------------------------------------------------- #
# Inputs
# --------------------------------------------------------------------------- #
def _check(anchor: str, timeframe: str) -> None:
    if timeframe not in BAR_SEC:
        raise ValueError("Drift Check runs on 5m or 1h.")
    if not anchor:
        raise ValueError("Pick an anchor coin.")


def _params(params: dict | None) -> dict:
    p = params or {}
    num = pair_check._num
    coins = p.get("coins") or []
    if isinstance(coins, str):
        coins = coins.split(",")
    return {
        "window_days": num(p, "window_days", 30.0, 2.0, 365.0),
        "entry_z": num(p, "entry_z", 2.0, 0.5, 10.0),
        "cooldown_hours": num(p, "cooldown_hours", 24.0, 0.0, 24.0 * 30),
        "min_events": int(num(p, "min_events", 10, 1, 10000)),
        "fee_pct": num(p, "fee_pct", 0.0, 0.0, 10.0),
        "slippage_bps": num(p, "slippage_bps", 0.0, 0.0, 500.0),
        "coins": sorted({str(c).strip().upper() for c in coins if str(c).strip()}),
    }


def universe(anchor: str, timeframe: str) -> list[str]:
    """Binance crypto coins with data at this timeframe (1h can be built from 15m / 5m)."""
    usable = {"5m": {"5m"}, "1h": {"1h", "15m", "5m"}}[timeframe]
    return sorted({d["symbol"] for d in market_data.list_datasets()
                   if d.get("broker") == "binance" and d.get("asset_class", "crypto") == "crypto"
                   and d["timeframe"] in usable and d["symbol"] != anchor and "." not in d["symbol"]})


# --------------------------------------------------------------------------- #
# One coin
# --------------------------------------------------------------------------- #
def _cooldown(idx: np.ndarray, gap: int) -> np.ndarray:
    out, last = [], None
    for i in idx.tolist():
        if last is None or i - last >= gap:
            out.append(i)
            last = i
    return np.asarray(out, dtype=int)


def coin_events(t, oc, cc, oa, ca, p: dict, bar_sec: int, hours, event_from=None) -> dict | None:
    """Events and the moves after them for one coin. The arrays must already be cut to
    what this period may see. `event_from`: only count events (and baseline bars) at or
    after this time (the holdout); earlier bars only warm up the rolling fit."""
    n = len(t)
    W = max(20, int(round(p["window_days"] * 86400 / bar_sec)))
    if n < W + 10:
        return None
    rz = pair_check.rolling_z(np.log(cc), np.log(ca), W)
    z, beta = rz["z"], rz["beta"]
    E = p["entry_z"]
    zp = np.r_[np.nan, z[:-1]]
    with np.errstate(invalid="ignore"):
        up = np.nonzero((z >= E) & (zp < E))[0]
        dn = np.nonzero((z <= -E) & (zp > -E))[0]
    if event_from is not None:
        up, dn = up[t[up] >= event_from], dn[t[dn] >= event_from]
    gap = int(round(p["cooldown_hours"] * 3600 / bar_sec))
    ev = {"up": _cooldown(up, gap), "dn": _cooldown(dn, gap)}
    in_period = np.isfinite(z) & (t >= event_from if event_from is not None else True)

    out = {}
    for h in hours:
        hb = max(1, int(round(h * 3600 / bar_sec)))
        rc, ra = np.full(n, np.nan), np.full(n, np.nan)
        if n - 1 - hb > 0:
            rc[: n - 1 - hb] = oc[1 + hb:] / oc[1:n - hb] - 1.0
            ra[: n - 1 - hb] = oa[1 + hb:] / oa[1:n - hb] - 1.0
        # hedged = coin + anchor leg, so the two parts of an edge add up exactly.
        moves = {"hedged": rc - beta * ra, "coin": rc, "anchor": -beta * ra}
        ok = in_period & np.isfinite(moves["hedged"])
        base = {m: float(np.mean(moves[m][ok])) if ok.any() else np.nan for m in ALL_MODES}
        row = {"base": base}
        for d, sign in (("up", 1.0), ("dn", -1.0)):
            i = ev[d][ok[ev[d]]] if ev[d].size else ev[d]
            row[d] = {
                "t": t[i], "t_exit": t[np.minimum(i + 1 + hb, n - 1)], "beta": beta[i],
                **{m: sign * moves[m][i] for m in MODES},                         # what you'd earn
                **{f"{m}_edge": sign * (moves[m][i] - base[m]) for m in ALL_MODES},  # vs a random moment
            }
        out[h] = row
    return out


# --------------------------------------------------------------------------- #
# All coins
# --------------------------------------------------------------------------- #
def _aligned(coin_df: pd.DataFrame, anchor_df: pd.DataFrame) -> pd.DataFrame:
    return (coin_df[["time", "open", "close"]]
            .merge(anchor_df[["time", "open", "close"]], on="time", suffixes=("_c", "_a"))
            .dropna().sort_values("time").reset_index(drop=True))


def _run(anchor: str, timeframe: str, p: dict, period: str) -> dict:
    cutoff = sealed_from_ts()
    bar_sec, hours = BAR_SEC[timeframe], HORIZONS[timeframe]
    a_df, _ = pair_check._load(anchor, timeframe)
    coins = p["coins"] or universe(anchor, timeframe)
    warm = int((p["window_days"] + 2) * 86400)
    per_coin, skipped, first, last = {}, [], None, None
    for sym in coins:
        try:
            c_df, _ = pair_check._load(sym, timeframe)
        except FileNotFoundError:
            skipped.append({"symbol": sym, "why": f"no {timeframe} data"})
            continue
        m = _aligned(c_df, a_df)
        research_days = (min(cutoff, int(m["time"].iloc[-1])) - int(m["time"].iloc[0])) / 86400 if len(m) else 0
        if research_days < MIN_DAYS:
            skipped.append({"symbol": sym, "why": f"only {research_days:.0f} days before the seal"})
            continue
        if period == "research":
            m = m[m["time"] < cutoff]              # the sealed months never enter the maths
            event_from = None
        else:
            m = m[m["time"] >= cutoff - warm]      # warm-up before the seal, events after it
            event_from = cutoff
        t = m["time"].to_numpy(dtype="int64")
        r = coin_events(t, m["open_c"].to_numpy(float), m["close_c"].to_numpy(float),
                        m["open_a"].to_numpy(float), m["close_a"].to_numpy(float),
                        p, bar_sec, hours, event_from)
        if r is None:
            skipped.append({"symbol": sym, "why": "too few bars"})
            continue
        per_coin[sym] = r
        t0 = int(t[0]) if event_from is None else cutoff
        first = t0 if first is None else min(first, t0)
        last = int(t[-1]) if last is None else max(last, int(t[-1]))
    return _summarize(per_coin, skipped, p, hours, first, last, period)


def _cell(per_coin: dict, h, mode: str, d: str, min_events: int) -> dict:
    """One horizon × mode × direction: per-coin edges and the pooled events.

    Two t-stats. `t_coins` treats each coin as one independent result. Drifts bunch
    in time, though: one big market move makes dozens of coins drift on the same day,
    and they all share that move. `t_weeks` averages all drifts in each calendar week
    first and treats weeks as the units, so a bunch counts once. It's the honest one."""
    coin_edge, pooled, times = {}, [], []
    dirs = ("up", "dn") if d == "both" else (d,)
    for sym, r in per_coin.items():
        e = np.concatenate([r[h][x][f"{mode}_edge"] for x in dirs])
        pooled.append(e)
        times.append(np.concatenate([r[h][x]["t"] for x in dirs]))
        if e.size >= min_events:
            coin_edge[sym] = float(e.mean())
    pooled = np.concatenate(pooled) if pooled else np.array([])
    times = np.concatenate(times) if times else np.array([], dtype="int64")
    vals = np.array(list(coin_edge.values()))
    k = int(vals.size)
    pos = int((vals > 0).sum())
    sd = float(vals.std(ddof=1)) if k >= 2 else 0.0
    wk = pd.Series(pooled).groupby(times // WEEK).mean().to_numpy() if pooled.size else np.array([])
    wsd = float(wk.std(ddof=1)) if wk.size >= 2 else 0.0
    return {
        "weeks": int(wk.size),
        "weeks_positive_pct": _safe(float(np.mean(wk > 0)) * 100) if wk.size else None,
        "t_weeks": _safe(float(wk.mean()) / (wsd / math.sqrt(wk.size))) if wk.size >= 10 and wsd > 0 else None,
        "coins": k, "coins_positive": pos,
        "breadth_pct": _safe(pos / k * 100) if k else None,
        "breadth_p": _safe(stats.binomtest(pos, k, 0.5).pvalue) if k else None,
        "avg_coin_edge_pct": _safe(float(vals.mean()) * 100) if k else None,
        "t_coins": _safe(float(vals.mean()) / (sd / math.sqrt(k))) if k >= 5 and sd > 0 else None,
        "events": int(pooled.size),
        "avg_event_edge_pct": _safe(float(pooled.mean()) * 100) if pooled.size else None,
        "_coin_edge": coin_edge,
    }


def _summarize(per_coin, skipped, p, hours, first, last, period) -> dict:
    cost_side = p["fee_pct"] / 100.0 + p["slippage_bps"] / 10000.0
    n_coins = max(1, len(per_coin))
    cells, years, equity = {}, {}, {}
    for h in hours:
        hk = _hkey(h)
        cells[hk] = {m: {d: _cell(per_coin, h, m, d, p["min_events"]) for d in DIRS} for m in MODES}
        cells[hk]["anchor"] = {"both": _cell(per_coin, h, "anchor", "both", p["min_events"])}

        # Year by year, both directions pooled, by the event's signal date.
        ev_t = np.concatenate([np.r_[r[h]["up"]["t"], r[h]["dn"]["t"]] for r in per_coin.values()]) if per_coin else np.array([])
        yr = pd.to_datetime(ev_t, unit="s", utc=True).year.to_numpy() if ev_t.size else np.array([])
        years[hk] = {}
        for m in MODES:
            e = np.concatenate([np.r_[r[h]["up"][f"{m}_edge"], r[h]["dn"][f"{m}_edge"]] for r in per_coin.values()]) if per_coin else np.array([])
            years[hk][m] = [{"year": int(y), "events": int((yr == y).sum()),
                             "avg_edge_pct": _safe(float(e[yr == y].mean()) * 100)} for y in np.unique(yr)]

        # Equal-weight basket that trades every event: each coin owns 1/N of capital.
        equity[hk] = {}
        for m in MODES:
            parts = []
            for r in per_coin.values():
                for d in ("up", "dn"):
                    x = r[h][d]
                    cost = 2 * cost_side * ((1 + np.abs(x["beta"])) if m == "hedged" else 1.0)
                    parts.append(np.column_stack([x["t_exit"], x[m], x[m] - cost]))
            arr = np.concatenate(parts) if parts else np.empty((0, 3))
            arr = arr[np.argsort(arr[:, 0], kind="stable")] if arr.size else arr
            gross = np.cumsum(arr[:, 1]) / n_coins * 100 if arr.size else np.array([])
            net = np.cumsum(arr[:, 2]) / n_coins * 100 if arr.size else np.array([])
            equity[hk][m] = {"net": _series(arr[:, 0], net), "gross": _series(arr[:, 0], gross) if cost_side > 0 else []}

    head = cells[_hkey(HEADLINE_H)]["hedged"]["both"]
    head_anchor = cells[_hkey(HEADLINE_H)]["anchor"]["both"]
    head_years = years[_hkey(HEADLINE_H)]["hedged"]
    coin_rows = []
    hk = _hkey(HEADLINE_H)
    for sym, r in per_coin.items():
        row = {"symbol": sym, "events_up": int(r[HEADLINE_H]["up"]["t"].size),
               "events_dn": int(r[HEADLINE_H]["dn"]["t"].size)}
        for m in MODES:
            for d in DIRS:
                v = cells[hk][m][d]["_coin_edge"].get(sym)
                row[f"{m}_{d}_pct"] = _safe(v * 100) if v is not None else None
        coin_rows.append(row)
    for hc in cells.values():
        for m in hc.values():
            for c in m.values():
                c.pop("_coin_edge")

    return {
        "period": period, "first_time": first, "last_time": last,
        "coins_used": len(per_coin), "skipped": skipped,
        "horizons": [_hkey(h) for h in hours], "headline": _hkey(HEADLINE_H),
        "cells": cells, "years": years, "equity": equity, "coins": coin_rows,
        "verdict": _verdict(head, head_anchor, head_years),
        "has_costs": cost_side > 0,
        "cost_round_trip_pct": _safe(2 * cost_side * 100),
    }


def _verdict(head: dict, head_anchor: dict, head_years: list) -> dict:
    """Judged week by week (t_weeks): drifts that bunch on the same days count once."""
    t, tc, br = head["t_weeks"], head["t_coins"], head["breadth_pct"]
    yrs = [y for y in head_years if y["events"] >= 20 and y["avg_edge_pct"] is not None]
    green = sum(1 for y in yrs if y["avg_edge_pct"] > 0)
    yr_share = green / len(yrs) if yrs else 0.0
    if t is None or br is None:
        return {"tone": "amber", "label": "Not enough to judge",
                "text": "Too few coins or weeks with enough drifts. Lower 'Min events' or use more coins."}
    edge, from_anchor = head["avg_event_edge_pct"] or 0.0, head_anchor["avg_event_edge_pct"] or 0.0
    facts = (f"After 1 day the gap moved {head['avg_coin_edge_pct']:+.2f}% further than at a random moment "
             f"(average over {head['coins']} coins). It kept going for {br:.2f}% of coins and in {green} of "
             f"{len(yrs)} years. Counted coin by coin t = {tc:.2f}, but drifts bunch on the same days; "
             f"counted week by week t = {t:.2f}, with {head['weeks_positive_pct']:.2f}% of weeks positive.")
    if edge and abs(from_anchor) > 0.5 * abs(edge):
        facts += (f" {from_anchor:+.2f}% of the {edge:+.2f}% per drift came from the anchor's own move, "
                  f"not the coin's.")
    if t >= 3 and br >= 60 and yr_share >= 0.7:
        return {"tone": "profit", "label": "Drift keeps going (research data)", "text": facts}
    if t <= -3 and br <= 40 and yr_share <= 0.3:
        return {"tone": "amber", "label": "Drift snaps back (research data)", "text": facts}
    if tc is not None and abs(tc) >= 3:
        return {"tone": "amber", "label": "Looks strong coin by coin, not week by week", "text": facts}
    return {"tone": "loss", "label": "No clear effect", "text": facts}


def _hkey(h) -> str:
    return f"{int(h * 60)}m" if h < 1 else f"{int(h)}h" if h < 24 else f"{int(h // 24)}d"


def _series(times, values, cap=MAX_POINTS):
    n = len(times)
    if n == 0:
        return []
    idx = np.unique(np.r_[np.linspace(0, n - 1, min(cap, n)).astype(int), n - 1])
    return [{"time": int(times[i]), "value": _safe(float(values[i]))} for i in idx]


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def drift_check(anchor: str, timeframe: str, params: dict | None = None) -> dict:
    _check(anchor, timeframe)
    p = _params(params)
    research = _run(anchor, timeframe, p, "research")
    if not research["coins_used"]:
        raise ValueError("No coin had enough history before the sealed months.")
    return {
        "meta": {
            "anchor": anchor, "timeframe": timeframe, "params": p,
            "test": "1 day after the drift, both directions, hedged (chosen in advance)",
            "caveat": ("Research data only: nothing from the sealed months is used. Coins move together, so the "
                       "t-stat across coins is optimistic, and every extra setting or cell you look at adds luck. "
                       "Your coins are also all still listed today; coins that died aren't in the data."),
        },
        "holdout": holdout_status(anchor, timeframe),
        "research": research,
    }
