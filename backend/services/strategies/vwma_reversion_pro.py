"""
VWMA Reversion PRO — the VWMA z-score / RSI mean-reversion core with four
optional, independently-toggleable risk modules layered on top:

  1. TIME STOP        — force-exit a position after N bars if it hasn't reverted
                        (kills the "reversion that turned into a trend" loser).
  2. VOLUME GATE      — only enter on a volume spike at the extreme (capitulation),
                        i.e. volume >= mult x its rolling average.
  3. ATR SIZING       — size DOWN when volatility is high: per-trade risk is scaled
                        by target_atr% / current_atr% (clamped). Needs the engine's
                        `risk_scale` hook (opt-in column; engine multiplies risk_frac).
  4. SCALE-OUT        — bank a fraction of the position at the mean (first target)
                        and let the remainder run to the opposite band. Needs the
                        engine's partial-exit hook (opt-in `scale_exit_*` columns).

  + a TWEAKABLE MEAN-REVERSION CONFIRMATION gate: only enter when the recent series
    is statistically reverting (rolling lag-1 autocorrelation of returns below a
    threshold). Lookback and threshold are both params, so it can be tuned.

With every toggle OFF this is plain VWMA reversion (single position). Unlike the
base strategy this drives the engine through the ONE-SHOT entry/exit path
(entry_long/exit_long) so the strategy itself owns the time-stop and scale-out
state; it deliberately does NOT emit cond_*/bar_exit_*/atr columns (which would
hand exit timing + the ATR stop back to the engine).

Indicator math is shared with services/strategies/vwma_reversion.py.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)
from services.strategies.vwma_reversion import _vwma, _rsi, _atr
from services.strategies.regime import (
    RegimeDetector, REGIME_LABELS, _regime_labels, _regime_params,
)
from services.strategies.session_utils import parse_hhmm, in_window_live, session_mask


def _rolling_lag1_autocorr(close: pd.Series, lookback: int) -> pd.Series:
    """Causal rolling lag-1 autocorrelation of simple returns over `lookback`
    bars. Negative => mean-reverting (a down move tends to be followed by an up
    move). Uses only bars <= t, so it is safe as a live entry filter."""
    r = close.pct_change()
    return r.rolling(lookback).corr(r.shift(1))


class VwmaReversionProStrategy(Strategy):
    PARAM_SCHEMA = [
        # --- Core VWMA reversion (same as the base strategy) ----------------
        ParamSpec("vwma_length",  ParamType.INT,   30,  min=5,  max=200, step=1, group="VWMA"),
        ParamSpec("z_threshold",  ParamType.FLOAT, 1.5, min=0.5, max=4.0, step=0.1, group="VWMA"),
        ParamSpec("rsi_length",   ParamType.INT,   25,  min=5,  max=50,  step=1, group="RSI"),
        ParamSpec("rsi_long_max", ParamType.INT,   35,  min=25, max=40,  step=1, group="RSI"),
        ParamSpec("rsi_short_min",ParamType.INT,   65,  min=60, max=75,  step=1, group="RSI"),

        # --- ATR stop (loss) -----------------------------------------------
        ParamSpec("atr_stop",   ParamType.BOOL,  True, group="Stop",
                  description="ATR-based hard stop. Off = exit only on mean-revert / time stop / scale-out."),
        ParamSpec("atr_length", ParamType.INT,   10,  min=5,  max=50, step=1,   group="Stop"),
        ParamSpec("atr_mult",   ParamType.FLOAT, 6.0, min=1,  max=20, step=0.5, group="Stop"),

        # --- 1. TIME STOP ---------------------------------------------------
        ParamSpec("use_time_stop", ParamType.BOOL, False, group="Time Stop",
                  description="Force-exit after N bars if the position hasn't reverted to the mean."),
        ParamSpec("time_stop_bars", ParamType.INT, 24, min=1, max=500, step=1, group="Time Stop",
                  description="Bars to hold before the time stop forces an exit (TIME STOP must be on)."),

        # --- 2. VOLUME GATE -------------------------------------------------
        ParamSpec("use_volume_gate", ParamType.BOOL, False, group="Volume Gate",
                  description="Only enter when volume spikes at the extreme (capitulation confirmation)."),
        ParamSpec("volume_ma_length", ParamType.INT, 20, min=2, max=200, step=1, group="Volume Gate",
                  description="Rolling-average length the entry-bar volume is compared against."),
        ParamSpec("volume_mult", ParamType.FLOAT, 1.5, min=1.0, max=10.0, step=0.1, group="Volume Gate",
                  description="Require entry-bar volume >= this x its rolling average (VOLUME GATE on)."),

        # --- 3. ATR SIZING (size down when vol is high) ---------------------
        ParamSpec("use_atr_sizing", ParamType.BOOL, False, group="ATR Sizing",
                  description="Scale per-trade size by target_atr% / current_atr% (clamped) — smaller "
                              "positions when volatility is high. Risk% becomes the size at target vol."),
        ParamSpec("atr_sizing_target_pct", ParamType.FLOAT, 1.0, min=0.05, max=20.0, step=0.05, group="ATR Sizing",
                  description="Target ATR as % of price. At this vol size = full Risk%; above it, size shrinks."),
        ParamSpec("atr_sizing_min", ParamType.FLOAT, 0.25, min=0.05, max=1.0, step=0.05, group="ATR Sizing",
                  description="Floor on the size multiplier (don't size below this x Risk%)."),
        ParamSpec("atr_sizing_max", ParamType.FLOAT, 2.0, min=1.0, max=5.0, step=0.25, group="ATR Sizing",
                  description="Cap on the size multiplier (don't size above this x Risk%)."),

        # --- 4. SCALE-OUT ---------------------------------------------------
        ParamSpec("use_scale_out", ParamType.BOOL, False, group="Scale-Out",
                  description="Bank a fraction at the mean (first target); let the remainder run to the "
                              "opposite band. Needs the engine partial-exit hook."),
        ParamSpec("scale_out_frac", ParamType.FLOAT, 0.5, min=0.05, max=0.95, step=0.05, group="Scale-Out",
                  description="Fraction of the position to close at the mean. The rest rides to the opposite "
                              "band (mean +/- z*sigma), the ATR stop, or the time stop."),

        # --- Mean-reversion confirmation (tweakable) ------------------------
        ParamSpec("use_mr_confirm", ParamType.BOOL, False, group="MR Confirm",
                  description="Only enter when the series is statistically reverting: rolling lag-1 "
                              "autocorrelation of returns below the threshold below."),
        ParamSpec("mr_lookback", ParamType.INT, 50, min=10, max=500, step=5, group="MR Confirm",
                  description="Bars used for the rolling lag-1 autocorrelation (the reversion test window)."),
        ParamSpec("mr_max_autocorr", ParamType.FLOAT, 0.0, min=-1.0, max=1.0, step=0.05, group="MR Confirm",
                  description="Enter only when lag-1 autocorr < this (0 = require negative autocorr = reverting; "
                              "raise toward 1 to loosen, lower toward -1 to demand stronger reversion)."),

        # --- Sessions / direction / regime (same as base) ------------------
        ParamSpec("trade_24_7", ParamType.BOOL, False, group="Sessions",
                  description="Trade any time of day; the session windows below are ignored."),
        ParamSpec("sessions", ParamType.SESSIONS,
                  {
                    "tokyo":  {"enabled": True,  "start": "00:00", "end": "04:00"},
                    "london": {"enabled": True,  "start": "05:00", "end": "12:30"},
                    "ny_am":  {"enabled": True,  "start": "12:30", "end": "16:00"},
                    "ny_pm":  {"enabled": False, "start": "17:00", "end": "20:00"},
                  },
                  group="Sessions",
                  description="UTC session windows where new entries are allowed."),
        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": True}, group="Direction"),
        ParamSpec("use_regime", ParamType.BOOL, False, group="Regime",
                  description="Block entries when ADX signals a trending market. Exits still fire."),
        ParamSpec("regime_adx_period",    ParamType.INT,   20,   min=5,  max=50,  step=1,   group="Regime"),
        ParamSpec("regime_adx_threshold", ParamType.FLOAT, 40.0, min=10.0, max=60.0, step=1.0, group="Regime"),
        ParamSpec("use_five_regime", ParamType.BOOL, False, group="Regime",
                  description="Use the 5-regime classifier instead of the binary ADX filter."),
        ParamSpec("allowed_regimes", ParamType.REGIMES,
                  {"Trending Up": False, "Trending Down": False,
                   "High-Volatility": False, "Quiet": True, "Choppy-Range": True},
                  group="Regime",
                  description="When the 5-regime engine is on, only these regimes may take entries."),

        # --- Risk -----------------------------------------------------------
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Base position size as % of equity per trade (before ATR sizing scales it)."),
    ]

    META = StrategyMeta(
        id="vwma_reversion_pro",
        name="VWMA Reversion PRO",
        description=("VWMA z-score / RSI mean reversion with optional time stop, volume-spike gate, "
                     "ATR-scaled sizing, scale-out, and a tweakable mean-reversion confirmation filter. "
                     "All modules toggle independently; all-off = plain VWMA reversion."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("vwma",  "VWMA",  from_column="vwma",       color="#fbbf24", line_width=2),
        OverlaySpec("upper", "+z·σ",  from_column="upper_band", color="rgba(34,211,238,0.55)", line_style="dashed"),
        OverlaySpec("lower", "-z·σ",  from_column="lower_band", color="rgba(34,211,238,0.55)", line_style="dashed"),
    ]

    # ------------------------------------------------------------------ helpers
    def _entry_conditions(self, df, mean, std, zscore, rsi):
        """Per-bar boolean long/short ENTRY conditions (position-independent),
        shared by vectorized() and on_candle(). Returns (long_cond, short_cond,
        in_session, vol_ok, mr_ok) as numpy bool arrays."""
        p = self.p
        idx = df.index
        if bool(p.get("trade_24_7")):
            in_sess = pd.Series(True, index=idx)
        else:
            tsm = pd.to_datetime(df["time"], unit="s", utc=True); tsm.index = idx
            in_sess = session_mask(tsm, p["sessions"])

        vol = df["volume"].astype(float) if "volume" in df.columns else pd.Series(1.0, index=idx)
        if bool(p.get("use_volume_gate")):
            vma = vol.rolling(int(p["volume_ma_length"])).mean()
            vol_ok = (vol >= float(p["volume_mult"]) * vma).fillna(False)
        else:
            vol_ok = pd.Series(True, index=idx)

        if bool(p.get("use_mr_confirm")):
            ac = _rolling_lag1_autocorr(df["close"].astype(float), int(p["mr_lookback"]))
            mr_ok = (ac < float(p["mr_max_autocorr"])).fillna(False)
        else:
            mr_ok = pd.Series(True, index=idx)

        sides = p["sides"]
        base = in_sess & vol_ok & mr_ok
        if sides.get("long"):
            long_cond = base & (zscore < -p["z_threshold"]) & (rsi < p["rsi_long_max"])
        else:
            long_cond = pd.Series(False, index=idx)
        if sides.get("short"):
            short_cond = base & (zscore > p["z_threshold"]) & (rsi > p["rsi_short_min"])
        else:
            short_cond = pd.Series(False, index=idx)

        if p.get("use_regime"):
            if p.get("use_five_regime"):
                rp = _regime_params({"adx_period": p["regime_adx_period"],
                                     "adx_trend_thresh": p["regime_adx_threshold"]})
                labels = _regime_labels(df, rp)
                allowed = [k for k, on in (p.get("allowed_regimes") or {}).items() if on]
                in_regime = pd.Series(np.isin(labels, allowed), index=idx)
            else:
                in_regime = RegimeDetector(p["regime_adx_period"], p["regime_adx_threshold"]).detect(df)
            long_cond = long_cond & in_regime
            short_cond = short_cond & in_regime

        return (long_cond.fillna(False).to_numpy(), short_cond.fillna(False).to_numpy(),
                in_sess.fillna(False).to_numpy())

    def _size_scale(self, atr_val, price):
        """ATR sizing multiplier for the engine's risk_scale hook."""
        p = self.p
        if not bool(p.get("use_atr_sizing")) or not (np.isfinite(atr_val) and price > 0):
            return 1.0
        atr_pct = atr_val / price * 100.0
        if atr_pct <= 0:
            return 1.0
        scale = float(p["atr_sizing_target_pct"]) / atr_pct
        return float(min(float(p["atr_sizing_max"]), max(float(p["atr_sizing_min"]), scale)))

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        close = out["close"].astype(float)
        high = out["high"].astype(float)
        low = out["low"].astype(float)
        vol = out["volume"].astype(float) if "volume" in out.columns else pd.Series(1.0, index=out.index)

        mean = _vwma(close, vol, p["vwma_length"])
        std = close.rolling(p["vwma_length"]).std(ddof=0).replace(0, 1e-9)
        zscore = (close - mean) / std
        rsi = _rsi(close, p["rsi_length"])
        atr = _atr(high, low, close, p["atr_length"])

        lc, sc, _ins = self._entry_conditions(out, mean, std, zscore, rsi)

        n = len(out)
        mean_a = mean.to_numpy(); close_a = close.to_numpy()
        upper_a = (mean + std * p["z_threshold"]).to_numpy()
        lower_a = (mean - std * p["z_threshold"]).to_numpy()
        atr_a = atr.to_numpy()

        entry_long = np.zeros(n, bool);  entry_short = np.zeros(n, bool)
        exit_long  = np.zeros(n, bool);  exit_short  = np.zeros(n, bool)
        scale_exit_long = np.zeros(n, bool); scale_exit_short = np.zeros(n, bool)
        risk_scale = np.ones(n, float)
        stop_price = np.full(n, np.nan)

        atr_on   = bool(p.get("atr_stop", True))
        ts_on    = bool(p.get("use_time_stop"))
        ts_bars  = int(p["time_stop_bars"])
        so_on    = bool(p.get("use_scale_out"))
        mult     = float(p["atr_mult"])

        pos = 0; entry_p = np.nan; atr_at_entry = np.nan; entry_idx = -1; scaled = False
        for t in range(n):
            m = mean_a[t]; c = close_a[t]
            if not np.isfinite(m):
                continue
            if pos == 0:
                a = atr_a[t] if np.isfinite(atr_a[t]) else np.nan
                if lc[t]:
                    pos = 1; entry_p = c; atr_at_entry = a; entry_idx = t; scaled = False
                    entry_long[t] = True; risk_scale[t] = self._size_scale(a, c)
                    if np.isfinite(a): stop_price[t] = c - mult * a
                elif sc[t]:
                    pos = -1; entry_p = c; atr_at_entry = a; entry_idx = t; scaled = False
                    entry_short[t] = True; risk_scale[t] = self._size_scale(a, c)
                    if np.isfinite(a): stop_price[t] = c + mult * a
            elif pos == 1:
                held = t - entry_idx
                stop_hit = atr_on and np.isfinite(atr_at_entry) and c <= entry_p - mult * atr_at_entry
                time_up = ts_on and held >= ts_bars
                if stop_hit or time_up:
                    exit_long[t] = True; pos = 0; entry_p = np.nan; scaled = False
                elif so_on:
                    if not scaled and c >= m:
                        scale_exit_long[t] = True; scaled = True       # bank a fraction at the mean
                    elif scaled and c >= upper_a[t]:
                        exit_long[t] = True; pos = 0; entry_p = np.nan; scaled = False  # runner -> opposite band
                else:
                    if c >= m:
                        exit_long[t] = True; pos = 0; entry_p = np.nan; scaled = False
            else:  # pos == -1
                held = t - entry_idx
                stop_hit = atr_on and np.isfinite(atr_at_entry) and c >= entry_p + mult * atr_at_entry
                time_up = ts_on and held >= ts_bars
                if stop_hit or time_up:
                    exit_short[t] = True; pos = 0; entry_p = np.nan; scaled = False
                elif so_on:
                    if not scaled and c <= m:
                        scale_exit_short[t] = True; scaled = True
                    elif scaled and c <= lower_a[t]:
                        exit_short[t] = True; pos = 0; entry_p = np.nan; scaled = False
                else:
                    if c <= m:
                        exit_short[t] = True; pos = 0; entry_p = np.nan; scaled = False

        out["entry_long"] = entry_long;  out["entry_short"] = entry_short
        out["exit_long"]  = exit_long;   out["exit_short"]  = exit_short
        out["stop_price"] = stop_price
        # Engine hooks (opt-in columns). Only emit scale-out columns when the
        # module is on, so an all-off run is a vanilla single-position backtest.
        out["risk_scale"] = risk_scale
        if so_on:
            out["scale_exit_long"]  = scale_exit_long
            out["scale_exit_short"] = scale_exit_short
            out["scale_out_frac"]   = float(p["scale_out_frac"])
        out["vwma"] = mean
        out["upper_band"] = mean + std * p["z_threshold"]
        out["lower_band"] = mean - std * p["z_threshold"]
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """Single-position live path. Time stop + volume gate + MR-confirm + ATR
        stop are honored; SCALE-OUT and ATR-sizing are backtest/engine features
        (partial fills + per-trade sizing), so live holds one full position and
        exits it whole on mean-revert / ATR stop / time stop."""
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        warmup = max(int(p["vwma_length"]), int(p["rsi_length"]), int(p["atr_length"]),
                     int(p["volume_ma_length"]), int(p["mr_lookback"])) * 4
        if p.get("use_regime") and p.get("use_five_regime"):
            rp_live = _regime_params({"adx_period": p["regime_adx_period"],
                                      "adx_trend_thresh": p["regime_adx_threshold"]})
            warmup = max(warmup, int(rp_live["vol_lookback"]) + int(rp_live["vol_window"]))
        buf = state.setdefault("buf", [])
        buf.append({"time": int(candle["time"]), "open": float(candle["open"]),
                    "high": float(candle["high"]), "low": float(candle["low"]),
                    "close": float(candle["close"]), "volume": float(candle.get("volume", 0.0))})
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        if len(buf) < warmup:
            return None

        df = pd.DataFrame(buf)
        close = df["close"].astype(float); high = df["high"].astype(float); low = df["low"].astype(float)
        vol = df["volume"].astype(float)
        mean = _vwma(close, vol, p["vwma_length"])
        std = close.rolling(p["vwma_length"]).std(ddof=0).replace(0, 1e-9)
        zscore = (close - mean) / std
        rsi = _rsi(close, p["rsi_length"])
        atr = _atr(high, low, close, p["atr_length"])

        i = len(df) - 1
        m = float(mean.iloc[-1]) if np.isfinite(mean.iloc[-1]) else np.nan
        if not np.isfinite(m):
            return None
        c = float(close.iloc[-1]); a = float(atr.iloc[-1]) if np.isfinite(atr.iloc[-1]) else np.nan
        ts = int(df["time"].iloc[-1])

        pos = state.get("pos", 0)
        entry_p = state.get("entry_p", np.nan)
        atr_at_entry = state.get("atr_at_entry", np.nan)
        entry_ts = state.get("entry_ts", None)

        # ---- Exit (single position) ----
        if pos != 0 and np.isfinite(entry_p):
            atr_on = bool(p.get("atr_stop", True))
            held_bars = None
            if bool(p.get("use_time_stop")) and entry_ts is not None:
                # bars since entry within the live buffer
                tarr = df["time"].to_numpy()
                held_bars = int(np.sum(tarr > entry_ts))
            time_up = bool(p.get("use_time_stop")) and held_bars is not None and held_bars >= int(p["time_stop_bars"])
            if pos == 1:
                stop_hit = atr_on and np.isfinite(atr_at_entry) and c <= entry_p - p["atr_mult"] * atr_at_entry
                if c >= m or stop_hit or time_up:
                    state.update({"pos": 0, "entry_p": np.nan, "atr_at_entry": np.nan, "entry_ts": None})
                    return Signal(side="long", kind="exit", price=c, time=ts,
                                  reason="time_stop" if time_up else ("atr_stop" if stop_hit else "z_revert"))
                return None
            else:
                stop_hit = atr_on and np.isfinite(atr_at_entry) and c >= entry_p + p["atr_mult"] * atr_at_entry
                if c <= m or stop_hit or time_up:
                    state.update({"pos": 0, "entry_p": np.nan, "atr_at_entry": np.nan, "entry_ts": None})
                    return Signal(side="short", kind="exit", price=c, time=ts,
                                  reason="time_stop" if time_up else ("atr_stop" if stop_hit else "z_revert"))
                return None

        # ---- Entry ----
        lc, sc, _ins = self._entry_conditions(df, mean, std, zscore, rsi)
        if lc[i]:
            state.update({"pos": 1, "entry_p": c, "atr_at_entry": a, "entry_ts": ts})
            return Signal(side="long", kind="entry", price=c, time=ts, reason="z_long")
        if sc[i]:
            state.update({"pos": -1, "entry_p": c, "atr_at_entry": a, "entry_ts": ts})
            return Signal(side="short", kind="entry", price=c, time=ts, reason="z_short")
        return None
