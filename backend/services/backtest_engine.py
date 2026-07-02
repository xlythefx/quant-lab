"""
Hindsight backtest engine.

Single REST round-trip: load parquet → strategy.vectorized() → bar simulation
→ return everything (candles, overlays, trades, equity, stats, analytics).

GLOBAL risk_config (services.risk_config) drives starting capital, fees,
and slippage. risk_pct is per-strategy (in each PARAM_SCHEMA).
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services import market_data, quant_metrics, risk_config, assets
from services.strategy_registry import get_strategy_class
from services.strategies.regime import _regime_labels, _regime_params, RegimeDetector

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _serialize_candles(df: pd.DataFrame) -> list[dict]:
    sub = df[["time", "open", "high", "low", "close", "volume"]]
    return [
        {
            "time": int(r["time"]),
            "open": float(r["open"]),
            "high": float(r["high"]),
            "low": float(r["low"]),
            "close": float(r["close"]),
            "volume": float(r["volume"]),
        }
        for r in sub.to_dict(orient="records")
    ]


def _build_overlays(strategy, sig_df: pd.DataFrame, time_a) -> list[dict]:
    overlays = []
    for ov in getattr(strategy, "OVERLAYS", []):
        if ov.from_column not in sig_df.columns:
            continue
        arr = sig_df[ov.from_column].astype(float).to_numpy()
        data = []
        for ti, val in zip(time_a, arr):
            if val is None or not math.isfinite(val):
                # Whitespace point (time, no value): breaks the line series so a
                # sparse overlay (e.g. an ATR stop drawn only during trades)
                # doesn't connect across the gaps. Harmless for dense overlays.
                data.append({"time": int(ti)})
                continue
            data.append({"time": int(ti), "value": float(val)})
        overlays.append({**ov.to_dict(), "data": data})
    return overlays


def _rle_segments(labels, time_a) -> list[dict]:
    """Run-length-encode a per-bar label array into colored chart bands.
    Returns [{regime, start_time, end_time, bars}] (market_lab.classify_regimes shape)."""
    n = len(labels)
    segments = []
    seg_start = 0
    for i in range(1, n + 1):
        if i == n or labels[i] != labels[seg_start]:
            segments.append({
                "regime": str(labels[seg_start]),
                "start_time": int(time_a[seg_start]),
                "end_time": int(time_a[i - 1]),
                "bars": int(i - seg_start),
            })
            seg_start = i
    return segments


def _regime_segments(sig_df: pd.DataFrame, params: dict) -> dict:
    """Build the Dashboard chart's regime-band overlays, one set per lens.

    Uses the SAME causal labelers and ADX params the strategy gates on, so the
    bands you see == what the strategy allows. Two cheap lenses are computed here;
    the slow HMM lens is fetched lazily by the frontend (market_lab.regime-hmm).

    Returns {
      "five":    [...segments...],   # 5-mood classifier (Trend↑/↓, High-Vol, Quiet, Choppy)
      "adx":     [...segments...],   # binary ADX filter (Ranging vs Trending)
      "default": "five" | "adx",     # which lens to show first (matches use_five_regime)
    }, or {} for an empty frame.
    """
    if sig_df is None or sig_df.empty:
        return {}
    params = params or {}
    period = params.get("regime_adx_period")
    threshold = params.get("regime_adx_threshold")
    time_a = sig_df["time"].to_numpy()

    # 5-mood lens (shared causal labeler).
    rp = _regime_params({"adx_period": period, "adx_trend_thresh": threshold})
    five = _rle_segments(_regime_labels(sig_df, rp), time_a)

    # Binary ADX lens: detect() is True when ranging (ADX below threshold).
    rd = RegimeDetector(rp["adx_period"], rp["adx_trend_thresh"])
    ranging = rd.detect(sig_df).to_numpy()
    adx_labels = np.where(ranging, "Ranging", "Trending")
    adx = _rle_segments(adx_labels, time_a)

    # Which lens the chart opens on = the strategy's regime method (legacy
    # use_five_regime still honored). "hmm" is valid here; the chart self-fetches
    # the HMM lens, while these five/adx segments remain available to toggle.
    _method = params.get("regime_method")
    if _method not in ("adx", "five", "hmm"):
        _method = "five" if params.get("use_five_regime") else "adx"
    return {
        "five": five,
        "adx": adx,
        "default": _method,
    }


def _hhmm_to_min(s: str) -> int:
    try:
        hh, mm = s.split(":")
        return int(hh) * 60 + int(mm)
    except Exception:
        return 0


def _classify_session(entry_ts: int, sessions_cfg: dict) -> str:
    """Return the first enabled session name whose UTC window contains entry_ts.
    'unknown' if none match."""
    if not sessions_cfg:
        return "unknown"
    dt = datetime.fromtimestamp(int(entry_ts), tz=timezone.utc)
    minute = dt.hour * 60 + dt.minute
    for name, cfg in sessions_cfg.items():
        if not cfg or not cfg.get("enabled"):
            continue
        s = _hhmm_to_min(cfg.get("start", "00:00"))
        e = _hhmm_to_min(cfg.get("end", "00:00"))
        if s <= e:
            in_win = s <= minute < e
        else:
            in_win = minute >= s or minute < e   # wraps midnight
        if in_win:
            return name
    return "unknown"


# ---------------------------------------------------------------------------
# Engine
# ---------------------------------------------------------------------------

def symbol_floor_bounds(strategy, symbol: str) -> tuple[Optional[int], Optional[int]]:
    """Epoch-second (start, end) the strategy declares as the tradeable window
    for `symbol` via SYMBOL_BACKTEST_START / SYMBOL_BACKTEST_END (e.g. Lunar on
    ES → 2018-01-01 .. 2026-04-30, matching the TS reference). Either side is
    None when undeclared. `strategy` may be a class or an instance.

    `run()` applies these only when the caller passes no explicit start/end (the
    date picker overrides the floor). Callers that auto-fill the full data range
    but still want the floor (Grid Search) should clamp their requested range to
    these bounds instead of relying on the None-guard."""
    def _ts(d: Optional[str]) -> Optional[int]:
        if not d:
            return None
        return int(datetime.strptime(d, "%Y-%m-%d").replace(tzinfo=timezone.utc).timestamp())
    return (
        _ts(getattr(strategy, "SYMBOL_BACKTEST_START", {}).get(symbol)),
        _ts(getattr(strategy, "SYMBOL_BACKTEST_END", {}).get(symbol)),
    )


def run(strategy_id: str, symbol: str, timeframe: str,
        params: Optional[dict] = None,
        start_time: Optional[int] = None,
        end_time: Optional[int] = None,
        df: Optional[pd.DataFrame] = None,
        risk_overrides: Optional[dict] = None,
        broker: Optional[str] = None,
        trade_start_time: Optional[int] = None,
        stats_only: bool = False) -> dict:
    """Run a backtest.

    `df`: if provided, use it directly (and copy it) instead of loading from
    parquet — Monte Carlo uses this to inject synthetic bars without
    monkey-patching the loader at module scope.

    `risk_overrides`: dict of risk-config keys (slippage_bps, fee_pct, fee_flat,
    starting_capital, pyramiding) — or `risk_pct` to override the strategy's
    per-trade sizing — for this single call. Local-only, does not mutate the
    global config. Used by Cost Sweep to test how the strategy's edge holds up
    under elevated execution costs.

    `trade_start_time`: entry signals observed before this epoch are masked off,
    but indicators are computed over the FULL [start_time, end_time] slice.
    Walk-forward uses this to give each IS/OOS window warm-up bars (so rolling
    indicators are valid at the window start) without letting warm-up bars
    generate trades. Equity stays flat at starting_capital before the first
    in-window entry.

    `stats_only`: skip everything sweep callers don't read — candle/overlay
    serialization, the equity-curve dict list, and the analytics block. The
    simulation and `stats` are byte-identical to a full run; `candles`,
    `overlays`, `equity` come back empty and `analytics` is None. Grid Search
    uses this (it only consumes `stats`); walk-forward must NOT (it reads
    `equity` and `trades` per window)."""

    rc = risk_config.get()
    if risk_overrides:
        rc = {**rc, **risk_overrides}
    starting_capital = float(rc["starting_capital"])
    fee_flat         = float(rc["fee_flat"])
    fee_pct          = float(rc["fee_pct"]) / 100.0
    futures_commission = float(rc.get("futures_commission", 0.0))  # $/contract/side
    slippage         = float(rc["slippage_bps"]) / 10000.0

    cls = get_strategy_class(strategy_id)
    strategy = cls(params or {})

    # risk_pct is per-strategy (in PARAM_SCHEMA). A risk_overrides["risk_pct"]
    # takes precedence (e.g. Cost Sweep). Final fallback is 3.0 to match the
    # historical default.
    risk_pct_param = (
        risk_overrides.get("risk_pct") if risk_overrides and "risk_pct" in risk_overrides
        else strategy.p.get("risk_pct", 3.0)
    )
    risk_frac = float(risk_pct_param) / 100.0

    # Pyramiding is per-strategy (in PARAM_SCHEMA). Strategies that don't declare
    # it default to 1 (no stacking) — this MUST match portfolio_runner.py so the
    # two engines produce identical results. (Previously this fell back to the
    # global risk_config["pyramiding"], which defaulted to 10 and silently
    # over-stacked non-declaring strategies in WalkForward/Grid vs the Dashboard.)
    pyramiding_param = strategy.p.get("pyramiding", 1)
    max_tranches = max(1, int(float(pyramiding_param)))

    # LOOK-AHEAD (diagnostic only): entries act on THIS bar's own signal instead
    # of the prior bar's — i.e. fill at the open (or best price) of the bar whose
    # close produced the signal. This uses not-yet-known information and INFLATES
    # P&L; the result is flagged `look_ahead=True` so the UI can badge it as
    # fictitious. Read straight from the request params so it works for ANY
    # strategy (it's not a per-strategy schema field) — base._merge_with_defaults
    # would otherwise drop it from `strategy.p`. Falls back to a schema default
    # for strategies that do declare it (e.g. the HLC3 test twin).
    look_ahead = bool((params or {}).get("look_ahead", strategy.p.get("look_ahead", False)))

    df = df.copy() if df is not None else market_data.load_parquet(symbol, timeframe, broker=broker)
    if start_time is not None:
        df = df[df["time"] >= int(start_time)]
    if end_time is not None:
        df = df[df["time"] <= int(end_time)]
    df = df.reset_index(drop=True)

    # Per-symbol backtest start floor declared by the strategy (e.g. Lunar on ES:
    # TS datafeed only produces trades from 2018, so the dashboard comparison is
    # restricted to that range). Only applied when the caller didn't pass an
    # explicit start_time — the UI date-range picker always overrides this.
    sym_start = getattr(strategy, "SYMBOL_BACKTEST_START", {}).get(symbol)
    if sym_start and start_time is None and not df.empty:
        from datetime import datetime, timezone
        floor_ts = int(datetime.strptime(sym_start, "%Y-%m-%d")
                       .replace(tzinfo=timezone.utc).timestamp())
        df = df[df["time"] >= floor_ts].reset_index(drop=True)

    # Symmetric end cap (e.g. Lunar on ES restricts to TS's traded window ~Apr 2026).
    # Only applied when no explicit end_time was passed (date picker overrides).
    sym_end = getattr(strategy, "SYMBOL_BACKTEST_END", {}).get(symbol)
    if sym_end and end_time is None and not df.empty:
        from datetime import datetime, timezone
        cap_ts = int(datetime.strptime(sym_end, "%Y-%m-%d")
                     .replace(tzinfo=timezone.utc).timestamp())
        df = df[df["time"] <= cap_ts].reset_index(drop=True)

    if df.empty:
        return _empty_result(strategy_id, symbol, timeframe, rc)

    sig_df = strategy.vectorized(df)
    time_a  = sig_df["time"].to_numpy()
    open_a  = sig_df["open"].to_numpy(dtype=float)
    high_a  = sig_df["high"].to_numpy(dtype=float)
    low_a   = sig_df["low"].to_numpy(dtype=float)
    close_a = sig_df["close"].to_numpy(dtype=float)

    # Prefer raw bar-level conditions (pyramiding-capable) when the strategy
    # exposes them. Otherwise fall back to one-shot entry/exit arrays.
    cl_col = "cond_long"      if "cond_long"      in sig_df.columns else "entry_long"
    cs_col = "cond_short"     if "cond_short"     in sig_df.columns else "entry_short"
    el_col = "bar_exit_long"  if "bar_exit_long"  in sig_df.columns else "exit_long"
    es_col = "bar_exit_short" if "bar_exit_short" in sig_df.columns else "exit_short"

    cond_long_a  = sig_df[cl_col].fillna(False).astype(bool).to_numpy()
    cond_short_a = sig_df[cs_col].fillna(False).astype(bool).to_numpy()
    bxl_a        = sig_df[el_col].fillna(False).astype(bool).to_numpy()
    bxs_a        = sig_df[es_col].fillna(False).astype(bool).to_numpy()

    # Warm-up masking: indicators above were computed on the full slice, but
    # entry signals observed before trade_start_time must not open positions.
    # Exits are left untouched — no position can exist before the first entry.
    if trade_start_time is not None:
        _warm = time_a.astype(np.int64) < int(trade_start_time)
        cond_long_a  = cond_long_a  & ~_warm
        cond_short_a = cond_short_a & ~_warm

    # Per-tranche ATR stop (optional — only if strategy exposes `atr` + `atr_mult`).
    has_atr_stop = "atr" in sig_df.columns and "atr_mult" in getattr(strategy, "p", {})
    atr_a    = sig_df["atr"].to_numpy(dtype=float) if has_atr_stop else None
    atr_mult = float(strategy.p["atr_mult"]) if has_atr_stop else 0.0

    # Exact-fill exits (Option B) — strategy exports pre-computed fill price for
    # stop / target / breakeven exits. NaN = fall back to next-bar open as usual.
    # Finite = fill at this level (gap-protection already baked in by the strategy).
    has_exact_fills   = "exit_fill_long" in sig_df.columns and "exit_fill_short" in sig_df.columns
    efl_a = sig_df["exit_fill_long"].to_numpy(dtype=float)  if has_exact_fills else None
    efs_a = sig_df["exit_fill_short"].to_numpy(dtype=float) if has_exact_fills else None

    # Exact-fill ENTRIES (Option B, entry side) — strategy exports a pre-computed,
    # gap-protected fill price for stop/limit entries (e.g. a Donchian breakout that
    # fills AT the channel level the moment price pierces it, not a bar later at the
    # open). NaN = fall back to next-bar open as usual. Opt-in: strategies that don't
    # emit these columns are unaffected. Honest path only — the look-ahead diagnostic
    # keeps its own "fill at the bar's favorable extreme" logic untouched.
    has_entry_fills = "entry_fill_long" in sig_df.columns and "entry_fill_short" in sig_df.columns
    efl_in_a = sig_df["entry_fill_long"].to_numpy(dtype=float)  if has_entry_fills else None
    efs_in_a = sig_df["entry_fill_short"].to_numpy(dtype=float) if has_entry_fills else None

    # Per-bar risk multiplier (opt-in): when a strategy emits `risk_scale`, the
    # engine multiplies risk_frac by it at entry (e.g. ATR sizing — smaller size
    # in high vol). Absent => factor 1.0, so strategies that don't emit it are
    # byte-identical. Only affects %-of-equity sizing, not fixed-contract futures.
    has_risk_scale = "risk_scale" in sig_df.columns
    risk_scale_a   = sig_df["risk_scale"].to_numpy(dtype=float) if has_risk_scale else None

    # Partial scale-out (opt-in): on a `scale_exit_*` bar the engine closes
    # `scale_out_frac` of the open position ONCE, books it as a trade, shrinks the
    # tranche, and lets the remainder ride to the normal exit. Absent => no partial
    # exits (every other strategy unaffected).
    has_scale_out = "scale_exit_long" in sig_df.columns and "scale_exit_short" in sig_df.columns
    scl_a = sig_df["scale_exit_long"].fillna(False).astype(bool).to_numpy()  if has_scale_out else None
    scs_a = sig_df["scale_exit_short"].fillna(False).astype(bool).to_numpy() if has_scale_out else None
    scale_out_frac = (float(sig_df["scale_out_frac"].iloc[0])
                      if has_scale_out and "scale_out_frac" in sig_df.columns and len(sig_df) else 0.0)
    if not (0.0 < scale_out_frac < 1.0):
        has_scale_out = False

    # Instrument-driven futures sizing: index futures (asset_class
    # 'equity_index_future', e.g. ES with contract_size=50) size as N contracts ×
    # multiplier so the existing `move × units` P&L math yields TS-style dollars
    # ($50/pt). Everything else (crypto, commodities) stays %-of-equity sizing.
    _broker = broker or market_data.broker_for(symbol, timeframe)
    _meta   = assets.get(symbol, _broker or market_data.BROKER_DEFAULT)
    contract_sizing = (_meta.asset_class in ("equity_index_future", "futures") and _meta.contract_size > 1.0)
    n_contracts     = float(strategy.p.get("contracts", 1)) if contract_sizing else 0.0
    contract_units  = n_contracts * float(_meta.contract_size) if contract_sizing else 0.0

    def _fee(notional: float) -> float:
        """Per-side fee. Futures: flat $/contract. Crypto/spot: flat + %-notional."""
        if contract_sizing:
            return fee_flat + futures_commission * n_contracts
        return fee_flat + abs(notional) * fee_pct

    n = len(sig_df)

    tranches_long: list[dict]  = []
    tranches_short: list[dict] = []
    realized_cum = 0.0
    peak_eq      = float(starting_capital)

    equity_arr     = np.full(n, float(starting_capital))
    dd_dollars_arr = np.zeros(n)
    trades_list: list[dict] = []

    def _unrealized(trs, side_sign, mark):
        u = 0.0
        for tr in trs:
            u += (mark - tr["entry_price"]) * tr["units"] * side_sign
        return u

    for t in range(n):
        ts = int(time_a[t])
        cl = close_a[t]

        # Act on bar `t` open using signals observed at close of bar `t-1`.
        if t >= 1:
            op = open_a[t]
            prev_close = close_a[t - 1]

            # ---- exits (close-first, then re-open new tranches) ----
            still_long: list[dict] = []
            for tr in tranches_long:
                # Partial scale-out (once): close scale_out_frac at this bar's open,
                # book it, shrink the tranche, let the rest ride to the normal exit.
                if has_scale_out and bool(scl_a[t - 1]) and not tr.get("scaled"):
                    part   = tr["units"] * scale_out_frac
                    fill_p = op * (1.0 - slippage)
                    slip_p = (op - fill_p) * part
                    fee_p  = _fee(abs(fill_p * part))
                    pnl_p  = (fill_p - tr["entry_price"]) * part - fee_p
                    realized_cum += pnl_p
                    fo_p = tr["fee_open"] * scale_out_frac
                    trades_list.append(_trade(
                        "long", tr["entry_price"], fill_p, tr["entry_time"], ts,
                        pnl_p - fo_p, part, fo_p + fee_p,
                        starting_capital=starting_capital,
                        mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
                        slippage=tr["slip_open"] * scale_out_frac + slip_p,
                    ))
                    tr["units"]     *= (1.0 - scale_out_frac)
                    tr["fee_open"]  *= (1.0 - scale_out_frac)
                    tr["slip_open"] *= (1.0 - scale_out_frac)
                    tr["scaled"] = True
                mean_revert = bool(bxl_a[t - 1])
                stop_hit = False
                if has_atr_stop and np.isfinite(tr["atr_at_entry"]):
                    stop_hit = prev_close <= tr["entry_price"] - atr_mult * tr["atr_at_entry"]
                if mean_revert or stop_hit:
                    # Option-B: use exact fill level when strategy provides it.
                    if has_exact_fills and mean_revert and np.isfinite(efl_a[t - 1]):
                        ideal = float(efl_a[t - 1])
                    else:
                        ideal = op
                    fill = ideal * (1.0 - slippage)
                    slip_close = (ideal - fill) * tr["units"]   # ≥ 0 cost
                    notional_close = abs(fill * tr["units"])
                    fee_close = _fee(notional_close)
                    pnl = (fill - tr["entry_price"]) * tr["units"] - fee_close
                    realized_cum += pnl
                    # Trade record is net of BOTH fees (fee_open was charged to
                    # realized_cum at entry, so equity math is unchanged).
                    trades_list.append(_trade(
                        "long", tr["entry_price"], fill, tr["entry_time"], ts,
                        pnl - tr["fee_open"], tr["units"], tr["fee_open"] + fee_close,
                        starting_capital=starting_capital,
                        mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
                        slippage=tr["slip_open"] + slip_close,
                    ))
                else:
                    still_long.append(tr)
            tranches_long = still_long

            still_short: list[dict] = []
            for tr in tranches_short:
                # Partial scale-out (once): mirror of the long side.
                if has_scale_out and bool(scs_a[t - 1]) and not tr.get("scaled"):
                    part   = tr["units"] * scale_out_frac
                    fill_p = op * (1.0 + slippage)
                    slip_p = (fill_p - op) * part
                    fee_p  = _fee(abs(fill_p * part))
                    pnl_p  = (tr["entry_price"] - fill_p) * part - fee_p
                    realized_cum += pnl_p
                    fo_p = tr["fee_open"] * scale_out_frac
                    trades_list.append(_trade(
                        "short", tr["entry_price"], fill_p, tr["entry_time"], ts,
                        pnl_p - fo_p, part, fo_p + fee_p,
                        starting_capital=starting_capital,
                        mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
                        slippage=tr["slip_open"] * scale_out_frac + slip_p,
                    ))
                    tr["units"]     *= (1.0 - scale_out_frac)
                    tr["fee_open"]  *= (1.0 - scale_out_frac)
                    tr["slip_open"] *= (1.0 - scale_out_frac)
                    tr["scaled"] = True
                mean_revert = bool(bxs_a[t - 1])
                stop_hit = False
                if has_atr_stop and np.isfinite(tr["atr_at_entry"]):
                    stop_hit = prev_close >= tr["entry_price"] + atr_mult * tr["atr_at_entry"]
                if mean_revert or stop_hit:
                    # Option-B: use exact fill level when strategy provides it.
                    if has_exact_fills and mean_revert and np.isfinite(efs_a[t - 1]):
                        ideal = float(efs_a[t - 1])
                    else:
                        ideal = op
                    fill = ideal * (1.0 + slippage)
                    slip_close = (fill - ideal) * tr["units"]   # ≥ 0 cost
                    notional_close = abs(fill * tr["units"])
                    fee_close = _fee(notional_close)
                    pnl = (tr["entry_price"] - fill) * tr["units"] - fee_close
                    realized_cum += pnl
                    trades_list.append(_trade(
                        "short", tr["entry_price"], fill, tr["entry_time"], ts,
                        pnl - tr["fee_open"], tr["units"], tr["fee_open"] + fee_close,
                        starting_capital=starting_capital,
                        mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
                        slippage=tr["slip_open"] + slip_close,
                    ))
                else:
                    still_short.append(tr)
            tranches_short = still_short

            # ---- entries (sized off MTM equity at previous close) ----
            cur_eq = (starting_capital + realized_cum
                      + _unrealized(tranches_long,  +1, prev_close)
                      + _unrealized(tranches_short, -1, prev_close))

            # Entry signal index: prior bar (causal, default) or THIS bar
            # (look-ahead — acts on a signal from this same bar's close). Entry-fill
            # strategies (stop/limit orders) place the order at the prior bar and fill
            # the NEXT bar, so even their look-ahead run keeps the t-1 signal index and
            # just fills at bar t's favorable extreme (the actual fill bar) — otherwise
            # look-ahead would fill a bar BEFORE the order could trigger.
            _sig_e = t if (look_ahead and not has_entry_fills) else t - 1

            # Look-ahead "perfect fill": peek inside the entry bar and fill at its
            # most favorable extreme (low for longs, high for shorts) — a price only
            # knowable in hindsight. low<=op<=high, so this can only IMPROVE the fill
            # vs the honest next-open, i.e. it monotonically inflates P&L. Diagnostic
            # ceiling only; `look_ahead=True` is returned so the result is flagged.
            if cur_eq > 0 and cond_long_a[_sig_e] and len(tranches_long) < max_tranches:
                if look_ahead:
                    ideal = float(low_a[t])
                elif has_entry_fills and np.isfinite(efl_in_a[_sig_e]):
                    ideal = float(efl_in_a[_sig_e])   # strategy's gap-protected entry fill (stop/limit level)
                else:
                    ideal = op
                fill = ideal * (1.0 + slippage)
                if fill > 0:
                    _rs = (float(risk_scale_a[_sig_e]) if (has_risk_scale and np.isfinite(risk_scale_a[_sig_e])
                                                          and risk_scale_a[_sig_e] > 0) else 1.0)
                    units = contract_units if contract_sizing else (cur_eq * risk_frac * _rs) / fill
                    fee_open = _fee(fill * units)
                    realized_cum -= fee_open
                    tranches_long.append({
                        "entry_price": fill,
                        "units":       units,
                        "fee_open":    fee_open,
                        "slip_open":   (fill - ideal) * units,   # ≥ 0 cost
                        "atr_at_entry": float(atr_a[t - 1]) if (has_atr_stop and np.isfinite(atr_a[t - 1])) else float("nan"),
                        "entry_time":  ts,
                        "mae_price":   fill,
                        "mfe_price":   fill,
                    })

            if cur_eq > 0 and cond_short_a[_sig_e] and len(tranches_short) < max_tranches:
                if look_ahead:
                    ideal = float(high_a[t])
                elif has_entry_fills and np.isfinite(efs_in_a[_sig_e]):
                    ideal = float(efs_in_a[_sig_e])   # strategy's gap-protected entry fill (stop/limit level)
                else:
                    ideal = op
                fill = ideal * (1.0 - slippage)
                if fill > 0:
                    _rs = (float(risk_scale_a[_sig_e]) if (has_risk_scale and np.isfinite(risk_scale_a[_sig_e])
                                                          and risk_scale_a[_sig_e] > 0) else 1.0)
                    units = contract_units if contract_sizing else (cur_eq * risk_frac * _rs) / fill
                    fee_open = _fee(fill * units)
                    realized_cum -= fee_open
                    tranches_short.append({
                        "entry_price": fill,
                        "units":       units,
                        "fee_open":    fee_open,
                        "slip_open":   (ideal - fill) * units,   # ≥ 0 cost
                        "atr_at_entry": float(atr_a[t - 1]) if (has_atr_stop and np.isfinite(atr_a[t - 1])) else float("nan"),
                        "entry_time":  ts,
                        "mae_price":   fill,
                        "mfe_price":   fill,
                    })

        # ---- Update MAE/MFE for all currently-open tranches using bar t's
        # range. Longs: high = favorable, low = adverse. Shorts: inverted.
        hi_t = high_a[t]
        lo_t = low_a[t]
        for tr in tranches_long:
            if hi_t > tr["mfe_price"]:
                tr["mfe_price"] = float(hi_t)
            if lo_t < tr["mae_price"]:
                tr["mae_price"] = float(lo_t)
        for tr in tranches_short:
            if lo_t < tr["mfe_price"]:
                tr["mfe_price"] = float(lo_t)
            if hi_t > tr["mae_price"]:
                tr["mae_price"] = float(hi_t)

        # ---- MTM equity at bar `t` close ----
        equity_t = (starting_capital + realized_cum
                    + _unrealized(tranches_long,  +1, cl)
                    + _unrealized(tranches_short, -1, cl))
        peak_eq = max(peak_eq, equity_t)
        equity_arr[t]     = equity_t
        dd_dollars_arr[t] = equity_t - peak_eq   # ≤ 0

    # Force-close any tranches still open at the last bar's close so trades_list
    # and final realized_cum are consistent. The last equity point is refreshed
    # below so the curve's final value includes the force-close exit fees and
    # matches stats.final_equity exactly.
    _had_open = bool(tranches_long or tranches_short)
    if n > 0 and (tranches_long or tranches_short):
        final_close = close_a[-1]
        final_ts = int(time_a[-1])
        for tr in tranches_long:
            notional_close = abs(final_close * tr["units"])
            fee_close = _fee(notional_close)
            pnl = (final_close - tr["entry_price"]) * tr["units"] - fee_close
            realized_cum += pnl
            trades_list.append(_trade(
                "long", tr["entry_price"], final_close, tr["entry_time"], final_ts,
                pnl - tr["fee_open"], tr["units"], tr["fee_open"] + fee_close,
                starting_capital=starting_capital,
                mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
                slippage=tr["slip_open"],   # forced close: no exit slippage
            ))
        for tr in tranches_short:
            notional_close = abs(final_close * tr["units"])
            fee_close = _fee(notional_close)
            pnl = (tr["entry_price"] - final_close) * tr["units"] - fee_close
            realized_cum += pnl
            trades_list.append(_trade(
                "short", tr["entry_price"], final_close, tr["entry_time"], final_ts,
                pnl - tr["fee_open"], tr["units"], tr["fee_open"] + fee_close,
                starting_capital=starting_capital,
                mae_price=tr["mae_price"], mfe_price=tr["mfe_price"],
                slippage=tr["slip_open"],   # forced close: no exit slippage
            ))
        tranches_long = []
        tranches_short = []

    equity = float(starting_capital + realized_cum)

    # Refresh the final equity point after force-closes: everything is realized
    # now, so the last bar's equity is exactly starting + realized (which
    # includes the force-close exit fees the MTM snapshot couldn't know about).
    if n > 0 and _had_open:
        peak_eq = max(peak_eq, equity)
        equity_arr[n - 1] = equity
        dd_dollars_arr[n - 1] = equity - peak_eq

    stats = _compute_stats(trades_list, equity, dd_dollars_arr, time_a,
                            starting_capital, equity_arr)

    if stats_only:
        return {
            "strategy_id": strategy_id,
            "symbol": symbol,
            "timeframe": timeframe,
            "risk_config": rc,
            "params": strategy.p,
            "candles": [],
            "overlays": [],
            "trades": trades_list,
            "equity": [],
            "stats": stats,
            "analytics": None,
            "look_ahead": look_ahead,
        }

    equity_curve = []
    for t in range(n):
        eq = float(equity_arr[t])
        equity_curve.append({
            "time": int(time_a[t]),
            "equity": eq,
            "value": eq / starting_capital * 100.0,
            "drawdown": float(dd_dollars_arr[t]) / starting_capital * 100.0,
            "drawdown_dollars": float(dd_dollars_arr[t]),
        })

    analytics = _compute_analytics(trades_list, equity_curve, sig_df, strategy, starting_capital)

    log.info("[hindsight %s/%s/%s] %d bars, %d trades, final $%s (%.2f%%)",
             strategy_id, symbol, timeframe, n, len(trades_list),
             f"{equity:,.2f}", (equity / starting_capital - 1.0) * 100.0)

    return {
        "strategy_id": strategy_id,
        "symbol": symbol,
        "timeframe": timeframe,
        "risk_config": rc,
        "params": strategy.p,                       # effective merged params
        "candles": _serialize_candles(sig_df[["time", "open", "high", "low", "close", "volume"]]),
        "overlays": _build_overlays(strategy, sig_df, time_a),
        "regime_segments": _regime_segments(sig_df, strategy.p),
        "trades": trades_list,
        "equity": equity_curve,
        "stats": stats,
        "analytics": analytics,
        "look_ahead": look_ahead,
    }


# ---------------------------------------------------------------------------
# Trade record
# ---------------------------------------------------------------------------

def _trade(side, entry_p, exit_p, entry_t, exit_t, pnl_dollars, units, fees,
           starting_capital=0.0, mae_price=None, mfe_price=None, slippage=0.0):
    # `pnl_pct` here is the underlying asset's price-move %, not the account
    # impact. With pyramiding/leverage these diverge sharply, so we also emit
    # `pnl_pct_equity` (= % of starting capital) for distribution + best/worst.
    pnl_pct_price = (exit_p - entry_p) / entry_p * 100.0 if entry_p else 0.0
    if side == "short":
        pnl_pct_price = -pnl_pct_price
    pnl_pct_equity = (pnl_dollars / starting_capital * 100.0) if starting_capital else 0.0
    duration_min = max(0, int((exit_t - entry_t) / 60))

    # Maximum Adverse/Favorable Excursion as % of entry price (signed).
    mae_pct = 0.0
    mfe_pct = 0.0
    if entry_p and mae_price is not None and mfe_price is not None:
        if side == "long":
            mae_pct = (float(mae_price) - entry_p) / entry_p * 100.0  # ≤ 0
            mfe_pct = (float(mfe_price) - entry_p) / entry_p * 100.0  # ≥ 0
        else:
            mae_pct = (entry_p - float(mae_price)) / entry_p * 100.0  # ≤ 0
            mfe_pct = (entry_p - float(mfe_price)) / entry_p * 100.0  # ≥ 0

    return {
        "side": side,
        "entry_price": float(entry_p),
        "exit_price": float(exit_p),
        "entry_time": int(entry_t),
        "exit_time": int(exit_t),
        "pnl_dollars": float(pnl_dollars),
        "pnl_pct": float(pnl_pct_price),
        "pnl_pct_equity": float(pnl_pct_equity),
        "units": float(units),
        "fees": float(fees),
        # Dollar cost of slippage on this trade's fills (entry + exit). Already
        # baked into entry_price/exit_price; surfaced here for the cost-breakdown
        # modal. Forced end-of-data closes apply no exit slippage.
        "slippage": float(slippage),
        "duration_min": duration_min,
        "mae_pct": float(mae_pct),
        "mfe_pct": float(mfe_pct),
        "win": bool(pnl_dollars > 0),
    }


# ---------------------------------------------------------------------------
# Stats (overview)
# ---------------------------------------------------------------------------

def _compute_stats(trades, final_equity, dd_dollars_arr, time_a,
                    starting_capital, equity_arr=None) -> dict:
    n_trades = len(trades)
    wins = sum(1 for t in trades if t["win"])
    # Strict pnl<0 (matching quant_metrics n_losers); break-even trades
    # (pnl == 0, rare post-fee) are counted separately, not as losses.
    losses = sum(1 for t in trades if t["pnl_dollars"] < 0)
    breakeven = n_trades - wins - losses
    win_rate = (wins / n_trades) if n_trades else 0.0

    pnl_arr = np.array([t["pnl_dollars"] for t in trades]) if trades else np.array([])
    gross_profit = float(pnl_arr[pnl_arr > 0].sum()) if trades else 0.0
    gross_loss = float(-pnl_arr[pnl_arr < 0].sum()) if trades else 0.0
    profit_factor = (gross_profit / gross_loss) if gross_loss > 0 else (None if gross_profit > 0 else 0.0)

    pct_arr = np.array([t["pnl_pct"] for t in trades]) if trades else np.array([])

    # Sharpe from per-bar MTM equity returns, annualized using the bar interval
    # (inferred from time_a). This reflects intra-trade drawdowns — the per-trade
    # Sharpe was misleading because pyramiding-stacked trades each report just
    # the price-move %, hiding leveraged risk.
    # None (not 0.0) when not computable — zero vol, <3 bars — so the UI can
    # distinguish "no risk-adjusted edge" from "couldn't be measured".
    sharpe = None
    if equity_arr is not None and len(equity_arr) >= 3 and len(time_a) >= 3:
        eq = np.asarray(equity_arr, dtype=float)
        # simple per-bar returns of equity (clip denom to avoid /0 if equity hits 0)
        denom = np.where(np.abs(eq[:-1]) < 1e-9, 1e-9, eq[:-1])
        r = (eq[1:] - eq[:-1]) / denom
        r = r[np.isfinite(r)]
        if r.size >= 2 and r.std(ddof=1) > 0:
            bars_per_year = quant_metrics.infer_bars_per_year(time_a)
            if bars_per_year > 0:
                sharpe = float(r.mean() / r.std(ddof=1) * math.sqrt(bars_per_year))

    max_dd_dollars = float(dd_dollars_arr.min()) if len(dd_dollars_arr) else 0.0

    # Peak-relative max DD %: denominator is the running peak equity at the
    # moment of the worst drawdown (TradingView convention), not starting cap.
    # peak_at_t = equity_t - dd_dollars_t (since dd ≤ 0 and dd = eq - peak).
    max_dd_pct_peak = 0.0
    if equity_arr is not None and len(equity_arr) and len(dd_dollars_arr):
        eq_a = np.asarray(equity_arr, dtype=float)
        dd_a = np.asarray(dd_dollars_arr, dtype=float)
        peak_a = eq_a - dd_a  # always >= eq_a
        # Avoid /0 when an early bar has 0 equity; clip to starting_capital.
        denom = np.where(peak_a > 1e-9, peak_a, float(starting_capital))
        dd_pct_a = dd_a / denom * 100.0  # ≤ 0
        max_dd_pct_peak = float(dd_pct_a.min())

    longs  = [t for t in trades if t["side"] == "long"]
    shorts = [t for t in trades if t["side"] == "short"]

    return {
        "starting_capital": float(starting_capital),
        "final_equity": float(final_equity),
        "total_return_dollars": float(final_equity - starting_capital),
        "total_return_pct": float((final_equity / starting_capital - 1.0) * 100.0),
        "trades": int(n_trades),
        "wins": int(wins),
        "losses": int(losses),
        "breakeven": int(breakeven),
        "win_rate": float(win_rate),
        "profit_factor": profit_factor,
        "sharpe": (float(sharpe) if sharpe is not None else None),
        "gross_profit": gross_profit,
        "gross_loss": gross_loss,
        # max_drawdown_pct: DD relative to starting capital (initial equity).
        # max_drawdown_pct_peak: DD relative to running peak (industry standard).
        "max_drawdown_pct": float(max_dd_dollars) / float(starting_capital) * 100.0,
        "max_drawdown_pct_peak": float(max_dd_pct_peak),
        "max_drawdown_dollars": float(max_dd_dollars),
        "avg_pnl_dollars": float(pnl_arr.mean()) if trades else 0.0,
        "avg_pnl_pct": float(pct_arr.mean()) if trades else 0.0,
        "long":  _side_block(longs),
        "short": _side_block(shorts),
        "first_time": int(time_a[0]),
        "last_time": int(time_a[-1]),
    }


def _side_block(trades) -> dict:
    n = len(trades)
    wins = sum(1 for t in trades if t["win"])
    losses = sum(1 for t in trades if t["pnl_dollars"] < 0)
    pnl = sum(t["pnl_dollars"] for t in trades)
    return {
        "trades": int(n),
        "wins": int(wins),
        "losses": int(losses),
        "pnl_dollars": float(pnl),
        "win_rate": (wins / n) if n else 0.0,
        "avg_pnl_dollars": (pnl / n) if n else 0.0,
    }


# ---------------------------------------------------------------------------
# Analytics block — quant-research-grade insights
# ---------------------------------------------------------------------------

def _compute_analytics(trades, equity_curve, sig_df, strategy, starting_capital,
                       wf_trials=None, sessions_cfg_override=None) -> dict:
    """Heavy stuff for the Analytics page tabs."""
    if sessions_cfg_override is not None:
        sessions_cfg = sessions_cfg_override
    else:
        sessions_cfg = (strategy.p.get("sessions") or {}) if hasattr(strategy, "p") else {}

    # ---- per-session breakdown
    by_session_dict: dict = defaultdict(lambda: {"trades": 0, "wins": 0, "pnl_dollars": 0.0,
                                                 "long_trades": 0, "short_trades": 0,
                                                 "long_pnl": 0.0, "short_pnl": 0.0})
    for t in trades:
        sess = _classify_session(t["entry_time"], sessions_cfg)
        b = by_session_dict[sess]
        b["trades"] += 1
        if t["win"]: b["wins"] += 1
        b["pnl_dollars"] += t["pnl_dollars"]
        if t["side"] == "long":
            b["long_trades"] += 1
            b["long_pnl"]    += t["pnl_dollars"]
        else:
            b["short_trades"] += 1
            b["short_pnl"]    += t["pnl_dollars"]
    by_session = []
    for name, b in by_session_dict.items():
        n = b["trades"]
        by_session.append({
            "session": name,
            "trades": n,
            "wins": b["wins"],
            "win_rate": (b["wins"] / n) if n else 0.0,
            "pnl_dollars": b["pnl_dollars"],
            "avg_pnl_dollars": (b["pnl_dollars"] / n) if n else 0.0,
            "long_trades": b["long_trades"],
            "long_pnl_dollars": b["long_pnl"],
            "short_trades": b["short_trades"],
            "short_pnl_dollars": b["short_pnl"],
        })

    # ---- hour-of-day × day-of-week heatmap (PnL + count)
    heat_pnl = [[0.0] * 24 for _ in range(7)]   # [dow][hour]
    heat_count = [[0] * 24 for _ in range(7)]
    for t in trades:
        dt = datetime.fromtimestamp(t["entry_time"], tz=timezone.utc)
        dow = dt.weekday()  # 0 = Mon
        hour = dt.hour
        heat_pnl[dow][hour] += t["pnl_dollars"]
        heat_count[dow][hour] += 1

    # ---- monthly returns (sum PnL by YYYY-MM)
    monthly_dict: dict = defaultdict(float)
    monthly_trades: dict = defaultdict(int)
    for t in trades:
        ym = datetime.fromtimestamp(t["entry_time"], tz=timezone.utc).strftime("%Y-%m")
        monthly_dict[ym] += t["pnl_dollars"]
        monthly_trades[ym] += 1
    monthly_returns = sorted(
        [{"month": m, "pnl_dollars": v, "trades": monthly_trades[m]} for m, v in monthly_dict.items()],
        key=lambda x: x["month"],
    )

    # ---- streaks
    cur_w = cur_l = max_w = max_l = 0
    for t in trades:
        if t["win"]:
            cur_w += 1; cur_l = 0
            max_w = max(max_w, cur_w)
        else:
            cur_l += 1; cur_w = 0
            max_l = max(max_l, cur_l)

    # ---- drawdown details
    dd_pcts = [p["drawdown"] for p in equity_curve] if equity_curve else [0.0]
    dd_curve = [{"time": p["time"], "drawdown": p["drawdown"]} for p in equity_curve]
    # Max DD duration: how long (in bars) we stayed below previous peak.
    peak = -math.inf
    cur_under = 0
    max_under = 0
    for p in equity_curve:
        if p["equity"] >= peak:
            peak = p["equity"]
            cur_under = 0
        else:
            cur_under += 1
            max_under = max(max_under, cur_under)

    # ---- distribution: bucket per-trade equity impact (% of starting capital)
    # into 20 bins. NOT the underlying price-move % — that ignores leverage
    # / pyramiding and would mislead users.
    distribution = []
    if trades:
        arr = np.array([t.get("pnl_pct_equity", 0.0) for t in trades])
        lo = float(arr.min())
        hi = float(arr.max())
        if hi <= lo:
            hi = lo + 1e-6
        counts, edges = np.histogram(arr, bins=20, range=(lo, hi))
        distribution = [
            {"bin_lo": float(edges[i]), "bin_hi": float(edges[i + 1]), "count": int(counts[i])}
            for i in range(len(counts))
        ]

    # ---- duration distribution (in minutes, 12 bins)
    duration_dist = []
    if trades:
        arr = np.array([t["duration_min"] for t in trades])
        lo = float(arr.min())
        hi = float(arr.max())
        if hi <= lo:
            hi = lo + 1
        counts, edges = np.histogram(arr, bins=12, range=(lo, hi))
        duration_dist = [
            {"bin_lo": float(edges[i]), "bin_hi": float(edges[i + 1]), "count": int(counts[i])}
            for i in range(len(counts))
        ]

    # ---- best / worst single trade
    best  = max(trades, key=lambda t: t["pnl_dollars"]) if trades else None
    worst = min(trades, key=lambda t: t["pnl_dollars"]) if trades else None

    # ---- commission + slippage paid + trading days
    total_commission = float(sum(t.get("fees", 0.0) for t in trades))
    total_slippage   = float(sum(t.get("slippage", 0.0) for t in trades))
    trading_days = len({datetime.fromtimestamp(t["entry_time"], tz=timezone.utc).date()
                        for t in trades})

    # ---- exposure (% of bars where ANY position was open)
    # Union of [entry_bar, exit_bar] intervals across all trades — overlapping
    # pyramided tranches don't double-count.
    exposure_pct = 0.0
    if trades and len(sig_df) > 0:
        time_arr = sig_df["time"].to_numpy()
        idx_lookup = {int(time_arr[i]): i for i in range(len(time_arr))}
        intervals = []
        for t in trades:
            ei = idx_lookup.get(int(t["entry_time"]))
            xi = idx_lookup.get(int(t["exit_time"]))
            if ei is not None and xi is not None and xi >= ei:
                intervals.append((ei, xi))
        intervals.sort()
        pos_bars = 0
        cur_lo = cur_hi = -1
        for lo_i, hi_i in intervals:
            if lo_i > cur_hi:
                if cur_hi >= cur_lo:
                    pos_bars += cur_hi - cur_lo + 1
                cur_lo, cur_hi = lo_i, hi_i
            else:
                cur_hi = max(cur_hi, hi_i)
        if cur_hi >= cur_lo:
            pos_bars += cur_hi - cur_lo + 1
        exposure_pct = pos_bars / len(time_arr) * 100.0

    # ---- advanced quant metrics (expectancy, sortino, calmar, t-test,
    # ulcer, skew, kurtosis, MAE/MFE, robustness when WF data is provided).
    bars_per_year = quant_metrics.infer_bars_per_year(sig_df["time"].to_numpy()) \
        if len(sig_df) > 1 else 0.0
    advanced = quant_metrics.compute(
        trades, equity_curve, starting_capital, bars_per_year, wf_trials=wf_trials,
    )

    return {
        "by_session": by_session,
        "heatmap": {"pnl": heat_pnl, "count": heat_count},
        "monthly_returns": monthly_returns,
        "streaks": {"max_win_streak": max_w, "max_loss_streak": max_l},
        "drawdown_curve": dd_curve,
        "max_drawdown_duration_bars": int(max_under),
        "distribution_pnl_pct": distribution,
        "distribution_duration_min": duration_dist,
        "best_trade": best,
        "worst_trade": worst,
        "exposure_pct": float(exposure_pct),
        "commission_dollars": total_commission,
        "slippage_dollars": total_slippage,
        "trading_days": int(trading_days),
        "advanced": advanced,
    }


def _empty_result(strategy_id, symbol, timeframe, rc):
    return {
        "strategy_id": strategy_id, "symbol": symbol, "timeframe": timeframe,
        "risk_config": rc,
        "candles": [], "overlays": [], "trades": [], "equity": [],
        "stats": {
            "starting_capital": float(rc["starting_capital"]),
            "final_equity": float(rc["starting_capital"]),
            "total_return_dollars": 0.0, "total_return_pct": 0.0,
            "trades": 0, "wins": 0, "losses": 0, "breakeven": 0, "win_rate": 0.0,
            "profit_factor": 0.0, "sharpe": None,
            "gross_profit": 0.0, "gross_loss": 0.0,
            "max_drawdown_pct": 0.0, "max_drawdown_pct_peak": 0.0, "max_drawdown_dollars": 0.0,
            "avg_pnl_dollars": 0.0, "avg_pnl_pct": 0.0,
            "long":  {"trades": 0, "wins": 0, "losses": 0, "pnl_dollars": 0.0, "win_rate": 0.0, "avg_pnl_dollars": 0.0},
            "short": {"trades": 0, "wins": 0, "losses": 0, "pnl_dollars": 0.0, "win_rate": 0.0, "avg_pnl_dollars": 0.0},
            "first_time": None, "last_time": None,
        },
        "analytics": {
            "by_session": [],
            "heatmap": {"pnl": [[0.0] * 24 for _ in range(7)],
                        "count": [[0] * 24 for _ in range(7)]},
            "monthly_returns": [], "streaks": {"max_win_streak": 0, "max_loss_streak": 0},
            "drawdown_curve": [], "max_drawdown_duration_bars": 0,
            "distribution_pnl_pct": [], "distribution_duration_min": [],
            "best_trade": None, "worst_trade": None, "exposure_pct": 0.0,
            "commission_dollars": 0.0, "slippage_dollars": 0.0, "trading_days": 0,
            "advanced": quant_metrics.compute([], [], float(rc["starting_capital"]), 0.0),
        },
    }
