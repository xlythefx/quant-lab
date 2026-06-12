"""
Portfolio correlation & combination analysis — read-only post-processing on a
`portfolio_runner.run_portfolio()` result. Answers the question the aggregate
stats cannot: *are these strategies good combinations, or the same bet several
times over?*

Isolation: this module only READS the per-strategy synthetic equity curves
(`per_strategy[sid]["equity"]`, each `{time, equity}` on the unified time grid).
It does NOT touch the simulation, sizing or P&L. Pure numpy.

Why this is asset-class-agnostic
--------------------------------
The per-strategy equity is `starting_capital + realized + unrealized`, all in
USD with contract multipliers already baked into `units` (ES=50, NQ=20, ... vs
fractional crypto qty). So a BTC strategy and an ES strategy both contribute
dollar P&L on the same axis — correlation is apples-to-apples with no special
casing, and it sidesteps the `locked_notional()` futures-collateral inflation
because it reads the per-strategy curve, not the aggregate snapshot.

Return basis: DAILY. Per-bar returns are zero-dominated (strategies are flat
most bars) and mix timeframes; bucketing P&L into UTC calendar days is the
meaningful, robust unit for correlation/covariance.
"""
from __future__ import annotations

from typing import Optional

import numpy as np

SECONDS_PER_DAY = 86_400
TRADING_DAYS = 252.0
_EPS = 1e-12


# ---------------------------------------------------------------------------
# Daily P&L matrix
# ---------------------------------------------------------------------------

def _daily_pnl_matrix(per_strategy: dict) -> tuple[list[str], np.ndarray, np.ndarray]:
    """Build the aligned daily dollar-P&L matrix across strategies.

    Returns (sids, days, R) where R has shape (n_days, n_strategies) and column
    j is strategy sids[j]'s net dollar P&L on day days[i]. Days where a strategy
    was flat contribute 0. Strategies with no usable curve are dropped.
    """
    # Per-strategy {day -> summed dollar P&L delta}.
    per_day: dict[str, dict[int, float]] = {}
    all_days: set[int] = set()
    for sid, blk in per_strategy.items():
        curve = (blk or {}).get("equity") or []
        if len(curve) < 2:
            continue
        day_pnl: dict[int, float] = {}
        prev_eq = float(curve[0]["equity"])
        for pt in curve[1:]:
            eq = float(pt["equity"])
            day = int(pt["time"]) // SECONDS_PER_DAY
            day_pnl[day] = day_pnl.get(day, 0.0) + (eq - prev_eq)
            prev_eq = eq
        if day_pnl:
            per_day[sid] = day_pnl
            all_days.update(day_pnl.keys())

    sids = list(per_day.keys())
    days = sorted(all_days)
    if len(sids) < 2 or len(days) < 2:
        return sids, np.array(days, dtype=np.int64), np.empty((len(days), len(sids)))

    day_index = {d: i for i, d in enumerate(days)}
    R = np.zeros((len(days), len(sids)), dtype=float)
    for j, sid in enumerate(sids):
        for d, v in per_day[sid].items():
            R[day_index[d], j] = v
    return sids, np.array(days, dtype=np.int64), R


def _corr_matrix(R: np.ndarray) -> np.ndarray:
    """Pearson correlation of columns, NaN-safe for zero-variance columns.

    A strategy that never moved (constant column) has undefined correlation; we
    report 0 off-diagonal and 1 on the diagonal rather than NaN.
    """
    n = R.shape[1]
    std = R.std(axis=0)
    out = np.eye(n)
    for a in range(n):
        for b in range(a + 1, n):
            if std[a] < _EPS or std[b] < _EPS:
                c = 0.0
            else:
                c = float(np.corrcoef(R[:, a], R[:, b])[0, 1])
                if not np.isfinite(c):
                    c = 0.0
            out[a, b] = out[b, a] = c
    return out


def _periods_per_year(days: np.ndarray) -> float:
    """Observed P&L days per calendar year, inferred from the day grid.

    Crypto trades ~365 days/yr, CME ~252; a hard-coded 252 understates crypto
    Sharpe by ~sqrt(365/252) ≈ 1.20. Analogous to quant_metrics.infer_bars_per_year.
    """
    if days.size < 2:
        return TRADING_DAYS
    span_years = float(days[-1] - days[0] + 1) / 365.25
    return float(days.size / span_years) if span_years > 0 else TRADING_DAYS


def _sharpe(daily: np.ndarray, periods_per_year: float = TRADING_DAYS) -> float:
    """Annualized Sharpe of a daily dollar-P&L series (mean/std * sqrt(periods/yr))."""
    if daily.size < 2:
        return 0.0
    sd = daily.std(ddof=1)
    if sd < _EPS:
        return 0.0
    return float(daily.mean() / sd * np.sqrt(periods_per_year))


def _max_dd_pct(daily: np.ndarray, starting_capital: float) -> float:
    """Max drawdown (% of starting capital) of the cumulative dollar curve."""
    if daily.size == 0 or starting_capital <= 0:
        return 0.0
    equity = starting_capital + np.cumsum(daily)
    peak = np.maximum.accumulate(np.concatenate([[starting_capital], equity]))[1:]
    dd = (equity - peak) / starting_capital * 100.0
    return float(dd.min()) if dd.size else 0.0


# ---------------------------------------------------------------------------
# Suggested weights (advisory — the runner sizes by risk_pct + priority)
# ---------------------------------------------------------------------------

def _normalize_long(w: np.ndarray) -> np.ndarray:
    """Clip to long-only and renormalize to sum 1; fall back to equal weight."""
    w = np.where(np.isfinite(w), w, 0.0)
    w = np.clip(w, 0.0, None)
    s = w.sum()
    if s < _EPS:
        return np.full(w.shape, 1.0 / len(w))
    return w / s


def _suggested_weights(R: np.ndarray) -> dict:
    n = R.shape[1]
    mu = R.mean(axis=0)
    # Ridge-regularized covariance for numerical safety with few/degenerate days.
    cov = np.cov(R, rowvar=False)
    if cov.ndim == 0:
        cov = cov.reshape(1, 1)
    cov_r = cov + np.eye(n) * (np.trace(cov) / n * 1e-6 + _EPS)
    try:
        inv = np.linalg.pinv(cov_r)
    except np.linalg.LinAlgError:
        inv = np.eye(n)

    ones = np.ones(n)
    min_var = _normalize_long(inv @ ones)
    max_sharpe = _normalize_long(inv @ mu)

    # Equal-risk-contribution: simple fixed-point iteration on long-only weights.
    w = np.full(n, 1.0 / n)
    for _ in range(500):
        mrc = cov_r @ w                       # marginal risk contribution
        rc = w * mrc                          # risk contribution
        target = (w @ cov_r @ w) / n          # equal target
        w = w * (target / np.maximum(rc, _EPS)) ** 0.5
        w = _normalize_long(w)
    erc = w

    return {
        "min_variance": min_var.tolist(),
        "equal_risk_contribution": erc.tolist(),
        "max_sharpe": max_sharpe.tolist(),
    }


# ---------------------------------------------------------------------------
# Public entry point
# ---------------------------------------------------------------------------

def compute(per_strategy: dict, starting_capital: float) -> Optional[dict]:
    """Correlation & combination block for a portfolio result.

    Returns None when there is not enough to analyze (<2 strategies or <2
    overlapping days) so callers / the UI can simply hide the section.
    """
    sids, days, R = _daily_pnl_matrix(per_strategy)
    if len(sids) < 2 or R.shape[0] < 2:
        return None

    n = len(sids)
    corr = _corr_matrix(R)
    ppy = _periods_per_year(days)

    # --- downside correlation: days the whole portfolio is in its worst decile.
    # Correlation on <10 points is noise; require 20+ days and 10+ tail days.
    port_daily = R.sum(axis=1)
    if R.shape[0] >= 20:
        thresh = float(np.quantile(port_daily, 0.10))
        mask = port_daily <= thresh
        down_corr = _corr_matrix(R[mask]) if mask.sum() >= 10 else None
    else:
        down_corr = None

    # --- diversification ratio: sum of stand-alone vols / vol of the sum
    vols = R.std(axis=0)
    port_vol = port_daily.std()
    div_ratio = float(vols.sum() / port_vol) if port_vol > _EPS else 1.0

    # --- effective N: Herfindahl on |P&L| share + correlation participation ratio
    pnl_total = R.sum(axis=0)
    abs_share = np.abs(pnl_total)
    if abs_share.sum() > _EPS:
        p = abs_share / abs_share.sum()
        herfindahl_n = float(1.0 / np.square(p).sum())
    else:
        herfindahl_n = float(n)
    eig = np.linalg.eigvalsh(corr)
    eig = np.clip(eig, 0.0, None)
    participation_n = float(np.square(eig.sum()) / max(np.square(eig).sum(), _EPS))

    # --- drawdown overlap (tail): do strategies sink TOGETHER when it hurts?
    # A binary "below own peak" flag is ~always true for any long curve and
    # doesn't discriminate, so we use *deep* drawdown: a strategy is "deep" on
    # days its drawdown is in its own worst decile. Of the portfolio's own
    # deep-drawdown days, what fraction have >=2 strategies simultaneously deep.
    def _dd_series(col):
        eq = starting_capital + np.cumsum(col)
        return eq - np.maximum.accumulate(eq)        # <= 0, dollars below peak

    deep = np.zeros_like(R, dtype=bool)
    for j in range(n):
        dd = _dd_series(R[:, j])
        thr = np.quantile(dd, 0.10)                  # 10th pct of a <=0 series = deep
        deep[:, j] = dd <= thr
    n_deep = deep.sum(axis=1)
    port_dd = _dd_series(port_daily)
    port_thr = np.quantile(port_dd, 0.10)
    port_deep = port_dd <= port_thr
    pool_deep_days = int(port_deep.sum())
    overlap_days = int(((n_deep >= 2) & port_deep).sum())
    overlap_pct = float(overlap_days / pool_deep_days * 100.0) if pool_deep_days else 0.0
    # co-crash: days where >=2 strategies are each below their own 5th pct day.
    # A sparse strategy (mostly-flat column) has a 5th percentile of exactly 0,
    # which would count every flat day as a "crash" — require strictly negative
    # P&L for membership, and 20+ days for the percentile to mean anything.
    if R.shape[0] >= 20:
        bad_thresh = np.quantile(R, 0.05, axis=0)
        co_crash_days = int((np.sum((R <= bad_thresh) & (R < 0), axis=1) >= 2).sum())
    else:
        co_crash_days = None

    # --- leave-one-out marginal contribution
    base_sharpe = _sharpe(port_daily, ppy)
    base_maxdd = _max_dd_pct(port_daily, starting_capital)
    leave_one_out = []
    for j in range(n):
        rest = np.delete(R, j, axis=1).sum(axis=1)
        s_rest = _sharpe(rest, ppy)
        dd_rest = _max_dd_pct(rest, starting_capital)
        leave_one_out.append({
            "strategy_id": sids[j],
            "delta_sharpe": base_sharpe - s_rest,      # >0: strategy HELPS Sharpe
            # DDs are <= 0 (dollars below peak / starting capital). Removing a
            # DD-deepening strategy makes dd_rest LESS negative than base, so
            # dd_rest - base_maxdd > 0 ⇔ the strategy deepens the drawdown —
            # matching the UI legend ("Δ Max DD > 0 means it deepens").
            # (The old `base - rest` had the sign inverted vs its own comment.)
            "delta_maxdd_pct": dd_rest - base_maxdd,   # >0: strategy DEEPENS the DD
            "pnl_dollars": float(pnl_total[j]),
        })

    # --- weights
    weights = _suggested_weights(R)
    pnl_pos = np.clip(pnl_total, 0.0, None)
    weights["current_pnl_share"] = (
        (pnl_pos / pnl_pos.sum()).tolist() if pnl_pos.sum() > _EPS
        else [1.0 / n] * n
    )

    return {
        "sids": sids,
        "n_days": int(R.shape[0]),
        "return_corr": {"sids": sids, "matrix": corr.tolist()},
        "downside_corr": (
            {"sids": sids, "matrix": down_corr.tolist(), "n_days": int(mask.sum())}
            if down_corr is not None else None
        ),
        "diversification_ratio": div_ratio,
        "effective_n": {
            "herfindahl": herfindahl_n,
            "participation_ratio": participation_n,
            "n_strategies": n,
        },
        "drawdown_overlap": {
            "pool_deep_days": pool_deep_days,
            "overlap_days": overlap_days,
            "overlap_pct": overlap_pct,
            "co_crash_days": co_crash_days,
        },
        "leave_one_out": leave_one_out,
        "suggested_weights": weights,
        "base_stats": {"sharpe": base_sharpe, "max_drawdown_pct": base_maxdd},
    }


# ---------------------------------------------------------------------------
# Smoke test — fabricate three correlated daily series and print the block.
#   python -m backend.services.portfolio_correlation
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import json

    rng = np.random.default_rng(7)
    start = 100_000.0
    n_days = 180
    # A and B are positively correlated; C is independent.
    base = rng.normal(50, 400, n_days)
    a = base + rng.normal(0, 150, n_days)
    b = 0.8 * base + rng.normal(0, 150, n_days)
    c = rng.normal(30, 400, n_days)

    def to_curve(daily):
        eq = start + np.cumsum(daily)
        # one snapshot per day at noon UTC
        return [{"time": int(d * SECONDS_PER_DAY + 43200), "equity": float(e)}
                for d, e in enumerate(np.concatenate([[start], eq]))]

    per_strategy = {
        "alpha": {"equity": to_curve(a)},
        "beta":  {"equity": to_curve(b)},
        "gamma": {"equity": to_curve(c)},
    }
    res = compute(per_strategy, start)
    print(json.dumps(res, indent=2))

    # sanity assertions
    m = np.array(res["return_corr"]["matrix"])
    assert np.allclose(np.diag(m), 1.0), "diagonal must be 1"
    assert np.allclose(m, m.T), "matrix must be symmetric"
    assert m[0, 1] > m[0, 2], "alpha/beta should correlate more than alpha/gamma"
    assert res["diversification_ratio"] >= 1.0 - 1e-9, "div ratio >= 1"
    for k in ("min_variance", "equal_risk_contribution", "max_sharpe"):
        assert abs(sum(res["suggested_weights"][k]) - 1.0) < 1e-6, f"{k} sums to 1"
    print("\nOK: corr(alpha,beta)=%.3f  corr(alpha,gamma)=%.3f  div_ratio=%.3f  eff_N(pr)=%.2f"
          % (m[0, 1], m[0, 2], res["diversification_ratio"],
             res["effective_n"]["participation_ratio"]))
