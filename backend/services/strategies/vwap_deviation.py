"""
VWAP Deviation Reversion (QUANT) — VWAP mean-reversion with a trend filter.

Port of the TradingView Pine v6 strategy "BTC VWAP Deviation Strategy QUANT".
Authored on BTC; runs on our BTCUSDT data (crypto auto-sizes by risk_pct).

Core idea (mean reversion to VWAP, only in the direction of the EMA trend):
  vwap        = session VWAP (Σ close·vol / Σ vol), RESET each UTC day
  atr         = Wilder ATR(atr_length)
  rsi         = Wilder RSI(rsi_length)
  ema         = EMA(trend_ema)
  upperDev    = vwap + atr·deviation_atr     lowerDev = vwap - atr·deviation_atr

  LONG  : close < lowerDev AND rsi < 35 AND close > ema  (oversold dip in an uptrend)
  SHORT : close > upperDev AND rsi > 65 AND close < ema  (overbought pop in a downtrend)
  -> enter next bar at open.

  EXIT (both sides): take profit back at VWAP (limit) OR a 2.5·ATR stop. As in the
  Pine, the stop is dynamic — recomputed every bar at close ∓ stop_atr·ATR — and the
  target is the live VWAP. Here both are read from the PRIOR bar (causal, no
  look-ahead) and applied intrabar against this bar's high/low; the adverse stop is
  taken before the favorable target.

Optional filters (all OFF by default, matching the Pine): VWAP z-score, a
volatility-regime gate (atr < SMA(atr)), a volume-spike gate, and a session
(UTC hour) window.

PORTING NOTES
  - Pyramiding: the Pine stacks up to 5 entries (pyramiding=5, 10% equity each).
    This port runs a SINGLE position (one entry at a time) — simpler and it keeps
    the per-position dynamic stop/target unambiguous. Sizing is risk_pct of equity
    (default 10%, matching the Pine's default_qty_value) on crypto.
  - Indicators are bar-level (no daily reconstruction) except VWAP, which anchors
    to the UTC calendar day (TradingView's default session anchor for 24/7 crypto).
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)

_DAY = 86400  # seconds/day — VWAP anchor


# ---------------------------------------------------------------------------
# Indicators (causal; match TradingView ta.* semantics)
# ---------------------------------------------------------------------------

def _wilder_rma(x: np.ndarray, period: int) -> np.ndarray:
    """Wilder RMA (ta.rma): seed = SMA of the first `period`, then EMA with a=1/period."""
    n = len(x)
    out = np.full(n, np.nan)
    if n < period or period < 1:
        return out
    a = 1.0 / period
    out[period - 1] = float(np.mean(x[:period]))
    for i in range(period, n):
        out[i] = out[i - 1] * (1 - a) + x[i] * a
    return out


def _atr(high, low, close, period: int) -> np.ndarray:
    n = len(close)
    tr = np.empty(n)
    if n:
        tr[0] = high[0] - low[0]
    for i in range(1, n):
        pc = close[i - 1]
        tr[i] = max(high[i] - low[i], abs(high[i] - pc), abs(low[i] - pc))
    return _wilder_rma(tr, period)


def _rsi_from(ag: float, al: float) -> float:
    if al <= 1e-12:
        return 100.0 if ag > 0 else 50.0
    return 100.0 - 100.0 / (1.0 + ag / al)


def _rsi(close: np.ndarray, period: int) -> np.ndarray:
    n = len(close)
    out = np.full(n, np.nan)
    if n <= period or period < 1:
        return out
    ch = np.diff(close)                       # ch[k] = close[k+1] - close[k]
    g = np.where(ch > 0, ch, 0.0)
    l = np.where(ch < 0, -ch, 0.0)
    a = 1.0 / period
    ag = float(g[:period].mean()); al = float(l[:period].mean())
    out[period] = _rsi_from(ag, al)           # first RSI at close index `period`
    for k in range(period, n - 1):
        ag = ag * (1 - a) + g[k] * a
        al = al * (1 - a) + l[k] * a
        out[k + 1] = _rsi_from(ag, al)
    return out


def _ema(close: np.ndarray, span: int) -> np.ndarray:
    return pd.Series(close).ewm(span=span, adjust=False).mean().to_numpy()


def _session_vwap(time: np.ndarray, price: np.ndarray, volume: np.ndarray) -> np.ndarray:
    """Cumulative Σ(price·vol)/Σvol, reset at each UTC calendar day boundary."""
    n = len(time)
    out = np.empty(n)
    day = (time // _DAY)
    cum_pv = 0.0; cum_v = 0.0; cur = None
    for i in range(n):
        if day[i] != cur:
            cur = day[i]; cum_pv = 0.0; cum_v = 0.0
        cum_pv += price[i] * volume[i]; cum_v += volume[i]
        out[i] = (cum_pv / cum_v) if cum_v > 0 else price[i]
    return out


class VwapDeviationStrategy(Strategy):
    PARAM_SCHEMA = [
        # --- Bands / indicators
        ParamSpec("deviation_atr", ParamType.FLOAT, 1.0, min=0.1, max=10.0, step=0.1, group="Bands",
                  description="ATR multiplier for the VWAP deviation bands (upper/lower = vwap ± atr·this)."),
        ParamSpec("atr_length", ParamType.INT, 10, min=2, max=100, step=1, group="Bands",
                  description="Wilder ATR length (Pine atrLen 10)."),
        ParamSpec("rsi_length", ParamType.INT, 10, min=2, max=50, step=1, group="Bands",
                  description="Wilder RSI length (Pine rsiLen 10)."),
        ParamSpec("trend_ema", ParamType.INT, 120, min=10, max=400, step=5, group="Bands",
                  description="Trend EMA length; long only above it, short only below it (Pine emaLen 120)."),
        ParamSpec("rsi_long_below", ParamType.FLOAT, 35.0, min=5.0, max=50.0, step=1.0, group="Bands",
                  description="Long only when RSI < this (oversold). Pine 35."),
        ParamSpec("rsi_short_above", ParamType.FLOAT, 65.0, min=50.0, max=95.0, step=1.0, group="Bands",
                  description="Short only when RSI > this (overbought). Pine 65."),

        # --- Exit
        ParamSpec("stop_atr", ParamType.FLOAT, 2.5, min=0.2, max=20.0, step=0.1, group="Exit",
                  description="Stop distance in ATRs: dynamic stop at close ∓ this·ATR (recomputed each bar). "
                              "Take-profit is the live VWAP (Pine slATR 2.5)."),

        # --- Direction
        ParamSpec("enable_long", ParamType.BOOL, True, group="Direction",
                  description="Allow long entries."),
        ParamSpec("enable_short", ParamType.BOOL, True, group="Direction",
                  description="Allow short entries."),

        # --- Optional filters (all OFF by default, matching the Pine)
        ParamSpec("use_zscore", ParamType.BOOL, False, group="Filters",
                  description="Require a VWAP z-score extreme: long if z < -threshold, short if z > +threshold."),
        ParamSpec("zscore_length", ParamType.INT, 50, min=5, max=300, step=5, group="Filters",
                  description="Lookback for stdev of (close - vwap) used in the z-score."),
        ParamSpec("zscore_threshold", ParamType.FLOAT, 2.0, min=0.5, max=6.0, step=0.1, group="Filters",
                  description="Z-score magnitude required to enter."),
        ParamSpec("use_regime", ParamType.BOOL, False, group="Filters",
                  description="Volatility regime gate: only enter when ATR < SMA(ATR, regime length) (calm)."),
        ParamSpec("atr_regime_length", ParamType.INT, 50, min=5, max=300, step=5, group="Filters",
                  description="SMA length over ATR for the regime gate."),
        ParamSpec("use_volume", ParamType.BOOL, False, group="Filters",
                  description="Volume-spike gate: only enter when volume > SMA(volume) · multiplier."),
        ParamSpec("volume_length", ParamType.INT, 20, min=2, max=200, step=1, group="Filters",
                  description="SMA length for the volume gate."),
        ParamSpec("volume_mult", ParamType.FLOAT, 1.5, min=1.0, max=10.0, step=0.1, group="Filters",
                  description="Volume must exceed its SMA by this multiple."),
        ParamSpec("use_session", ParamType.BOOL, False, group="Filters",
                  description="Restrict entries to a UTC hour window [start, end] (Pine session filter; default off = all day)."),
        ParamSpec("session_start_hour", ParamType.INT, 0, min=0, max=23, step=1, group="Filters",
                  description="Earliest UTC entry hour (inclusive) when the session filter is on."),
        ParamSpec("session_end_hour", ParamType.INT, 23, min=0, max=23, step=1, group="Filters",
                  description="Latest UTC entry hour (inclusive). If end < start the window wraps past midnight."),

        # --- Risk / sizing
        ParamSpec("risk_pct", ParamType.FLOAT, 10.0, min=0.1, max=100.0, step=0.5, group="Risk",
                  description="% of equity per trade on crypto/spot (Pine default_qty_value 10)."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Contracts per trade if run on a contract-sized future (inert on crypto)."),
    ]

    META = StrategyMeta(
        id="vwap_deviation",
        name="VWAP Deviation Reversion (QUANT) - BTC",
        description=("VWAP mean reversion with a trend filter. Buys oversold dips below the lower "
                     "VWAP±ATR band while above the trend EMA (and sells overbought pops above the "
                     "upper band while below it), targeting reversion back to the live VWAP with a "
                     "dynamic 2.5·ATR stop. Optional z-score / regime / volume / session filters "
                     "(off by default). Ported from the TradingView 'BTC VWAP Deviation Strategy QUANT'."),
        schema=PARAM_SCHEMA,
        kind="ohlc",
    )

    OVERLAYS = [
        OverlaySpec("vwap_dev_vwap",  "VWAP",       from_column="vwap",      color="#f59e0b", line_width=2),
        OverlaySpec("vwap_dev_upper", "Upper Dev",  from_column="upper_dev", color="rgba(248,113,113,0.7)", line_width=1),
        OverlaySpec("vwap_dev_lower", "Lower Dev",  from_column="lower_dev", color="rgba(74,222,128,0.7)", line_width=1),
        OverlaySpec("vwap_dev_ema",   "Trend EMA",  from_column="ema_trend", color="#3b82f6", line_width=1),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        open_ = out["open"].astype(float).to_numpy()
        high  = out["high"].astype(float).to_numpy()
        low   = out["low"].astype(float).to_numpy()
        close = out["close"].astype(float).to_numpy()
        time  = out["time"].astype(np.int64).to_numpy()
        vol   = (out["volume"].astype(float).to_numpy()
                 if "volume" in out.columns else np.ones(len(out)))
        n = len(out)

        dev_mult = float(p["deviation_atr"]); atr_len = int(p["atr_length"])
        rsi_len  = int(p["rsi_length"]);      ema_len = int(p["trend_ema"])
        sl_mult  = float(p["stop_atr"])
        rsi_long = float(p["rsi_long_below"]); rsi_short = float(p["rsi_short_above"])
        long_on  = bool(p["enable_long"]);     short_on = bool(p["enable_short"])
        use_z    = bool(p["use_zscore"]); z_len = int(p["zscore_length"]); z_th = float(p["zscore_threshold"])
        use_reg  = bool(p["use_regime"]); reg_len = int(p["atr_regime_length"])
        use_volf = bool(p["use_volume"]); vol_len = int(p["volume_length"]); vol_mult = float(p["volume_mult"])
        use_sess = bool(p["use_session"]); s_start = int(p["session_start_hour"]); s_end = int(p["session_end_hour"])

        vwap = _session_vwap(time, close, vol)
        atr  = _atr(high, low, close, atr_len)
        rsi  = _rsi(close, rsi_len)
        ema  = _ema(close, ema_len)
        upper = vwap + atr * dev_mult
        lower = vwap - atr * dev_mult

        z = atr_ma = vol_ma = None
        if use_z:
            dev = close - vwap
            std = pd.Series(dev).rolling(z_len).std(ddof=0).to_numpy()   # ta.stdev = population
            z = np.divide(dev, std, out=np.full(n, np.nan), where=std > 0)
        if use_reg:
            atr_ma = pd.Series(atr).rolling(reg_len).mean().to_numpy()
        if use_volf:
            vol_ma = pd.Series(vol).rolling(vol_len).mean().to_numpy()
        hours = ((time // 3600) % 24).astype(np.int64)

        cond_long  = np.zeros(n, dtype=bool); cond_short = np.zeros(n, dtype=bool)
        bar_exit_long = np.zeros(n, dtype=bool); bar_exit_short = np.zeros(n, dtype=bool)
        exit_fill_long = np.full(n, np.nan); exit_fill_short = np.full(n, np.nan)

        pos = 0; entry_price = np.nan
        for t in range(n):
            o = open_[t]; h = high[t]; l = low[t]; c = close[t]

            # ---- Exit (in a position): dynamic stop & live-VWAP target, both from t-1 ----
            if pos != 0 and np.isfinite(entry_price) and t >= 1:
                tgt = vwap[t - 1]
                if pos == 1:
                    stop = (close[t - 1] - sl_mult * atr[t - 1]) if np.isfinite(atr[t - 1]) else -np.inf
                    if l <= stop:
                        bar_exit_long[t] = True; exit_fill_long[t] = min(stop, o)
                        pos = 0; entry_price = np.nan
                    elif np.isfinite(tgt) and h >= tgt:
                        bar_exit_long[t] = True; exit_fill_long[t] = max(tgt, o)
                        pos = 0; entry_price = np.nan
                else:  # pos == -1
                    stop = (close[t - 1] + sl_mult * atr[t - 1]) if np.isfinite(atr[t - 1]) else np.inf
                    if h >= stop:
                        bar_exit_short[t] = True; exit_fill_short[t] = max(stop, o)
                        pos = 0; entry_price = np.nan
                    elif np.isfinite(tgt) and l <= tgt:
                        bar_exit_short[t] = True; exit_fill_short[t] = min(tgt, o)
                        pos = 0; entry_price = np.nan

            # ---- Entry (flat): mean-revert past a band, in the EMA trend direction ----
            if (pos == 0 and t + 1 < n
                    and np.isfinite(atr[t]) and np.isfinite(rsi[t]) and np.isfinite(ema[t])):
                filt = True
                if use_reg and not (np.isfinite(atr_ma[t]) and atr[t] < atr_ma[t]):
                    filt = False
                if filt and use_volf and not (np.isfinite(vol_ma[t]) and vol[t] > vol_ma[t] * vol_mult):
                    filt = False
                if filt and use_sess:
                    hr = int(hours[t])
                    in_sess = (s_start <= s_end and s_start <= hr <= s_end) or \
                              (s_start > s_end and (hr >= s_start or hr <= s_end))
                    if not in_sess:
                        filt = False
                if filt:
                    z_long  = (not use_z) or (np.isfinite(z[t]) and z[t] < -z_th)
                    z_short = (not use_z) or (np.isfinite(z[t]) and z[t] >  z_th)
                    if long_on and c < lower[t] and rsi[t] < rsi_long and c > ema[t] and z_long:
                        cond_long[t] = True; pos = 1; entry_price = open_[t + 1]
                    elif short_on and c > upper[t] and rsi[t] > rsi_short and c < ema[t] and z_short:
                        cond_short[t] = True; pos = -1; entry_price = open_[t + 1]

        out["cond_long"]       = cond_long
        out["cond_short"]      = cond_short
        out["bar_exit_long"]   = bar_exit_long
        out["bar_exit_short"]  = bar_exit_short
        out["entry_long"]      = cond_long
        out["entry_short"]     = cond_short
        out["exit_long"]       = bar_exit_long
        out["exit_short"]      = bar_exit_short
        out["stop_price"]      = np.full(n, np.nan)
        out["exit_fill_long"]  = exit_fill_long
        out["exit_fill_short"] = exit_fill_short
        out["vwap"]      = vwap
        out["upper_dev"] = upper
        out["lower_dev"] = lower
        out["ema_trend"] = ema
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        atr_len = int(p["atr_length"]); rsi_len = int(p["rsi_length"]); ema_len = int(p["trend_ema"])
        sl_mult = float(p["stop_atr"]); dev_mult = float(p["deviation_atr"])
        rsi_long = float(p["rsi_long_below"]); rsi_short = float(p["rsi_short_above"])
        long_on = bool(p["enable_long"]); short_on = bool(p["enable_short"])
        use_z = bool(p["use_zscore"]); z_len = int(p["zscore_length"]); z_th = float(p["zscore_threshold"])
        use_reg = bool(p["use_regime"]); reg_len = int(p["atr_regime_length"])
        use_volf = bool(p["use_volume"]); vol_len = int(p["volume_length"]); vol_mult = float(p["volume_mult"])
        use_sess = bool(p["use_session"]); s_start = int(p["session_start_hour"]); s_end = int(p["session_end_hour"])

        t = int(candle["time"]); o = float(candle["open"]); h = float(candle["high"])
        l = float(candle["low"]); c = float(candle["close"]); v = float(candle.get("volume", 0.0) or 0.0)

        buf = state.setdefault("buf", [])
        buf.append({"high": h, "low": l, "close": c, "volume": v})
        keep = max(ema_len, atr_len, rsi_len, z_len, reg_len, vol_len) * 3 + 60
        if len(buf) > keep:
            del buf[: len(buf) - keep]

        # Day-anchored VWAP accumulated in state (survives buffer trimming).
        day = t // _DAY
        if state.get("vwap_day") != day:
            state["vwap_day"] = day; state["vwap_pv"] = 0.0; state["vwap_vol"] = 0.0
        state["vwap_pv"] += c * v; state["vwap_vol"] += v
        vwap_now = (state["vwap_pv"] / state["vwap_vol"]) if state["vwap_vol"] > 0 else c
        vwap_prev = float(state.get("vwap_prev", vwap_now))

        def _done(sig=None):
            state["vwap_prev"] = vwap_now
            return sig

        n = len(buf)
        if n < max(atr_len, rsi_len, ema_len) + 2:
            return _done()

        highs = np.array([b["high"] for b in buf]); lows = np.array([b["low"] for b in buf])
        closes = np.array([b["close"] for b in buf]); vols = np.array([b["volume"] for b in buf])
        atr = _atr(highs, lows, closes, atr_len); rsi = _rsi(closes, rsi_len); ema = _ema(closes, ema_len)
        i = n - 1
        if not (np.isfinite(atr[i]) and np.isfinite(rsi[i]) and np.isfinite(ema[i])):
            return _done()

        upper = vwap_now + atr[i] * dev_mult; lower = vwap_now - atr[i] * dev_mult
        pos = int(state.get("pos", 0)); entry_p = float(state.get("entry_p", np.nan))

        # ---- Exit ----
        if pos != 0 and np.isfinite(entry_p) and np.isfinite(atr[i - 1]):
            if pos == 1:
                stop = closes[i - 1] - sl_mult * atr[i - 1]
                if l <= stop or h >= vwap_prev:
                    state.update({"pos": 0, "entry_p": np.nan})
                    return _done(Signal("long", "exit", c, t, "stop" if l <= stop else "vwap_target"))
            else:
                stop = closes[i - 1] + sl_mult * atr[i - 1]
                if h >= stop or l <= vwap_prev:
                    state.update({"pos": 0, "entry_p": np.nan})
                    return _done(Signal("short", "exit", c, t, "stop" if h >= stop else "vwap_target"))
            return _done()

        # ---- Entry ----
        if pos == 0:
            filt = True
            if use_reg:
                am = float(pd.Series(atr).rolling(reg_len).mean().to_numpy()[i]) if n >= reg_len else np.nan
                if not (np.isfinite(am) and atr[i] < am):
                    filt = False
            if filt and use_volf:
                vm = float(pd.Series(vols).rolling(vol_len).mean().to_numpy()[i]) if n >= vol_len else np.nan
                if not (np.isfinite(vm) and vols[i] > vm * vol_mult):
                    filt = False
            if filt and use_sess:
                hr = (t // 3600) % 24
                in_sess = (s_start <= s_end and s_start <= hr <= s_end) or \
                          (s_start > s_end and (hr >= s_start or hr <= s_end))
                if not in_sess:
                    filt = False
            z_ok_long = z_ok_short = True
            if filt and use_z and n >= z_len:
                dev = closes - vwap_now
                std = float(pd.Series(dev).rolling(z_len).std(ddof=0).to_numpy()[i])
                zz = (dev[i] / std) if std > 0 else np.nan
                z_ok_long = np.isfinite(zz) and zz < -z_th
                z_ok_short = np.isfinite(zz) and zz > z_th
            elif use_z:
                z_ok_long = z_ok_short = False
            if filt:
                if long_on and c < lower and rsi[i] < rsi_long and c > ema[i] and z_ok_long:
                    state.update({"pos": 1, "entry_p": c})
                    return _done(Signal("long", "entry", c, t, "vwap_dev"))
                if short_on and c > upper and rsi[i] > rsi_short and c < ema[i] and z_ok_short:
                    state.update({"pos": -1, "entry_p": c})
                    return _done(Signal("short", "entry", c, t, "vwap_dev"))
        return _done()
