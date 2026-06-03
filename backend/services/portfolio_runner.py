"""
Portfolio backtest runner — walks N strategies through ONE shared cash pool.

Design contract (from the per_strategy_risk_pct + portfolio_runner plan):
- Each strategy carries its own `risk_pct` and `pyramiding` on PARAM_SCHEMA.
- Position sizing reads the *aggregate* equity (the pool) at entry, so
  Strategy A's `risk_pct = 2%` means 2% of the portfolio's current equity.
- Cash is explicit: opening a position deducts `notional + fee`; closing
  returns `notional + pnl - fee`. If `cash < required`, the signal is
  *skipped* (no partial fill) and logged with a counterfactual P&L.
- Same-bar conflicts resolved by user-set `priority` order (low number wins).
- Symbol overlap allowed — each strategy keeps independent positions; cash
  is the only shared constraint.
- N=1 walks the same timeline as backtest_engine and produces equivalent
  trades/stats (modulo wrapping in the portfolio response shape).

Re-uses `backtest_engine._trade`, `_compute_stats`, `_compute_analytics`,
`_serialize_candles`, `_build_overlays` so the response stays shape-compatible
with the single-strategy endpoint.
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Optional

import numpy as np
import pandas as pd

from services import backtest_engine, market_data, quant_metrics, risk_config
from services.strategy_registry import get_strategy_class

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

@dataclass
class StrategySpec:
    strategy_id: str
    symbol: str
    timeframe: str
    params: dict = field(default_factory=dict)
    priority: int = 100   # lower wins same-bar conflicts


# ---------------------------------------------------------------------------
# Per-strategy stream — wraps the pre-computed signal df and indices
# ---------------------------------------------------------------------------

class _Stream:
    """Lightweight per-strategy state during the walk."""

    def __init__(self, spec: StrategySpec, strategy, sig_df: pd.DataFrame):
        self.spec = spec
        self.strategy = strategy
        self.sig_df = sig_df

        # Signal arrays — prefer raw bar-conditions (pyramiding-aware) when
        # the strategy exposes them, fall back to the one-shot entry/exit
        # arrays otherwise. Matches backtest_engine.run.
        cl_col = "cond_long"      if "cond_long"      in sig_df.columns else "entry_long"
        cs_col = "cond_short"     if "cond_short"     in sig_df.columns else "entry_short"
        el_col = "bar_exit_long"  if "bar_exit_long"  in sig_df.columns else "exit_long"
        es_col = "bar_exit_short" if "bar_exit_short" in sig_df.columns else "exit_short"

        if sig_df.empty:
            self.time_a  = np.empty(0, dtype=np.int64)
            self.open_a  = self.high_a = self.low_a = self.close_a = np.empty(0, dtype=float)
            self.cond_long_a  = self.cond_short_a = np.empty(0, dtype=bool)
            self.bxl_a = self.bxs_a = np.empty(0, dtype=bool)
            self.atr_a = None
            self.has_atr_stop = False
            self.atr_mult = 0.0
            self.has_exact_fills = False
            self.efl_a = self.efs_a = None
            self.ts_to_idx = {}
        else:
            self.time_a  = sig_df["time"].to_numpy(dtype=np.int64)
            self.open_a  = sig_df["open"].to_numpy(dtype=float)
            self.high_a  = sig_df["high"].to_numpy(dtype=float)
            self.low_a   = sig_df["low"].to_numpy(dtype=float)
            self.close_a = sig_df["close"].to_numpy(dtype=float)
            self.cond_long_a  = sig_df[cl_col].fillna(False).astype(bool).to_numpy()
            self.cond_short_a = sig_df[cs_col].fillna(False).astype(bool).to_numpy()
            self.bxl_a        = sig_df[el_col].fillna(False).astype(bool).to_numpy()
            self.bxs_a        = sig_df[es_col].fillna(False).astype(bool).to_numpy()

            self.has_atr_stop = "atr" in sig_df.columns and "atr_mult" in getattr(strategy, "p", {})
            self.atr_a    = sig_df["atr"].to_numpy(dtype=float) if self.has_atr_stop else None
            self.atr_mult = float(strategy.p["atr_mult"]) if self.has_atr_stop else 0.0

            # Option-B exact fills (stop/target/BE fill at the level, gap-protected).
            # Matches backtest_engine.run — without this the dashboard fills exits
            # at next-bar open, giving a different (worse) win rate.
            self.has_exact_fills = ("exit_fill_long" in sig_df.columns
                                    and "exit_fill_short" in sig_df.columns)
            self.efl_a = sig_df["exit_fill_long"].to_numpy(dtype=float)  if self.has_exact_fills else None
            self.efs_a = sig_df["exit_fill_short"].to_numpy(dtype=float) if self.has_exact_fills else None

            self.ts_to_idx = {int(self.time_a[i]): i for i in range(len(self.time_a))}

        # Per-strategy attribution accumulators.
        self.realized_pnl: float = 0.0
        self.realized_fees: float = 0.0
        self.trades: list[dict] = []
        # Open tranches, kept per-side.
        self.tranches_long: list[dict] = []
        self.tranches_short: list[dict] = []

        # Pyramiding cap (per side). Strategies that don't declare it use 1.
        self.max_tranches = max(1, int(float(strategy.p.get("pyramiding", 1))))

        # risk_pct (per-strategy). 3.0 fallback matches historical default.
        self.risk_frac = float(strategy.p.get("risk_pct", 3.0)) / 100.0

        # Most-recent close, used for MTM at unified timestamps where this
        # strategy doesn't have a bar.
        self.last_close: float = float(self.close_a[0]) if len(self.close_a) else 0.0

    # ---------------------------------------------------------------------
    # MTM helper
    # ---------------------------------------------------------------------
    def unrealized(self, mark: Optional[float] = None) -> float:
        """Sum of unrealized P&L for this strategy's open tranches."""
        m = float(mark) if mark is not None else self.last_close
        u = 0.0
        for tr in self.tranches_long:
            u += (m - tr["entry_price"]) * tr["units"]
        for tr in self.tranches_short:
            u += (tr["entry_price"] - m) * tr["units"]
        return u

    def locked_notional(self) -> float:
        """Cash currently locked in this strategy's open positions."""
        v = 0.0
        for tr in self.tranches_long:
            v += abs(tr["entry_price"] * tr["units"])
        for tr in self.tranches_short:
            v += abs(tr["entry_price"] * tr["units"])
        return v


# ---------------------------------------------------------------------------
# Portfolio state — the shared cash pool and the snapshot history
# ---------------------------------------------------------------------------

@dataclass
class PortfolioState:
    starting_capital: float
    cash: float
    equity_curve: list[dict] = field(default_factory=list)
    skipped_signals: list[dict] = field(default_factory=list)
    peak_equity: float = 0.0

    def __post_init__(self):
        self.peak_equity = float(self.starting_capital)


# ---------------------------------------------------------------------------
# Counterfactual P&L for a skipped entry
# ---------------------------------------------------------------------------

def _counterfactual_pnl(stream: _Stream, signal_idx: int, side: str,
                        equity_at_signal: float, fee_pct: float,
                        fee_flat: float, slippage: float) -> Optional[float]:
    """Find the strategy's next same-side exit (or end of data) and compute
    what the trade would have made if it had filled. signal_idx is the bar
    where the entry signal was observed (entry fills at the NEXT bar's open).
    """
    fill_bar = signal_idx + 1
    if fill_bar >= len(stream.time_a):
        return None
    if side == "long":
        entry_fill = float(stream.open_a[fill_bar]) * (1.0 + slippage)
    else:
        entry_fill = float(stream.open_a[fill_bar]) * (1.0 - slippage)
    if entry_fill <= 0:
        return None
    units = (equity_at_signal * stream.risk_frac) / entry_fill
    fee_open = fee_flat + abs(entry_fill * units) * fee_pct

    # Walk forward looking for the same-side exit. We mirror the engine: act
    # on `bxl_a[k]` to close at the *next* bar's open.
    exit_arr = stream.bxl_a if side == "long" else stream.bxs_a
    n = len(stream.time_a)
    for k in range(fill_bar, n - 1):
        if exit_arr[k]:
            if side == "long":
                exit_fill = float(stream.open_a[k + 1]) * (1.0 - slippage)
                pnl = (exit_fill - entry_fill) * units
            else:
                exit_fill = float(stream.open_a[k + 1]) * (1.0 + slippage)
                pnl = (entry_fill - exit_fill) * units
            fee_close = fee_flat + abs(exit_fill * units) * fee_pct
            return float(pnl - fee_open - fee_close)
    # No exit until end — mark to final close.
    final_close = float(stream.close_a[-1])
    if side == "long":
        pnl = (final_close - entry_fill) * units
    else:
        pnl = (entry_fill - final_close) * units
    fee_close = fee_flat + abs(final_close * units) * fee_pct
    return float(pnl - fee_open - fee_close)


# ---------------------------------------------------------------------------
# Public runner
# ---------------------------------------------------------------------------

def run_portfolio(specs: list[StrategySpec],
                  start_time: Optional[int] = None,
                  end_time: Optional[int] = None,
                  risk_overrides: Optional[dict] = None,
                  df_by_spec: Optional[dict] = None) -> dict:
    """Walk 1..N strategies through a single shared cash pool.

    Same-bar conflicts resolved by `spec.priority` (low number wins). When a
    new entry's required notional exceeds available cash, the signal is
    skipped (no partial fill) and logged with a counterfactual P&L.

    `df_by_spec`: optional override map keyed by ORIGINAL spec index (position
    in the `specs` list before priority sort). When a spec has a df here, it
    is used directly instead of `market_data.load_parquet(...)`. Synthetic
    Monte Carlo uses this to inject simulated OHLC without monkey-patching
    the loader.
    """
    if not specs:
        raise ValueError("at least one StrategySpec is required")

    rc = risk_config.get()
    if risk_overrides:
        rc = {**rc, **risk_overrides}
    starting_capital = float(rc["starting_capital"])
    fee_flat         = float(rc["fee_flat"])
    fee_pct          = float(rc["fee_pct"]) / 100.0
    slippage         = float(rc["slippage_bps"]) / 10000.0

    # Sort by priority (stable for ties to preserve user list order). Keep
    # the original index alongside each spec so df_by_spec lookups work.
    ordered = sorted(enumerate(specs), key=lambda iv: (iv[1].priority, iv[0]))

    # Materialize each stream: load (or inject) parquet, run vectorized signals.
    streams: list[_Stream] = []
    for orig_idx, spec in ordered:
        cls = get_strategy_class(spec.strategy_id)
        strategy = cls(spec.params or {})
        injected = df_by_spec.get(orig_idx) if df_by_spec else None
        df = injected.copy() if injected is not None else market_data.load_parquet(spec.symbol, spec.timeframe)
        if start_time is not None:
            df = df[df["time"] >= int(start_time)]
        if end_time is not None:
            df = df[df["time"] <= int(end_time)]
        df = df.reset_index(drop=True)

        # Per-symbol backtest start floor declared by the strategy (e.g. Lunar on
        # ES restricts the dashboard to 2018+ to match the TS reference). Only
        # applied when no explicit start_time was passed (date picker overrides).
        sym_start = getattr(strategy, "SYMBOL_BACKTEST_START", {}).get(spec.symbol)
        if sym_start and start_time is None and not df.empty:
            from datetime import datetime, timezone
            floor_ts = int(datetime.strptime(sym_start, "%Y-%m-%d")
                           .replace(tzinfo=timezone.utc).timestamp())
            df = df[df["time"] >= floor_ts].reset_index(drop=True)

        sig_df = strategy.vectorized(df) if not df.empty else df
        streams.append(_Stream(spec, strategy, sig_df))

    # Unified timeline = union of all streams' bar timestamps.
    all_ts: set[int] = set()
    for s in streams:
        all_ts.update(int(t) for t in s.time_a)
    if not all_ts:
        return _empty_portfolio_result([s for _, s in ordered], rc)
    timeline = np.array(sorted(all_ts), dtype=np.int64)

    state = PortfolioState(starting_capital=starting_capital, cash=starting_capital)

    # ---- Walk ----------------------------------------------------------
    for ts in timeline:
        ts_i = int(ts)

        # Determine which streams have a current bar at this ts and their idx.
        active = []  # (stream, idx) where idx >= 1 — we need a prior bar to act.
        for s in streams:
            idx = s.ts_to_idx.get(ts_i)
            if idx is None:
                continue
            if idx >= 1:
                active.append((s, idx))
            # Update last_close opportunistically even on idx=0 so MTM has a
            # reasonable mark from the start.
            s.last_close = float(s.close_a[idx])

        # ---- Phase A: exits (priority order). Close-first frees cash for
        # subsequent same-bar entries.
        for s, t in active:
            _process_exits(s, t, state, fee_flat, fee_pct, slippage, starting_capital)

        # Current portfolio equity AFTER exits, used to size new entries.
        # We snapshot at PREVIOUS close of each stream that has data, which
        # matches the legacy engine's `cur_eq` computed at prev_close.
        cur_eq = state.cash + sum(s.unrealized() for s in streams)

        # ---- Phase B: entries (priority order). Honest cash gating.
        for s, t in active:
            _process_entries(s, t, ts_i, state, cur_eq, fee_flat, fee_pct,
                             slippage, starting_capital)

        # ---- Phase C: MAE/MFE update for any open tranche using THIS bar's
        # range (per-stream).
        for s, t in active:
            hi_t = s.high_a[t]
            lo_t = s.low_a[t]
            for tr in s.tranches_long:
                if hi_t > tr["mfe_price"]: tr["mfe_price"] = float(hi_t)
                if lo_t < tr["mae_price"]: tr["mae_price"] = float(lo_t)
            for tr in s.tranches_short:
                if lo_t < tr["mfe_price"]: tr["mfe_price"] = float(lo_t)
                if hi_t > tr["mae_price"]: tr["mae_price"] = float(hi_t)

        # ---- Phase D: MTM snapshot using close prices for the streams that
        # had a bar this step, last_close for those that didn't.
        per_strategy_eq: dict[str, float] = {}
        for s in streams:
            sid = s.spec.strategy_id
            # synthetic per-strategy equity: starting + realized + unrealized
            per_strategy_eq[sid] = (
                state.starting_capital + s.realized_pnl + s.unrealized()
            )
        total_eq = state.cash + sum(s.unrealized() for s in streams) \
                   + sum(s.locked_notional() for s in streams)
        # total_eq = cash + locked + unrealized. Locked + unrealized = MTM
        # value of all open positions. cash + that = equity.

        state.peak_equity = max(state.peak_equity, total_eq)
        state.equity_curve.append({
            "time": ts_i,
            "equity": float(total_eq),
            "value": float(total_eq) / starting_capital * 100.0,
            "drawdown": (float(total_eq) - state.peak_equity) / starting_capital * 100.0,
            "drawdown_dollars": float(total_eq) - state.peak_equity,
            "per_strategy": {sid: float(v) for sid, v in per_strategy_eq.items()},
        })

    # ---- Force-close any positions still open at the end of the walk.
    # We mark at each stream's last known close. Same accounting as engine.
    final_ts = int(timeline[-1])
    for s in streams:
        if not (s.tranches_long or s.tranches_short):
            continue
        final_close = s.last_close
        for tr in list(s.tranches_long):
            _close_tranche(s, tr, "long", final_close, final_ts, state,
                           fee_flat, fee_pct, slippage, starting_capital,
                           slipped=False)
        for tr in list(s.tranches_short):
            _close_tranche(s, tr, "short", final_close, final_ts, state,
                           fee_flat, fee_pct, slippage, starting_capital,
                           slipped=False)
        s.tranches_long.clear()
        s.tranches_short.clear()

    # ---- Build result -------------------------------------------------
    aggregate_trades = []
    for s in streams:
        for tr in s.trades:
            aggregate_trades.append({**tr, "strategy_id": s.spec.strategy_id,
                                     "symbol": s.spec.symbol})
    aggregate_trades.sort(key=lambda t: t["entry_time"])

    final_equity = state.equity_curve[-1]["equity"] if state.equity_curve else starting_capital

    # Aggregate stats use the existing engine helpers — feed the merged
    # trades and the portfolio equity curve.
    equity_arr     = np.array([p["equity"] for p in state.equity_curve], dtype=float)
    dd_dollars_arr = np.array([p["drawdown_dollars"] for p in state.equity_curve], dtype=float)
    time_arr       = np.array([p["time"] for p in state.equity_curve], dtype=np.int64)

    stats = backtest_engine._compute_stats(
        aggregate_trades, final_equity, dd_dollars_arr, time_arr,
        starting_capital, equity_arr,
    )

    # Aggregate analytics: pass a stub strategy with no sessions config so the
    # by-session block lands in 'unknown'. Per-strategy analytics (below)
    # carry the per-strategy session breakdown.
    class _NoSessionsStub:
        p = {"sessions": {}}
    # Use the first stream's sig_df for `sig_df` arg (only time array is read
    # for exposure %). Trades reference each strategy's symbol but exposure
    # currently maps via time → idx — works as long as the unified timeline
    # is used. Pass the equity-curve time grid instead.
    agg_sig_df = pd.DataFrame({"time": time_arr})
    aggregate_equity_for_analytics = [
        {"time": p["time"], "equity": p["equity"],
         "value": p["value"], "drawdown": p["drawdown"]}
        for p in state.equity_curve
    ]
    analytics = backtest_engine._compute_analytics(
        aggregate_trades, aggregate_equity_for_analytics, agg_sig_df,
        _NoSessionsStub(), starting_capital,
    )

    # Per-strategy block: trades, synthetic equity curve, stats, analytics.
    per_strategy: dict[str, dict] = {}
    for s in streams:
        sid = s.spec.strategy_id
        tr_list = [{**tr, "strategy_id": sid, "symbol": s.spec.symbol}
                   for tr in s.trades]
        # Synthetic per-strategy equity curve — same time grid as aggregate,
        # value = starting_capital + cumulative pnl for this sid at each ts.
        eq_curve = []
        running_pnl = 0.0
        # Build a quick lookup of realized pnl deltas at each ts for this sid.
        delta_at_ts = defaultdict(float)
        for tr in s.trades:
            delta_at_ts[int(tr["exit_time"])] += float(tr["pnl_dollars"])
        # walk
        peak = starting_capital
        for p in state.equity_curve:
            t = p["time"]
            running_pnl += delta_at_ts.get(t, 0.0)
            # Per-strategy MTM at this ts: starting + realized so far + the
            # strategy's unrealized stored in the snapshot's per_strategy.
            psd = float(p["per_strategy"].get(sid, starting_capital + running_pnl))
            peak = max(peak, psd)
            eq_curve.append({
                "time": t,
                "equity": psd,
                "value": psd / starting_capital * 100.0,
                "drawdown": (psd - peak) / starting_capital * 100.0,
                "drawdown_dollars": psd - peak,
            })

        eq_arr_s = np.array([p["equity"] for p in eq_curve], dtype=float)
        dd_arr_s = np.array([p["drawdown_dollars"] for p in eq_curve], dtype=float)
        time_arr_s = np.array([p["time"] for p in eq_curve], dtype=np.int64)
        final_eq_s = eq_curve[-1]["equity"] if eq_curve else starting_capital
        stats_s = backtest_engine._compute_stats(
            tr_list, final_eq_s, dd_arr_s, time_arr_s,
            starting_capital, eq_arr_s,
        )
        analytics_s = backtest_engine._compute_analytics(
            tr_list, eq_curve, s.sig_df, s.strategy, starting_capital,
        )
        per_strategy[sid] = {
            "spec": {
                "strategy_id": sid,
                "symbol": s.spec.symbol,
                "timeframe": s.spec.timeframe,
                "params": s.strategy.p,
                "priority": s.spec.priority,
            },
            "trades": tr_list,
            "equity": eq_curve,
            "stats": stats_s,
            "analytics": analytics_s,
            "candles": backtest_engine._serialize_candles(
                s.sig_df[["time", "open", "high", "low", "close", "volume"]]
            ) if not s.sig_df.empty else [],
            "overlays": backtest_engine._build_overlays(s.strategy, s.sig_df, s.time_a)
                        if not s.sig_df.empty else [],
        }

    log.info("[portfolio] %d strategies, %d unified bars, %d aggregate trades, "
             "%d skipped, final $%s (%.2f%%)",
             len(streams), len(timeline), len(aggregate_trades),
             len(state.skipped_signals),
             f"{final_equity:,.2f}",
             (final_equity / starting_capital - 1.0) * 100.0)

    return {
        "strategies": [
            {"strategy_id": s.spec.strategy_id, "symbol": s.spec.symbol,
             "timeframe": s.spec.timeframe, "priority": s.spec.priority,
             "params": s.strategy.p}
            for s in streams
        ],
        "risk_config": rc,
        "trades": aggregate_trades,
        "equity": state.equity_curve,
        "skipped_signals": state.skipped_signals,
        "stats": stats,
        "analytics": analytics,
        "per_strategy": per_strategy,
    }


# ---------------------------------------------------------------------------
# Exit / entry processing — kept symmetric with backtest_engine but operating
# on a single _Stream + shared PortfolioState.
# ---------------------------------------------------------------------------

def _process_exits(s: _Stream, t: int, state: PortfolioState,
                   fee_flat: float, fee_pct: float, slippage: float,
                   starting_capital: float) -> None:
    """Close any open tranche whose exit condition fired at bar t-1."""
    op = float(s.open_a[t])
    prev_close = float(s.close_a[t - 1])
    ts = int(s.time_a[t])

    # Longs
    still_long: list[dict] = []
    for tr in s.tranches_long:
        mean_revert = bool(s.bxl_a[t - 1])
        stop_hit = False
        if s.has_atr_stop and np.isfinite(tr["atr_at_entry"]):
            stop_hit = prev_close <= tr["entry_price"] - s.atr_mult * tr["atr_at_entry"]
        if mean_revert or stop_hit:
            # Option-B: exact stop/target/BE fill level when the strategy provides it.
            if s.has_exact_fills and mean_revert and np.isfinite(s.efl_a[t - 1]):
                fill = float(s.efl_a[t - 1]) * (1.0 - slippage)
            else:
                fill = op * (1.0 - slippage)
            _close_tranche(s, tr, "long", fill, ts, state,
                           fee_flat, fee_pct, slippage, starting_capital,
                           slipped=True)
        else:
            still_long.append(tr)
    s.tranches_long = still_long

    # Shorts
    still_short: list[dict] = []
    for tr in s.tranches_short:
        mean_revert = bool(s.bxs_a[t - 1])
        stop_hit = False
        if s.has_atr_stop and np.isfinite(tr["atr_at_entry"]):
            stop_hit = prev_close >= tr["entry_price"] + s.atr_mult * tr["atr_at_entry"]
        if mean_revert or stop_hit:
            # Option-B: exact stop/target/BE fill level when the strategy provides it.
            if s.has_exact_fills and mean_revert and np.isfinite(s.efs_a[t - 1]):
                fill = float(s.efs_a[t - 1]) * (1.0 + slippage)
            else:
                fill = op * (1.0 + slippage)
            _close_tranche(s, tr, "short", fill, ts, state,
                           fee_flat, fee_pct, slippage, starting_capital,
                           slipped=True)
        else:
            still_short.append(tr)
    s.tranches_short = still_short


def _close_tranche(s: _Stream, tr: dict, side: str, fill: float, ts: int,
                   state: PortfolioState, fee_flat: float, fee_pct: float,
                   slippage: float, starting_capital: float,
                   slipped: bool) -> None:
    """Close a single tranche, update cash + per-strategy realized pnl, and
    record the trade. `slipped=False` for forced end-of-data closes which
    use the close price directly."""
    notional_close = abs(fill * tr["units"])
    fee_close = fee_flat + notional_close * fee_pct
    if side == "long":
        pnl = (fill - tr["entry_price"]) * tr["units"] - fee_close
    else:
        pnl = (tr["entry_price"] - fill) * tr["units"] - fee_close

    # Cash: release the notional collateral plus the pnl (already net of close fee).
    state.cash += abs(tr["entry_price"] * tr["units"]) + pnl
    s.realized_pnl += pnl

    s.trades.append(backtest_engine._trade(
        side, tr["entry_price"], fill, tr["entry_time"], ts,
        pnl, tr["units"], tr["fee_open"] + fee_close,
        starting_capital=starting_capital,
        mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
    ))


def _process_entries(s: _Stream, t: int, ts_i: int, state: PortfolioState,
                     cur_eq: float, fee_flat: float, fee_pct: float,
                     slippage: float, starting_capital: float) -> None:
    """Open new tranches for any entry signals at bar t-1. Cash-gated."""
    op = float(s.open_a[t])

    def _try_open(side: str, cond_arr, tranches, slip_sign: float) -> None:
        if not cond_arr[t - 1]:
            return
        if len(tranches) >= s.max_tranches:
            return
        if cur_eq <= 0:
            return
        fill = op * (1.0 + slip_sign * slippage)
        if fill <= 0:
            return
        units = (cur_eq * s.risk_frac) / fill
        notional = abs(fill * units)
        fee_open = fee_flat + notional * fee_pct
        required = notional + fee_open
        if state.cash < required:
            # Skip + log with counterfactual.
            would_be = _counterfactual_pnl(
                s, t - 1, side, cur_eq, fee_pct, fee_flat, slippage
            )
            state.skipped_signals.append({
                "time": ts_i,
                "strategy_id": s.spec.strategy_id,
                "symbol": s.spec.symbol,
                "side": side,
                "required_notional": float(notional),
                "available_cash": float(state.cash),
                "would_be_pnl": float(would_be) if would_be is not None else None,
                "reason": "insufficient_cash",
            })
            return

        # Fill
        state.cash -= required
        # Mirror backtest_engine: charge fee_open immediately to realized
        # P&L so per-strategy attribution matches the cash impact.
        s.realized_pnl -= fee_open
        atr_at_entry = (float(s.atr_a[t - 1])
                        if (s.has_atr_stop and np.isfinite(s.atr_a[t - 1]))
                        else float("nan"))
        tranches.append({
            "entry_price": fill,
            "units":       units,
            "fee_open":    fee_open,
            "atr_at_entry": atr_at_entry,
            "entry_time":  ts_i,
            "mae_price":   fill,
            "mfe_price":   fill,
        })

    _try_open("long",  s.cond_long_a,  s.tranches_long,  +1.0)
    _try_open("short", s.cond_short_a, s.tranches_short, -1.0)


# ---------------------------------------------------------------------------
# Empty-data fallback (no bars across any stream)
# ---------------------------------------------------------------------------

def _empty_portfolio_result(specs: list[StrategySpec], rc: dict) -> dict:
    starting_capital = float(rc["starting_capital"])
    empty_stats = {
        "starting_capital": starting_capital,
        "final_equity": starting_capital,
        "total_return_dollars": 0.0, "total_return_pct": 0.0,
        "trades": 0, "wins": 0, "losses": 0, "win_rate": 0.0,
        "profit_factor": 0.0, "sharpe": 0.0,
        "gross_profit": 0.0, "gross_loss": 0.0,
        "max_drawdown_pct": 0.0, "max_drawdown_pct_peak": 0.0,
        "max_drawdown_dollars": 0.0,
        "avg_pnl_dollars": 0.0, "avg_pnl_pct": 0.0,
        "long":  {"trades": 0, "wins": 0, "losses": 0, "pnl_dollars": 0.0,
                  "win_rate": 0.0, "avg_pnl_dollars": 0.0},
        "short": {"trades": 0, "wins": 0, "losses": 0, "pnl_dollars": 0.0,
                  "win_rate": 0.0, "avg_pnl_dollars": 0.0},
        "first_time": None, "last_time": None,
    }
    empty_analytics = {
        "by_session": [], "heatmap": {"pnl": [[0]*24]*7, "count": [[0]*24]*7},
        "monthly_returns": [], "streaks": {"max_win_streak": 0, "max_loss_streak": 0},
        "drawdown_curve": [], "max_drawdown_duration_bars": 0,
        "distribution_pnl_pct": [], "distribution_duration_min": [],
        "best_trade": None, "worst_trade": None, "exposure_pct": 0.0,
        "commission_dollars": 0.0, "trading_days": 0,
        "advanced": quant_metrics.compute([], [], starting_capital, 0.0),
    }
    return {
        "strategies": [
            {"strategy_id": s.strategy_id, "symbol": s.symbol,
             "timeframe": s.timeframe, "priority": s.priority,
             "params": s.params}
            for s in specs
        ],
        "risk_config": rc,
        "trades": [], "equity": [], "skipped_signals": [],
        "stats": empty_stats, "analytics": empty_analytics,
        "per_strategy": {},
    }
