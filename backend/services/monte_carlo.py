"""
Monte Carlo simulation for backtest results.

Three methods, all numpy-only (no new deps):

  trade_bootstrap   — resample the trades of an existing backtest (with
                      replacement) to estimate how much of the equity curve
                      is "luck of the order". Instant.

  block_bootstrap   — resample per-bar equity-curve returns in blocks
                      (preserves short-term autocorrelation), reconstruct
                      synthetic equity paths. Instant.

  synthetic_paths   — bootstrap per-bar OHLC relative-returns in blocks to
                      build synthetic price series, then re-run the strategy
                      on each path. Heaviest (re-runs the engine N times).

All three return a uniform shape: a few sampled paths for charting, p05/p25/
p50/p75/p95 envelopes, scalar-metric distributions, prob_profit / prob_ruin,
and the original (non-shuffled) metrics for reference.
"""
from __future__ import annotations

import logging
import math
from typing import Optional

import numpy as np
import pandas as pd

from services import backtest_engine, market_data, portfolio_runner, risk_config
from services.portfolio_runner import StrategySpec
from services.strategy_registry import get_strategy_class

log = logging.getLogger(__name__)

# How many individual paths to ship back for the fan chart. The full N_SIMS
# stay on the server for percentile/distribution math.
_MAX_PATHS_RETURNED = 50

_PCTS = (5, 25, 50, 75, 95)


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------

def run(method: str,
        strategies: list[dict],
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
        n_sims: int = 1000,
        block_size: Optional[int] = None,
        seed: int = 42) -> dict:
    """Dispatch to a method-specific engine.

    `strategies` is a non-empty list of `{strategy_id, symbol, timeframe,
    params, priority}` dicts. N=1 uses `backtest_engine.run()` for the base
    backtest (existing fast path); N≥2 uses `portfolio_runner.run_portfolio()`
    so the bootstrap operates on the basket's aggregate trades / equity.
    """
    if method not in ("trade_bootstrap", "block_bootstrap", "synthetic"):
        raise ValueError(f"unknown method: {method}")
    if not strategies:
        raise ValueError("strategies must be a non-empty list")

    is_portfolio = len(strategies) >= 2

    # All three methods start from a base backtest so we have something to
    # resample and compare against. N=1 keeps the fast direct-engine path.
    if is_portfolio:
        specs = [
            StrategySpec(
                strategy_id=s["strategy_id"],
                symbol=s["symbol"],
                timeframe=s["timeframe"],
                params=s.get("params") or {},
                priority=int(s.get("priority", i + 1)),
            )
            for i, s in enumerate(strategies)
        ]
        base = portfolio_runner.run_portfolio(
            specs, start_time=start_time, end_time=end_time,
        )
    else:
        s0 = strategies[0]
        base = backtest_engine.run(
            s0["strategy_id"], s0["symbol"], s0["timeframe"], s0.get("params") or {},
            start_time=start_time, end_time=end_time,
        )

    rng = np.random.default_rng(int(seed))
    starting_capital = float(base["stats"]["starting_capital"])

    if method == "trade_bootstrap":
        result = _trade_bootstrap(base, starting_capital, int(n_sims), rng)
    elif method == "block_bootstrap":
        bs = int(block_size) if block_size else _default_block_size(len(base["equity"]))
        result = _block_bootstrap(base, starting_capital, int(n_sims), bs, rng)
    else:
        # Synthetic paths in portfolio mode require shared (symbol, timeframe)
        # so one synthesised OHLC stream feeds every strategy. Cost is also
        # ~N× heavier so the sim cap is tighter.
        if is_portfolio:
            symbols    = {s["symbol"] for s in strategies}
            timeframes = {s["timeframe"] for s in strategies}
            if len(symbols) > 1 or len(timeframes) > 1:
                raise ValueError(
                    "synthetic_paths requires all strategies on the same "
                    "(symbol, timeframe). Use trade_bootstrap or block_bootstrap "
                    "for mixed-symbol baskets."
                )
            n_sims = max(1, min(int(n_sims), 50))    # tighter cap for portfolio
        else:
            n_sims = max(1, min(int(n_sims), 200))   # original single-strategy cap
        bs = int(block_size) if block_size else _default_block_size(len(base["candles"]) if base.get("candles") else len(base["equity"]))
        result = _synthetic_paths(strategies, start_time, end_time,
                                  n_sims, bs, rng, base, is_portfolio)

    # Attach reference metadata.
    result["method"] = method
    result["n_sims"] = int(n_sims)
    result["seed"] = int(seed)
    result["starting_capital"] = starting_capital
    result["is_portfolio"] = is_portfolio
    result["strategies"] = [
        {
            "strategy_id": s["strategy_id"],
            "symbol":      s["symbol"],
            "timeframe":   s["timeframe"],
            "params":      s.get("params") or {},
            "priority":    int(s.get("priority", i + 1)),
        }
        for i, s in enumerate(strategies)
    ]
    result["original"] = {
        "final_equity":         float(base["stats"]["final_equity"]),
        "total_return_pct":     float(base["stats"]["total_return_pct"]),
        "max_drawdown_pct":     float(base["stats"]["max_drawdown_pct"]),
        "max_drawdown_dollars": float(base["stats"]["max_drawdown_dollars"]),
        "trades":               int(base["stats"]["trades"]),
        "sharpe":               (float(base["stats"]["sharpe"])
                                 if base["stats"].get("sharpe") is not None else None),
    }
    return result


# ---------------------------------------------------------------------------
# Method 1: trade-order bootstrap
# ---------------------------------------------------------------------------

def _trade_bootstrap(base: dict, starting_capital: float, n_sims: int,
                     rng: np.random.Generator) -> dict:
    trades = base.get("trades") or []
    if not trades:
        return _empty(starting_capital, x_label="trade #")

    # Convert each trade's $-PnL into a fractional return on equity *at the
    # time of that trade in the original run* — pnl_i / equity_at_entry_i.
    # This matches the live engine's "% of equity" sizing model: under a
    # different (bootstrapped) order, applying these fractional returns via
    # cumprod correctly compounds gains and losses. The original cumsum
    # approach silently assumed fixed-cash sizing and dampened tail risk.
    pnl = np.array([float(t["pnl_dollars"]) for t in trades], dtype=float)
    n = len(pnl)
    # equity_at_entry_i = starting_capital + sum(pnl[:i]) — realized only.
    # (Ignores intra-trade unrealized for overlapping positions; close enough
    # for the bootstrap, which is an order-luck estimator anyway.)
    equity_at_entry = starting_capital + np.concatenate([[0.0], np.cumsum(pnl[:-1])])
    equity_at_entry = np.where(equity_at_entry > 1e-9, equity_at_entry, 1e-9)
    pct_returns = pnl / equity_at_entry  # length n

    # Each row of `idx` is one simulated trade order (n trades drawn with
    # replacement). Compound the sampled fractional returns; clip 1+r at 0
    # so a single -100% trade is permanent ruin (and stays at 0).
    idx = rng.integers(0, n, size=(n_sims, n))
    sampled = pct_returns[idx]                                      # (n_sims, n)
    growth = np.cumprod(np.maximum(1.0 + sampled, 0.0), axis=1)     # (n_sims, n)
    equity = starting_capital * growth                              # (n_sims, n)
    # Prepend starting capital so equity[:, 0] is the pre-trade level.
    equity = np.concatenate([np.full((n_sims, 1), starting_capital), equity], axis=1)

    # Synthetic x-axis: trade index 0..n. Use trade index as the "time" field
    # so the frontend chart code can treat it uniformly.
    x_axis = np.arange(n + 1, dtype=int)

    # No annualization for trade-index axis — report raw Sharpe per trade.
    return _summarize(equity, x_axis, starting_capital, x_label="trade #",
                      bars_per_year=0.0)


# ---------------------------------------------------------------------------
# Method 2: block bootstrap on per-bar equity returns
# ---------------------------------------------------------------------------

def _block_bootstrap(base: dict, starting_capital: float, n_sims: int,
                     block_size: int, rng: np.random.Generator) -> dict:
    eq_pts = base.get("equity") or []
    if len(eq_pts) < 3:
        return _empty(starting_capital, x_label="bar #")

    eq = np.array([p["equity"] for p in eq_pts], dtype=float)
    times = np.array([int(p["time"]) for p in eq_pts], dtype=int)

    # Per-bar simple returns of the strategy's equity curve.
    denom = np.where(np.abs(eq[:-1]) < 1e-9, 1e-9, eq[:-1])
    returns = (eq[1:] - eq[:-1]) / denom    # length n-1
    n_ret = len(returns)
    block_size = max(1, min(block_size, n_ret))

    # Circular block bootstrap: draw enough random block start indices, take
    # `block_size` consecutive returns each (wrapping past the end), then
    # truncate to the target length.
    target_len = n_ret
    n_blocks = math.ceil(target_len / block_size)

    # Vectorize: (n_sims, n_blocks) block starts -> expand to (n_sims, target_len)
    starts = rng.integers(0, n_ret, size=(n_sims, n_blocks))                 # (n_sims, n_blocks)
    offsets = np.arange(block_size)                                          # (block_size,)
    # Build (n_sims, n_blocks, block_size) of indices, then flatten last 2 axes.
    idx = (starts[:, :, None] + offsets[None, None, :]) % n_ret              # circular
    idx = idx.reshape(n_sims, n_blocks * block_size)[:, :target_len]         # (n_sims, target_len)

    sampled_returns = returns[idx]                                           # (n_sims, target_len)
    growth = np.cumprod(1.0 + sampled_returns, axis=1)                       # (n_sims, target_len)
    equity = np.concatenate([np.full((n_sims, 1), starting_capital),
                             starting_capital * growth], axis=1)             # (n_sims, target_len+1)

    return _summarize(equity, times, starting_capital, x_label="bar #",
                      bars_per_year=_bars_per_year(times))


# ---------------------------------------------------------------------------
# Method 3: synthetic price paths (block bootstrap of OHLC ratios)
# ---------------------------------------------------------------------------

def _synthetic_paths(strategies: list[dict],
                     start_time: Optional[int],
                     end_time: Optional[int],
                     n_sims: int, block_size: int,
                     rng: np.random.Generator, base: dict,
                     is_portfolio: bool) -> dict:
    """Generate N synthetic OHLC series and re-run the backtest on each.

    The synthetic bars are built from a circular block bootstrap of the
    historical per-bar relative structure:
        body_pct = close/open - 1
        high_pct = high/open - 1
        low_pct  = low/open  - 1
        gap_pct  = open_t / close_{t-1} - 1   (overnight/gap)

    For each path, we seed with the original first open and walk forward,
    reconstructing OHLC from a resampled bar template each step.

    Portfolio mode: all strategies must share the same (symbol, timeframe);
    the same synthetic OHLC feeds every strategy via `df_by_spec`.
    """
    # All strategies share (symbol, timeframe) — caller validated this.
    sym = strategies[0]["symbol"]
    tf  = strategies[0]["timeframe"]
    df = market_data.load_parquet(sym, tf)
    if start_time is not None:
        df = df[df["time"] >= int(start_time)]
    if end_time is not None:
        df = df[df["time"] <= int(end_time)]
    df = df.reset_index(drop=True)

    n_bars = len(df)
    if n_bars < 20:
        return _empty(float(base["stats"]["starting_capital"]), x_label="bar #")

    o = df["open"].to_numpy(dtype=float)
    h = df["high"].to_numpy(dtype=float)
    l = df["low"].to_numpy(dtype=float)
    c = df["close"].to_numpy(dtype=float)
    v = df["volume"].to_numpy(dtype=float)
    t = df["time"].to_numpy(dtype=int)

    body = c / o - 1.0
    hi   = h / o - 1.0
    lo   = l / o - 1.0
    gap  = np.empty(n_bars)
    gap[0]  = 0.0
    gap[1:] = o[1:] / c[:-1] - 1.0

    block_size = max(1, min(block_size, n_bars))
    starting_capital = float(base["stats"]["starting_capital"])

    sim_equity_curves: list[np.ndarray] = []
    sim_times: list[np.ndarray] = []
    sim_finals = []
    sim_returns = []
    sim_max_dd = []
    sim_dd_dur = []

    for s in range(n_sims):
        # Resample one bar-index sequence of length n_bars via circular blocks.
        n_blocks = math.ceil(n_bars / block_size)
        starts = rng.integers(0, n_bars, size=n_blocks)
        offsets = np.arange(block_size)
        idx = (starts[:, None] + offsets[None, :]).reshape(-1)[:n_bars] % n_bars

        b_body = body[idx]
        b_hi   = hi[idx]
        b_lo   = lo[idx]
        b_gap  = gap[idx]
        b_vol  = v[idx]

        # Reconstruct OHLC by walking forward.
        sim_o = np.empty(n_bars)
        sim_c = np.empty(n_bars)
        sim_o[0] = o[0]
        sim_c[0] = sim_o[0] * (1.0 + b_body[0])
        for i in range(1, n_bars):
            sim_o[i] = sim_c[i - 1] * (1.0 + b_gap[i])
            if sim_o[i] <= 0.0:
                sim_o[i] = 1e-9
            sim_c[i] = sim_o[i] * (1.0 + b_body[i])
        sim_h = sim_o * (1.0 + b_hi)
        sim_l = sim_o * (1.0 + b_lo)
        # Enforce OHLC invariants in case the bootstrap pasted a low > open etc.
        sim_h = np.maximum.reduce([sim_h, sim_o, sim_c])
        sim_l = np.minimum.reduce([sim_l, sim_o, sim_c])

        synth_df = pd.DataFrame({
            "time": t, "open": sim_o, "high": sim_h, "low": sim_l,
            "close": sim_c, "volume": b_vol,
        })

        try:
            sub = _run_on_df(strategies, synth_df, is_portfolio)
        except Exception as e:
            log.warning("synthetic path %d failed: %s", s, e)
            continue

        eq_pts = sub.get("equity") or []
        if not eq_pts:
            continue
        eq_arr = np.array([p["equity"] for p in eq_pts], dtype=float)
        sim_equity_curves.append(eq_arr)
        sim_times.append(np.array([p["time"] for p in eq_pts], dtype=int))
        sim_finals.append(float(sub["stats"]["final_equity"]))
        sim_returns.append(float(sub["stats"]["total_return_pct"]))
        sim_max_dd.append(float(sub["stats"]["max_drawdown_pct"]))
        sim_dd_dur.append(int(sub["analytics"]["max_drawdown_duration_bars"]))

    if not sim_equity_curves:
        return _empty(starting_capital, x_label="bar #")

    # Pad to a uniform length using the modal (most common) bar count — paths
    # only differ if the strategy somehow truncated. Just take the min length
    # and trim all curves to that, then summarize.
    min_len = min(len(c) for c in sim_equity_curves)
    equity = np.stack([c[:min_len] for c in sim_equity_curves], axis=0)
    x_axis = sim_times[0][:min_len]

    summary = _summarize(equity, x_axis, starting_capital, x_label="bar #",
                         bars_per_year=_bars_per_year(x_axis))

    # Override distributions with the strategy-level metrics rather than the
    # ones derived purely from per-bar equity (more meaningful for synthetic).
    summary["distribution"]["final_equity"] = _dist(np.asarray(sim_finals))
    summary["distribution"]["total_return_pct"] = _dist(np.asarray(sim_returns))
    summary["distribution"]["max_drawdown_pct"] = _dist(np.asarray(sim_max_dd))
    summary["distribution"]["max_drawdown_duration_bars"] = _dist(np.asarray(sim_dd_dur, dtype=float))
    summary["prob_profit"] = float(np.mean(np.asarray(sim_finals) > starting_capital))
    # Intra-path ruin check: any bar where simulated equity hit zero or below.
    summary["prob_ruin"]   = float(np.mean([1.0 if c.min() <= 0.0 else 0.0 for c in sim_equity_curves]))
    return summary


def _run_on_df(strategies: list[dict], synth_df: pd.DataFrame,
               is_portfolio: bool) -> dict:
    """Run a base backtest against an injected synthetic dataframe.

    Single-strategy → `backtest_engine.run(..., df=synth_df)`.
    Portfolio      → `portfolio_runner.run_portfolio(..., df_by_spec=...)`
                     with every spec receiving the same synthesised OHLC.
    Both paths are thread-safe (no module-level state mutation).
    """
    if is_portfolio:
        specs = [
            StrategySpec(
                strategy_id=s["strategy_id"],
                symbol=s["symbol"],
                timeframe=s["timeframe"],
                params=s.get("params") or {},
                priority=int(s.get("priority", i + 1)),
            )
            for i, s in enumerate(strategies)
        ]
        # Same synthetic OHLC feeds every strategy — they share the symbol/TF.
        df_by_spec = {i: synth_df for i in range(len(specs))}
        return portfolio_runner.run_portfolio(specs, df_by_spec=df_by_spec)
    s0 = strategies[0]
    return backtest_engine.run(
        s0["strategy_id"], s0["symbol"], s0["timeframe"],
        s0.get("params") or {}, df=synth_df,
    )


# ---------------------------------------------------------------------------
# Shared summarization
# ---------------------------------------------------------------------------

def _bars_per_year(times: np.ndarray) -> float:
    t = np.asarray(times, dtype=float)
    if t.size < 2:
        return 0.0
    dt = float(np.diff(t).mean())
    if dt <= 0:
        return 0.0
    return 365.25 * 24.0 * 3600.0 / dt


def _summarize(equity: np.ndarray, x_axis: np.ndarray,
               starting_capital: float, x_label: str,
               bars_per_year: float = 0.0) -> dict:
    """equity: (n_sims, n_steps).  x_axis: (n_steps,) ints (time or index)."""
    n_sims, n_steps = equity.shape
    x_axis = np.asarray(x_axis, dtype=int)
    if len(x_axis) != n_steps:
        # x_axis may be n_steps-1 if we built it from `times` (bar-level) but
        # then prepended starting cap. Pad by repeating the first.
        if len(x_axis) == n_steps - 1:
            x_axis = np.concatenate([[x_axis[0]], x_axis])
        else:
            x_axis = np.arange(n_steps, dtype=int)

    # Percentile envelopes per step.
    pcts = np.percentile(equity, _PCTS, axis=0)   # (5, n_steps)
    envelopes = {f"p{p:02d}": _to_pts(x_axis, pcts[i]) for i, p in enumerate(_PCTS)}

    # Sample a handful of full paths for the fan chart.
    k = min(_MAX_PATHS_RETURNED, n_sims)
    sample_idx = np.linspace(0, n_sims - 1, k, dtype=int)
    paths = [_to_pts(x_axis, equity[i]) for i in sample_idx]

    # Scalar metric distributions.
    final = equity[:, -1]
    ret_pct = (final / starting_capital - 1.0) * 100.0
    # Max drawdown per path (% of starting capital).
    running_peak = np.maximum.accumulate(equity, axis=1)
    dd_dollars = equity - running_peak
    max_dd_dollars = dd_dollars.min(axis=1)
    max_dd_pct = max_dd_dollars / starting_capital * 100.0
    # Longest underwater stretch per path.
    underwater = (equity < running_peak).astype(np.int32)
    dd_dur = _longest_run_per_row(underwater)

    # Per-path Sharpe distribution: mean / std of per-step equity returns,
    # annualized when bars_per_year > 0 (bar-time axis).
    sharpe_per_path = _sharpe_per_row(equity, bars_per_year)

    return {
        "x_label": x_label,
        "x_axis": [int(v) for v in x_axis.tolist()],
        "paths": paths,
        "envelopes": envelopes,
        "distribution": {
            "final_equity":               _dist(final),
            "total_return_pct":           _dist(ret_pct),
            "max_drawdown_pct":           _dist(max_dd_pct),
            "max_drawdown_duration_bars": _dist(dd_dur.astype(float)),
            "sharpe":                     _dist(sharpe_per_path),
        },
        "prob_profit": float(np.mean(final > starting_capital)),
        # Ruin = equity hit zero (or below) at ANY point on the path, not just
        # at the final step. Otherwise a path that crashed and then "recovered"
        # via lucky resampled trades would be miscounted as solvent.
        "prob_ruin":   float(np.mean((equity <= 0.0).any(axis=1))),
    }


def _sharpe_per_row(equity: np.ndarray, bars_per_year: float) -> np.ndarray:
    """Per-path Sharpe ratio over per-step equity returns."""
    if equity.shape[1] < 3:
        return np.zeros(equity.shape[0])
    denom = np.where(np.abs(equity[:, :-1]) < 1e-9, 1e-9, equity[:, :-1])
    r = (equity[:, 1:] - equity[:, :-1]) / denom
    # Mask non-finite values per row.
    r = np.where(np.isfinite(r), r, 0.0)
    mean = r.mean(axis=1)
    # ddof=1 std, but guard against zero-variance rows.
    std = r.std(axis=1, ddof=1) if r.shape[1] > 1 else np.ones(r.shape[0])
    std = np.where(std > 1e-12, std, np.nan)
    sharpe = mean / std
    if bars_per_year > 0:
        sharpe = sharpe * math.sqrt(bars_per_year)
    return np.where(np.isfinite(sharpe), sharpe, 0.0)


def _to_pts(x_axis: np.ndarray, equity_row: np.ndarray) -> list[dict]:
    return [{"x": int(x_axis[i]), "equity": float(equity_row[i])}
            for i in range(len(equity_row))]


def _dist(arr: np.ndarray) -> dict:
    arr = arr[np.isfinite(arr)]
    if arr.size == 0:
        return {"count": 0, "mean": 0.0, "std": 0.0,
                "p05": 0.0, "p25": 0.0, "p50": 0.0, "p75": 0.0, "p95": 0.0,
                "min": 0.0, "max": 0.0, "histogram": []}
    p = np.percentile(arr, _PCTS)
    # Histogram for the UI.
    bins = 30
    counts, edges = np.histogram(arr, bins=bins)
    histogram = [{"bin_lo": float(edges[i]), "bin_hi": float(edges[i + 1]),
                  "count": int(counts[i])} for i in range(bins)]
    return {
        "count": int(arr.size),
        "mean": float(arr.mean()),
        "std":  float(arr.std(ddof=1)) if arr.size > 1 else 0.0,
        "p05": float(p[0]), "p25": float(p[1]), "p50": float(p[2]),
        "p75": float(p[3]), "p95": float(p[4]),
        "min": float(arr.min()),
        "max": float(arr.max()),
        "histogram": histogram,
    }


def _longest_run_per_row(mask: np.ndarray) -> np.ndarray:
    """For each row of a (n_sims, n_steps) 0/1 mask, return the length of the
    longest run of 1s."""
    n_sims, n = mask.shape
    out = np.zeros(n_sims, dtype=np.int32)
    for i in range(n_sims):
        row = mask[i]
        if not row.any():
            continue
        # Run-length encode with a single pass.
        best = cur = 0
        for v in row:
            if v:
                cur += 1
                if cur > best:
                    best = cur
            else:
                cur = 0
        out[i] = best
    return out


def _default_block_size(n: int) -> int:
    """Politis–White rule-of-thumb default. For series of length n, use
    n^(1/3) as the block size (rounded, clamped)."""
    if n <= 4:
        return max(1, n // 2)
    return max(2, min(n // 2, int(round(n ** (1.0 / 3.0)))))


def _empty(starting_capital: float, x_label: str) -> dict:
    zero_dist = {"count": 0, "mean": 0.0, "std": 0.0,
                 "p05": 0.0, "p25": 0.0, "p50": 0.0, "p75": 0.0, "p95": 0.0,
                 "min": 0.0, "max": 0.0, "histogram": []}
    return {
        "x_label": x_label,
        "x_axis": [],
        "paths": [],
        "envelopes": {f"p{p:02d}": [] for p in _PCTS},
        "distribution": {
            "final_equity": zero_dist,
            "total_return_pct": zero_dist,
            "max_drawdown_pct": zero_dist,
            "max_drawdown_duration_bars": zero_dist,
            "sharpe": zero_dist,
        },
        "prob_profit": 0.0,
        "prob_ruin": 0.0,
    }
