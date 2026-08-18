"""
Server-side parameter-plateau summary for the Overnight Run.

A faithful Python port of `buildPlateau` in
frontend/src/components/GridPlateauPanel.jsx (+ `statValue` in gridMetrics.js).
The Overnight Run computes this once per asset from ALL of that asset's grid
combos, then stores only the compact summary (not the up-to-10k rows) so the
verdict PDF / UI can show, per param, whether the best value sits on a stable
PLATEAU (trustworthy) or a lone SPIKE (probably overfit).

Return shape is byte-identical to the JS `buildPlateau` so the existing
GridPlateauPanel can render it directly from a precomputed prop.

KEEP IN SYNC with GridPlateauPanel.jsx::buildPlateau — a parity test
(scratchpad/plateau_parity.*) guards against drift.
"""
from __future__ import annotations

import math
from typing import Optional

# Backend run-metric id -> stats key. Mirrors _METRIC_KEYS in grid_search.py and
# METRIC_TO_STAT in gridMetrics.js. Defined locally so this module stays light
# (no torch/backtest_engine import chain — keeps the parity test fast).
_METRIC_KEYS = {
    "sharpe": "sharpe",
    "profit_factor": "profit_factor",
    "total_return": "total_return_pct",
}


def _stat_value(stats: dict, stat_key: str):
    """Mirror gridMetrics.js::statValue. profit_factor == None means gross_loss
    was 0 → +inf if there was any gross profit, else 0. Genuinely-missing →
    None. bool is excluded (JS treats only `typeof==='number'`)."""
    v = stats.get(stat_key)
    if stat_key == "profit_factor" and v is None:
        return math.inf if (float(stats.get("gross_profit") or 0) > 0) else 0.0
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float)) and not (isinstance(v, float) and math.isnan(v)):
        return float(v)
    return None


def _median(sorted_finite: list):
    n = len(sorted_finite)
    if n == 0:
        return None
    mid = n >> 1
    if n % 2:
        return sorted_finite[mid]
    return (sorted_finite[mid - 1] + sorted_finite[mid]) / 2


def _fingerprint(stats: dict) -> str:
    """Identical-run fingerprint (same code+data+effective params → bit-identical
    floats). Only compared for equality WITHIN this process, so exact string form
    need not match JS — just the equality relation, which it does."""
    s = stats or {}
    return (f"{s.get('trades')}|{s.get('final_equity')}|{s.get('wins')}|"
            f"{s.get('gross_profit')}|{s.get('gross_loss')}|{s.get('max_drawdown_dollars')}")


def build_plateau(rows: list, grid_params: list, metric: str) -> dict:
    """rows: [{combo_idx, params:{name:value}, stats:{...}}]; grid_params:
    [{name,type,values:[...]}]; metric: run metric id OR a stats key."""
    stat_key = _METRIC_KEYS.get(metric, metric)
    names = [gp["name"] for gp in grid_params]

    vals = [_stat_value(r.get("stats") or {}, stat_key) for r in rows]
    global_finite = [v for v in vals if v is not None and math.isfinite(v)]
    global_range = (max(global_finite) - min(global_finite)) if len(global_finite) >= 2 else 0

    # Global best combo (None counts as -inf; +inf wins; ties -> first).
    best_row: Optional[dict] = None
    best_val = -math.inf
    for i, r in enumerate(rows):
        v = -math.inf if vals[i] is None else vals[i]
        if v > best_val:
            best_val = v
            best_row = r

    params = []
    all_medians = []

    for gp in grid_params:
        gv = gp.get("values") or []
        if len(gv) < 2:
            params.append({
                "name": gp["name"], "type": gp.get("type"), "single": True,
                "fixedValue": gv[0] if gv else None, "cells": [], "verdict": "single",
                "spreadFrac": None,
                "bestValue": (best_row or {}).get("params", {}).get(gp["name"]),
            })
            continue

        # marginal cells, one per param value (preserve list order)
        by_value: dict = {}
        for i, r in enumerate(rows):
            k = r["params"].get(gp["name"])
            by_value.setdefault(k, []).append(vals[i])

        cells = []
        for value in gv:
            group = by_value.get(value, [])
            finite = sorted(v for v in group if v is not None and math.isfinite(v))
            inf_count = sum(1 for v in group if v == math.inf)
            missing_count = sum(1 for v in group if v is None)
            med = _median(finite)
            if med is not None:
                all_medians.append(med)
            cells.append({
                "value": value, "count": len(group), "finiteCount": len(finite),
                "infCount": inf_count, "missingCount": missing_count, "median": med,
                "mean": (sum(finite) / len(finite)) if finite else None,
                "min": finite[0] if finite else None,
                "max": finite[-1] if finite else None,
            })

        # "no effect": within every other-params group, all results identical
        other_names = [n for n in names if n != gp["name"]]
        groups: dict = {}
        for r in rows:
            key = tuple(r["params"].get(n) for n in other_names)
            g = groups.get(key)
            if g is None:
                g = {"fps": set(), "count": 0}
                groups[key] = g
            g["fps"].add(_fingerprint(r.get("stats")))
            g["count"] += 1
        no_effect = False
        if groups:
            all_identical = True
            any_multi = False  # partial runs can leave only 1-row groups
            for g in groups.values():
                if g["count"] >= 2:
                    any_multi = True
                if len(g["fps"]) > 1:
                    all_identical = False
                    break
            no_effect = all_identical and any_multi

        # verdict
        finite_medians = [c["median"] for c in cells if c["median"] is not None]
        spread_frac = None
        if no_effect:
            verdict = "noeffect"
        elif len(finite_medians) < 2:
            verdict = "insufficient"
        else:
            spread_frac = (max(finite_medians) - min(finite_medians)) / (global_range or 1)
            verdict = "plateau" if spread_frac < 0.15 else ("sensitive" if spread_frac > 0.5 else "moderate")

        params.append({
            "name": gp["name"], "type": gp.get("type"), "single": False,
            "cells": cells, "verdict": verdict, "spreadFrac": spread_frac,
            "bestValue": (best_row or {}).get("params", {}).get(gp["name"]),
        })

    return {
        "params": params,
        "medMin": min(all_medians) if all_medians else 0,
        "medMax": max(all_medians) if all_medians else 0,
    }
