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

from services import (backtest_engine, market_data, quant_metrics, risk_config,
                      assets, portfolio_correlation, event_bus)
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
    broker: Optional[str] = None   # which broker namespace to load from (None = first-found)


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
            self.has_entry_fills = False
            self.efl_in_a = self.efs_in_a = None
            self.has_risk_scale = False
            self.risk_scale_a = None
            self.has_scale_out = False
            self.scl_a = self.scs_a = None
            self.scale_out_frac = 0.0
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

            # Option-B exact ENTRY fills (stop/limit level, gap-protected). Opt-in —
            # mirrors backtest_engine so N=1 stays equivalent. Strategies without these
            # columns fall back to next-bar-open entries (unchanged behavior).
            self.has_entry_fills = ("entry_fill_long" in sig_df.columns
                                    and "entry_fill_short" in sig_df.columns)
            self.efl_in_a = sig_df["entry_fill_long"].to_numpy(dtype=float)  if self.has_entry_fills else None
            self.efs_in_a = sig_df["entry_fill_short"].to_numpy(dtype=float) if self.has_entry_fills else None

            # Opt-in engine hooks (mirror backtest_engine): per-bar risk multiplier
            # (ATR sizing) + partial scale-out. Absent => unchanged behavior.
            self.has_risk_scale = "risk_scale" in sig_df.columns
            self.risk_scale_a   = sig_df["risk_scale"].to_numpy(dtype=float) if self.has_risk_scale else None
            self.has_scale_out  = ("scale_exit_long" in sig_df.columns and "scale_exit_short" in sig_df.columns)
            self.scl_a = sig_df["scale_exit_long"].fillna(False).astype(bool).to_numpy()  if self.has_scale_out else None
            self.scs_a = sig_df["scale_exit_short"].fillna(False).astype(bool).to_numpy() if self.has_scale_out else None
            self.scale_out_frac = (float(sig_df["scale_out_frac"].iloc[0])
                                   if self.has_scale_out and "scale_out_frac" in sig_df.columns else 0.0)
            if not (0.0 < self.scale_out_frac < 1.0):
                self.has_scale_out = False

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

        # LOOK-AHEAD (diagnostic, fictitious): when on, entries act on THIS bar's
        # OWN signal and fill at the bar's most favorable extreme (low for longs,
        # high for shorts) instead of the next-bar open. Read straight from the
        # request params — it's not a per-strategy schema field, so it would be
        # dropped from strategy.p. Mirrors backtest_engine so N=1 stays equivalent.
        self.look_ahead = bool((spec.params or {}).get(
            "look_ahead", getattr(strategy, "p", {}).get("look_ahead", False)))

        # Instrument-driven futures sizing: index futures (asset_class
        # 'equity_index_future', e.g. ES contract_size=50) size as N contracts ×
        # multiplier so P&L scales to TS dollars ($50/pt). Crypto/commodities stay
        # %-of-equity. Futures use margin not cash, so the cash gate is bypassed
        # below (the collateral/locked_notional accounting still nets out in total_eq).
        _broker = spec.broker or market_data.broker_for(spec.symbol, spec.timeframe)
        _meta   = assets.get(spec.symbol, _broker or market_data.BROKER_DEFAULT)
        self.contract_sizing = (_meta.asset_class in ("equity_index_future", "futures") and _meta.contract_size > 1.0)
        self.n_contracts     = float(strategy.p.get("contracts", 1)) if self.contract_sizing else 0.0
        self.contract_units  = self.n_contracts * float(_meta.contract_size) if self.contract_sizing else 0.0
        # Fee config (set by run_portfolio after rc is read). Futures: flat $/contract;
        # crypto/spot: flat + %-notional.
        self.fee_flat = 0.0
        self.fee_pct  = 0.0
        self.futures_commission = 0.0

        # Most-recent close, used for MTM at unified timestamps where this
        # strategy doesn't have a bar. Must be initialised here so cross-broker
        # portfolios (e.g. BTCUSDT + ES) — whose timelines don't fully overlap —
        # have a valid mark on bars where this stream is idle before its first.
        self.last_close: float = float(self.close_a[0]) if len(self.close_a) else 0.0

    def fee(self, notional: float) -> float:
        if self.contract_sizing:
            return self.fee_flat + self.futures_commission * self.n_contracts
        return self.fee_flat + abs(notional) * self.fee_pct

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
        """Cash currently locked in this strategy's open positions.

        Futures (contract_sizing) are margin-based: opening them deducts only
        the fee from cash (see _process_entries), so nothing is "locked" —
        returning 0 keeps the equity identity cash + locked + unrealized exact.
        """
        if self.contract_sizing:
            return 0.0
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
    units = stream.contract_units if stream.contract_sizing else (equity_at_signal * stream.risk_frac) / entry_fill
    fee_open = stream.fee(entry_fill * units)

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
            fee_close = stream.fee(exit_fill * units)
            return float(pnl - fee_open - fee_close)
    # No exit until end — mark to final close.
    final_close = float(stream.close_a[-1])
    if side == "long":
        pnl = (final_close - entry_fill) * units
    else:
        pnl = (entry_fill - final_close) * units
    fee_close = stream.fee(final_close * units)
    return float(pnl - fee_open - fee_close)


# ---------------------------------------------------------------------------
# Public runner
# ---------------------------------------------------------------------------

def _benchmark_closes(sig_df: pd.DataFrame, n: int = 400) -> list[dict]:
    """A tiny buy-and-hold reference series: [{time, close}] downsampled to ~n.

    Buy-and-hold is one of the validation gates ("does the strategy beat simply
    holding the asset?"), and the Analytics chart that draws it already samples
    to 400 points — so shipping all 221k bars just to draw 400 was waste. First
    and last bars are always kept, so the total buy-and-hold return computed
    from the endpoints is exact, not approximated.
    """
    m = len(sig_df)
    if m == 0:
        return []
    idx = sorted(set(np.linspace(0, m - 1, min(n, m)).astype(int).tolist()) | {0, m - 1})
    t = sig_df["time"].to_numpy()
    c = sig_df["close"].to_numpy(dtype=float)
    return [{"time": int(t[i]), "close": float(c[i])} for i in idx]


def _load_spec_df(spec: StrategySpec, strategy,
                  start_time: Optional[int], end_time: Optional[int],
                  injected: Optional[pd.DataFrame] = None) -> pd.DataFrame:
    """Load (or accept) this spec's OHLCV and apply the request window plus any
    per-symbol backtest floor/cap the strategy declares.

    Factored out of run_portfolio so `chart_data()` can reproduce EXACTLY the
    same bar window without running the portfolio walk.
    """
    df = injected.copy() if injected is not None else market_data.load_parquet(
        spec.symbol, spec.timeframe, broker=spec.broker)
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

    # Symmetric end cap (e.g. Lunar on ES restricts to TS's window ~Apr 2026).
    sym_end = getattr(strategy, "SYMBOL_BACKTEST_END", {}).get(spec.symbol)
    if sym_end and end_time is None and not df.empty:
        from datetime import datetime, timezone
        cap_ts = int(datetime.strptime(sym_end, "%Y-%m-%d")
                     .replace(tzinfo=timezone.utc).timestamp())
        df = df[df["time"] <= cap_ts].reset_index(drop=True)
    return df


def chart_data(specs: list[StrategySpec],
               start_time: Optional[int] = None,
               end_time: Optional[int] = None) -> dict:
    """Per-bar CHART data only — candles, overlays, regime bands. No walk.

    The dashboard fetches this lazily when the Chart tab opens, instead of the
    portfolio response carrying it for every strategy on every run (that was
    ~180 MB of the old 649 MB payload — see portfolio_routes._slim_for_wire).

    Candles are emitted ONCE per (symbol, timeframe, broker) dataset rather
    than once per strategy: strategies sharing a dataset share byte-identical
    OHLCV, so N copies were pure duplication.

    Returns {candles_by_dataset, dataset_key_by_strategy,
             overlays_by_strategy, regime_segments_by_strategy}.
    """
    candles_by_dataset: dict[str, list] = {}
    dataset_key_by_strategy: dict[str, str] = {}
    overlays_by_strategy: dict[str, list] = {}
    regime_by_strategy: dict[str, dict] = {}

    for spec in specs:
        cls = get_strategy_class(spec.strategy_id)
        strategy = cls(spec.params or {})
        df = _load_spec_df(spec, strategy, start_time, end_time)
        sig_df = strategy.vectorized(df) if not df.empty else df
        if sig_df.empty:
            overlays_by_strategy[spec.strategy_id] = []
            regime_by_strategy[spec.strategy_id] = {}
            continue

        key = f"{spec.symbol}|{spec.timeframe}|{spec.broker or ''}"
        dataset_key_by_strategy[spec.strategy_id] = key
        if key not in candles_by_dataset:
            candles_by_dataset[key] = backtest_engine._serialize_candles(
                sig_df[["time", "open", "high", "low", "close", "volume"]])

        time_a = sig_df["time"].to_numpy(dtype=np.int64)
        overlays_by_strategy[spec.strategy_id] = backtest_engine._build_overlays(
            strategy, sig_df, time_a)
        regime_by_strategy[spec.strategy_id] = backtest_engine._regime_segments(
            sig_df, strategy.p)

    return {
        "candles_by_dataset": candles_by_dataset,
        "dataset_key_by_strategy": dataset_key_by_strategy,
        "overlays_by_strategy": overlays_by_strategy,
        "regime_segments_by_strategy": regime_by_strategy,
    }


def run_portfolio(specs: list[StrategySpec],
                  start_time: Optional[int] = None,
                  end_time: Optional[int] = None,
                  risk_overrides: Optional[dict] = None,
                  df_by_spec: Optional[dict] = None,
                  sid: Optional[str] = None,
                  with_chart_data: bool = True) -> dict:
    """Walk 1..N strategies through a single shared cash pool.

    Same-bar conflicts resolved by `spec.priority` (low number wins). When a
    new entry's required notional exceeds available cash, the signal is
    skipped (no partial fill) and logged with a counterfactual P&L.

    `df_by_spec`: optional override map keyed by ORIGINAL spec index (position
    in the `specs` list before priority sort). When a spec has a df here, it
    is used directly instead of `market_data.load_parquet(...)`. Synthetic
    Monte Carlo uses this to inject simulated OHLC without monkey-patching
    the loader.

    `with_chart_data=False` skips building the per-bar candles / overlays /
    regime bands in each per_strategy block. Callers that only need equity,
    trades and stats (the dashboard endpoint, Monte Carlo) should pass False —
    building them for 6 strategies over 221k bars cost ~180 MB of payload and
    ~17s of serialization. Fetch them via `chart_data()` instead.
    """
    if not specs:
        raise ValueError("at least one StrategySpec is required")

    # Live progress → the requesting client's socket (no-op when sid is absent).
    def _emit(payload):
        if sid:
            event_bus.emit("backtest_progress", payload, to=sid)

    rc = risk_config.get()
    if risk_overrides:
        rc = {**rc, **risk_overrides}
    starting_capital = float(rc["starting_capital"])
    fee_flat         = float(rc["fee_flat"])
    fee_pct          = float(rc["fee_pct"]) / 100.0
    futures_commission = float(rc.get("futures_commission", 0.0))  # $/contract/side
    slippage         = float(rc["slippage_bps"]) / 10000.0

    # Sort by priority (stable for ties to preserve user list order). Keep
    # the original index alongside each spec so df_by_spec lookups work.
    ordered = sorted(enumerate(specs), key=lambda iv: (iv[1].priority, iv[0]))

    # Materialize each stream: load (or inject) parquet, run vectorized signals.
    streams: list[_Stream] = []
    n_specs = len(ordered)
    for _i, (orig_idx, spec) in enumerate(ordered):
        cls = get_strategy_class(spec.strategy_id)
        strategy = cls(spec.params or {})
        # Announce which strategy we're computing (and whether it's the slow HMM
        # path), and hand the strategy a sid so its HMM fit can stream sub-progress.
        _sparams = spec.params or {}
        _is_hmm = bool(_sparams.get("use_regime")) and _sparams.get("regime_method") == "hmm"
        _label = getattr(getattr(strategy, "META", None), "name", None) or spec.strategy_id
        _emit({"stage": "strategy", "index": _i + 1, "total": n_specs,
               "label": _label, "symbol": spec.symbol, "hmm": _is_hmm})
        if sid:
            strategy._progress = {"sid": sid, "label": _label, "index": _i + 1, "total": n_specs}
        injected = df_by_spec.get(orig_idx) if df_by_spec else None
        df = _load_spec_df(spec, strategy, start_time, end_time, injected)

        sig_df = strategy.vectorized(df) if not df.empty else df
        st = _Stream(spec, strategy, sig_df)
        st.fee_flat = fee_flat
        st.fee_pct = fee_pct
        st.futures_commission = futures_commission
        streams.append(st)

    # Unified timeline = union of all streams' bar timestamps.
    all_ts: set[int] = set()
    for s in streams:
        all_ts.update(int(t) for t in s.time_a)
    if not all_ts:
        return _empty_portfolio_result([s for _, s in ordered], rc)
    timeline = np.array(sorted(all_ts), dtype=np.int64)

    state = PortfolioState(starting_capital=starting_capital, cash=starting_capital)

    _emit({"stage": "simulate", "total_bars": int(len(timeline))})

    # ---- Walk ----------------------------------------------------------
    for ts in timeline:
        ts_i = int(ts)

        # Determine which streams have a current bar at this ts and their idx.
        # IMPORTANT: last_close is NOT advanced to this bar's close yet — entry
        # sizing (Phase B) must mark open positions at the PREVIOUS close, like
        # the engine ("sized off MTM equity at previous close"). Advancing it
        # here (the old behavior) sized entries with the current bar's close —
        # information not available at the bar's open — and broke exact N=1
        # equivalence under pyramiding. last_close moves forward in Phase B½.
        active = []  # (stream, idx) where idx >= 1 — we need a prior bar to act.
        for s in streams:
            idx = s.ts_to_idx.get(ts_i)
            if idx is None:
                continue
            if idx >= 1:
                active.append((s, idx))
            else:
                # idx == 0: first bar of this stream — seed the initial mark.
                s.last_close = float(s.close_a[idx])

        # ---- Phase A: exits (priority order). Close-first frees cash for
        # subsequent same-bar entries.
        for s, t in active:
            _process_exits(s, t, state, fee_flat, fee_pct, slippage, starting_capital)

        # Current portfolio equity AFTER exits, used to size new entries.
        # Same identity as the Phase-D snapshot: cash + locked collateral +
        # unrealized P&L. Omitting locked_notional here (the old bug) made every
        # open position shrink the sizing equity by its full notional, breaking
        # the N=1 equivalence with backtest_engine whenever pyramiding >= 2 or
        # a second strategy held a position.
        cur_eq = (state.cash
                  + sum(s.unrealized() for s in streams)
                  + sum(s.locked_notional() for s in streams))

        # ---- Phase B: entries (priority order). Honest cash gating.
        for s, t in active:
            _process_entries(s, t, ts_i, state, cur_eq, fee_flat, fee_pct,
                             slippage, starting_capital)

        # ---- Phase B½: NOW advance last_close to this bar's close so the
        # Phase-D MTM snapshot (and idle streams on later timestamps) mark at
        # the latest known price.
        for s, t in active:
            s.last_close = float(s.close_a[t])

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

    # Refresh the final snapshot after force-closes: all positions are settled,
    # so portfolio equity == cash exactly (this folds the force-close exit fees
    # into the final point, matching backtest_engine / stats.final_equity).
    if state.equity_curve:
        final_settled = float(state.cash)
        state.peak_equity = max(state.peak_equity, final_settled)
        last = state.equity_curve[-1]
        last["equity"] = final_settled
        last["value"] = final_settled / starting_capital * 100.0
        last["drawdown_dollars"] = final_settled - state.peak_equity
        last["drawdown"] = (final_settled - state.peak_equity) / starting_capital * 100.0
        last["per_strategy"] = {
            s.spec.strategy_id: float(state.starting_capital + s.realized_pnl + s.unrealized())
            for s in streams
        }

    # ---- Build result -------------------------------------------------
    aggregate_trades = []
    for s in streams:
        for tr in s.trades:
            aggregate_trades.append({**tr, "strategy_id": s.spec.strategy_id,
                                     "symbol": s.spec.symbol})
    aggregate_trades.sort(key=lambda t: t["entry_time"])

    final_equity = state.equity_curve[-1]["equity"] if state.equity_curve else starting_capital

    _emit({"stage": "stats"})

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
            # Always present (a few KB) — buy-and-hold is a validation gate, so
            # it must survive `with_chart_data=False`.
            "benchmark": _benchmark_closes(s.sig_df),
            "candles": backtest_engine._serialize_candles(
                s.sig_df[["time", "open", "high", "low", "close", "volume"]]
            ) if (with_chart_data and not s.sig_df.empty) else [],
            "overlays": backtest_engine._build_overlays(s.strategy, s.sig_df, s.time_a)
                        if (with_chart_data and not s.sig_df.empty) else [],
            "regime_segments": backtest_engine._regime_segments(s.sig_df, s.strategy.p)
                        if (with_chart_data and not s.sig_df.empty) else {},
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
        "correlation": portfolio_correlation.compute(per_strategy, starting_capital),
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
        # Partial scale-out (once): close scale_out_frac at this bar's open, book it,
        # shrink the tranche, let the rest ride. Mirrors backtest_engine.
        if s.has_scale_out and bool(s.scl_a[t - 1]) and not tr.get("scaled"):
            part   = tr["units"] * s.scale_out_frac
            fill_p = op * (1.0 - slippage)
            fee_p  = s.fee(abs(fill_p * part))
            pnl    = (fill_p - tr["entry_price"]) * part - fee_p
            if s.contract_sizing:
                state.cash += pnl
            else:
                state.cash += abs(tr["entry_price"] * part) + pnl
            s.realized_pnl += pnl
            fo_p = tr["fee_open"] * s.scale_out_frac
            s.trades.append(backtest_engine._trade(
                "long", tr["entry_price"], fill_p, tr["entry_time"], ts,
                pnl - fo_p, part, fo_p + fee_p,
                starting_capital=starting_capital,
                mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
                slippage=tr.get("slip_open", 0.0) * s.scale_out_frac + (op - fill_p) * part,
            ))
            tr["units"]     *= (1.0 - s.scale_out_frac)
            tr["fee_open"]  *= (1.0 - s.scale_out_frac)
            tr["slip_open"]  = tr.get("slip_open", 0.0) * (1.0 - s.scale_out_frac)
            tr["scaled"] = True
        mean_revert = bool(s.bxl_a[t - 1])
        stop_hit = False
        if s.has_atr_stop and np.isfinite(tr["atr_at_entry"]):
            stop_hit = prev_close <= tr["entry_price"] - s.atr_mult * tr["atr_at_entry"]
        if mean_revert or stop_hit:
            # Option-B: exact stop/target/BE fill level when the strategy provides it.
            if s.has_exact_fills and mean_revert and np.isfinite(s.efl_a[t - 1]):
                ideal = float(s.efl_a[t - 1])
            else:
                ideal = op
            fill = ideal * (1.0 - slippage)
            _close_tranche(s, tr, "long", fill, ts, state,
                           fee_flat, fee_pct, slippage, starting_capital,
                           slipped=True, slip_close=(ideal - fill) * tr["units"])
        else:
            still_long.append(tr)
    s.tranches_long = still_long

    # Shorts
    still_short: list[dict] = []
    for tr in s.tranches_short:
        # Partial scale-out (once): mirror of the long side.
        if s.has_scale_out and bool(s.scs_a[t - 1]) and not tr.get("scaled"):
            part   = tr["units"] * s.scale_out_frac
            fill_p = op * (1.0 + slippage)
            fee_p  = s.fee(abs(fill_p * part))
            pnl    = (tr["entry_price"] - fill_p) * part - fee_p
            if s.contract_sizing:
                state.cash += pnl
            else:
                state.cash += abs(tr["entry_price"] * part) + pnl
            s.realized_pnl += pnl
            fo_p = tr["fee_open"] * s.scale_out_frac
            s.trades.append(backtest_engine._trade(
                "short", tr["entry_price"], fill_p, tr["entry_time"], ts,
                pnl - fo_p, part, fo_p + fee_p,
                starting_capital=starting_capital,
                mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
                slippage=tr.get("slip_open", 0.0) * s.scale_out_frac + (fill_p - op) * part,
            ))
            tr["units"]     *= (1.0 - s.scale_out_frac)
            tr["fee_open"]  *= (1.0 - s.scale_out_frac)
            tr["slip_open"]  = tr.get("slip_open", 0.0) * (1.0 - s.scale_out_frac)
            tr["scaled"] = True
        mean_revert = bool(s.bxs_a[t - 1])
        stop_hit = False
        if s.has_atr_stop and np.isfinite(tr["atr_at_entry"]):
            stop_hit = prev_close >= tr["entry_price"] + s.atr_mult * tr["atr_at_entry"]
        if mean_revert or stop_hit:
            # Option-B: exact stop/target/BE fill level when the strategy provides it.
            if s.has_exact_fills and mean_revert and np.isfinite(s.efs_a[t - 1]):
                ideal = float(s.efs_a[t - 1])
            else:
                ideal = op
            fill = ideal * (1.0 + slippage)
            _close_tranche(s, tr, "short", fill, ts, state,
                           fee_flat, fee_pct, slippage, starting_capital,
                           slipped=True, slip_close=(fill - ideal) * tr["units"])
        else:
            still_short.append(tr)
    s.tranches_short = still_short


def _close_tranche(s: _Stream, tr: dict, side: str, fill: float, ts: int,
                   state: PortfolioState, fee_flat: float, fee_pct: float,
                   slippage: float, starting_capital: float,
                   slipped: bool, slip_close: float = 0.0) -> None:
    """Close a single tranche, update cash + per-strategy realized pnl, and
    record the trade. `slipped=False` for forced end-of-data closes which
    use the close price directly (slip_close stays 0)."""
    notional_close = abs(fill * tr["units"])
    fee_close = s.fee(notional_close)
    if side == "long":
        pnl = (fill - tr["entry_price"]) * tr["units"] - fee_close
    else:
        pnl = (tr["entry_price"] - fill) * tr["units"] - fee_close

    # Cash release mirrors the open-side accounting:
    #   crypto/spot — entry notional was deducted at open, so release it + pnl;
    #   futures     — only the fee was deducted at open (margin model), so the
    #                 close settles pnl only.
    if s.contract_sizing:
        state.cash += pnl
    else:
        state.cash += abs(tr["entry_price"] * tr["units"]) + pnl
    s.realized_pnl += pnl

    # Trade record is net of BOTH fees (fee_open already hit realized/cash at
    # entry, so portfolio accounting above is unchanged).
    s.trades.append(backtest_engine._trade(
        side, tr["entry_price"], fill, tr["entry_time"], ts,
        pnl - tr["fee_open"], tr["units"], tr["fee_open"] + fee_close,
        starting_capital=starting_capital,
        mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
        slippage=tr.get("slip_open", 0.0) + slip_close,
    ))


def _process_entries(s: _Stream, t: int, ts_i: int, state: PortfolioState,
                     cur_eq: float, fee_flat: float, fee_pct: float,
                     slippage: float, starting_capital: float) -> None:
    """Open new tranches for entry signals. Honest mode acts on bar t-1's signal
    and fills at bar t's open; look-ahead mode (fictitious) acts on bar t's own
    signal and fills at the bar's most favorable extreme. Cash-gated."""
    op = float(s.open_a[t])
    # Entry-fill (stop/limit) strategies place the order at the prior bar and fill
    # the next bar, so they keep the t-1 signal index even in look-ahead mode (which
    # then fills at bar t's favorable extreme — the real fill bar). See backtest_engine.
    sig_i = t if (s.look_ahead and not s.has_entry_fills) else t - 1

    def _try_open(side: str, cond_arr, tranches, slip_sign: float, ideal: float) -> None:
        if not cond_arr[sig_i]:
            return
        if len(tranches) >= s.max_tranches:
            return
        if cur_eq <= 0:
            return
        fill = ideal * (1.0 + slip_sign * slippage)
        if fill <= 0:
            return
        _rs = (float(s.risk_scale_a[sig_i]) if (s.has_risk_scale and np.isfinite(s.risk_scale_a[sig_i])
                                                and s.risk_scale_a[sig_i] > 0) else 1.0)
        units = s.contract_units if s.contract_sizing else (cur_eq * s.risk_frac * _rs) / fill
        notional = abs(fill * units)
        fee_open = s.fee(notional)
        # Futures (contract sizing) are margin-based — only the fee is funded
        # from cash; crypto/spot fund the full notional + fee.
        required = fee_open if s.contract_sizing else notional + fee_open
        if not s.contract_sizing and state.cash < required:
            # Skip + log with counterfactual. `required_notional` includes the
            # open fee so the log matches the gate exactly.
            would_be = _counterfactual_pnl(
                s, sig_i, side, cur_eq, fee_pct, fee_flat, slippage
            )
            state.skipped_signals.append({
                "time": ts_i,
                "strategy_id": s.spec.strategy_id,
                "symbol": s.spec.symbol,
                "side": side,
                "required_notional": float(required),
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
            "slip_open":   abs(fill - ideal) * units,   # ≥ 0 cost
            "atr_at_entry": atr_at_entry,
            "entry_time":  ts_i,
            "mae_price":   fill,
            "mfe_price":   fill,
        })

    # Look-ahead fills at the bar's most favorable extreme (low for longs, high
    # for shorts) — unknowable until the bar closes, so it can only inflate P&L.
    # Honest path: use the strategy's gap-protected entry fill (stop/limit level)
    # when provided, else the next-bar open.
    if s.look_ahead:
        long_ideal  = float(s.low_a[t])
        short_ideal = float(s.high_a[t])
    else:
        long_ideal  = (float(s.efl_in_a[sig_i]) if (s.has_entry_fills and np.isfinite(s.efl_in_a[sig_i])) else op)
        short_ideal = (float(s.efs_in_a[sig_i]) if (s.has_entry_fills and np.isfinite(s.efs_in_a[sig_i])) else op)
    _try_open("long",  s.cond_long_a,  s.tranches_long,  +1.0, long_ideal)
    _try_open("short", s.cond_short_a, s.tranches_short, -1.0, short_ideal)


# ---------------------------------------------------------------------------
# Empty-data fallback (no bars across any stream)
# ---------------------------------------------------------------------------

def _empty_portfolio_result(specs: list[StrategySpec], rc: dict) -> dict:
    starting_capital = float(rc["starting_capital"])
    empty_stats = {
        "starting_capital": starting_capital,
        "final_equity": starting_capital,
        "total_return_dollars": 0.0, "total_return_pct": 0.0,
        "trades": 0, "wins": 0, "losses": 0, "breakeven": 0, "win_rate": 0.0,
        "profit_factor": 0.0, "sharpe": None,
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
        "by_session": [],
        "heatmap": {"pnl": [[0.0] * 24 for _ in range(7)],
                    "count": [[0] * 24 for _ in range(7)]},
        "monthly_returns": [], "streaks": {"max_win_streak": 0, "max_loss_streak": 0},
        "drawdown_curve": [], "max_drawdown_duration_bars": 0,
        "distribution_pnl_pct": [], "distribution_duration_min": [],
        "best_trade": None, "worst_trade": None, "exposure_pct": 0.0,
        "commission_dollars": 0.0, "slippage_dollars": 0.0, "trading_days": 0,
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
