"""
VWAP Deviation Reversion (QUANT) — VWAP mean-reversion with a trend filter.

Ported to match a TradingView Pine v6 "VWAP Deviation Strategy". Symbol-agnostic
(runs on any cached symbol; crypto auto-sizes by risk_pct).

Core idea (mean reversion to VWAP, only in the direction of the EMA trend):
  vwap        = session VWAP (Σ close·vol / Σ vol), RESET each UTC day
  atr         = Wilder ATR(atr_length)
  rsi         = Wilder RSI(rsi_length)               (Pine rsiLen 5)
  ema         = EMA(trend_ema)                       (Pine emaLen 200)
  upperDev    = vwap + atr·deviation_atr     lowerDev = vwap - atr·deviation_atr

  LONG  : close < lowerDev AND rsi < 35 AND close > ema  (oversold dip in an uptrend)
  SHORT : close > upperDev AND rsi > 65 AND close < ema  (overbought pop in a downtrend)
  -> enter next bar at open.

  EXIT (both sides): take profit on reversion back to the VWAP, OR an ATR stop.

PYRAMIDING / EXIT MODEL — shared stop (matches the Pine, and live == backtest)
  The Pine stacks up to `pyramiding` entries (10% equity each) and exits the WHOLE
  position at one shared, dynamically-repositioned stop (close ∓ slATR·ATR each bar)
  or the VWAP take-profit. This port mirrors that exactly: entries stack (one tranche
  per signal bar, up to `pyramiding`), and ALL open tranches close together when price
  reverts to the VWAP or the shared ATR stop is hit. The same rule drives both the
  backtest (vectorized) and the live path (on_candle), so live pyramiding matches the
  backtest and TradingView. Sizing is risk_pct of equity per tranche (default 10%).

  Live note: on_candle returns a LIST of signals — a BUY/SELL per added tranche, and a
  single EXIT_LONG/EXIT_SHORT that closes the whole stack. Each fires one webhook, so
  the broker must add on repeated BUYs and flatten on EXIT (TradingView-style).

Engine contract emitted by vectorized():
  cond_long/cond_short    raw per-bar entry conditions (un-gated → the engine stacks)
  bar_exit_long/short     close-all: price reverted to VWAP OR the shared ATR stop hit
  (no `atr` column)        → the engine's per-tranche fixed stop stays OFF on purpose

Optional filters (all OFF by default, matching the Pine): VWAP z-score, a
volatility-regime gate (atr < SMA(atr)), a volume-spike gate, and the named UTC
session windows (Tokyo/London/NY-morning/NY-afternoon) behind a 24/7 toggle.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)
from services.strategies.session_utils import parse_hhmm, in_window_live, session_mask

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


def _session_vwap(time: np.ndarray, price: np.ndarray, volume: np.ndarray,
                  offset_s: int = 0) -> np.ndarray:
    """Cumulative Σ(price·vol)/Σvol, reset at each calendar-day boundary.

    `offset_s` shifts the day boundary off UTC so the VWAP resets at midnight in
    the chart's timezone (TradingView's anchor). E.g. offset_s = 8*3600 makes the
    daily reset happen at 16:00 UTC = 00:00 UTC+8.
    """
    n = len(time)
    out = np.empty(n)
    day = ((time + offset_s) // _DAY)
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
                  description="ATR multiplier for the VWAP deviation bands (upper/lower = vwap ± atr·this). Pine deviationATR 1.0."),
        ParamSpec("atr_length", ParamType.INT, 10, min=2, max=100, step=1, group="Bands",
                  description="Wilder ATR length (Pine atrLen 10)."),
        ParamSpec("rsi_length", ParamType.INT, 5, min=2, max=50, step=1, group="Bands",
                  description="Wilder RSI length (Pine rsiLen 5)."),
        ParamSpec("trend_ema", ParamType.INT, 200, min=10, max=400, step=5, group="Bands",
                  description="Trend EMA length; long only above it, short only below it (Pine emaLen 200)."),
        ParamSpec("vwap_anchor_offset_h", ParamType.INT, 0, min=-12, max=14, step=1, group="Bands",
                  description="Hour offset from UTC for the daily VWAP reset. Default 0 (UTC) — empirically "
                              "the closest match to TradingView's crypto VWAP, which anchors to the exchange "
                              "(UTC) day, NOT the chart's display timezone. Change only if your reference "
                              "platform anchors VWAP elsewhere."),
        ParamSpec("rsi_long_below", ParamType.FLOAT, 35.0, min=5.0, max=50.0, step=1.0, group="Bands",
                  description="Long only when RSI < this (oversold). Pine 35."),
        ParamSpec("rsi_short_above", ParamType.FLOAT, 65.0, min=50.0, max=95.0, step=1.0, group="Bands",
                  description="Short only when RSI > this (overbought). Pine 65."),

        # --- Exit / stop (one SHARED dynamic stop for the whole stacked position)
        ParamSpec("atr_mult", ParamType.FLOAT, 6.0, min=0.2, max=20.0, step=0.5, group="Exit",
                  description="Stop distance in ATRs for the SHARED dynamic stop: close ∓ this·ATR, repositioned "
                              "every bar and applied to the entire stacked position (matches the Pine). "
                              "Take-profit is reversion back to the VWAP. Pine slATR 6."),

        # --- Direction
        ParamSpec("enable_long", ParamType.BOOL, True, group="Direction",
                  description="Allow long entries (Pine enableLong true)."),
        ParamSpec("enable_short", ParamType.BOOL, False, group="Direction",
                  description="Allow short entries (Pine enableShort false)."),

        # --- Sessions (Pine trade247 + four named sessions, entries only)
        ParamSpec("trade_24_7", ParamType.BOOL, True, group="Sessions",
                  description="Trade any time of day; the session windows below are ignored (Pine trade247 true)."),
        ParamSpec("sessions", ParamType.SESSIONS,
                  {
                    "tokyo":  {"enabled": False, "start": "20:00", "end": "00:00"},
                    "london": {"enabled": False, "start": "01:00", "end": "08:30"},
                    "ny_am":  {"enabled": False, "start": "08:30", "end": "12:00"},
                    "ny_pm":  {"enabled": False, "start": "13:00", "end": "16:00"},
                  },
                  group="Sessions",
                  description="UTC session windows where new entries are allowed when 24/7 is off. Defaults "
                              "match the Pine's Tokyo / London / NY-morning / NY-afternoon windows (all off). "
                              "Exits always fire regardless of session."),

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

        # --- Risk / sizing
        ParamSpec("pyramiding", ParamType.INT, 10, min=1, max=20, step=1, group="Risk",
                  description="Max concurrent stacked entries per side (Pine pyramiding 10). Each tranche sized at Risk%. "
                              "Set to 1 to hold a single position."),
        ParamSpec("risk_pct", ParamType.FLOAT, 10.0, min=0.1, max=100.0, step=0.5, group="Risk",
                  description="% of equity per entry on crypto/spot (Pine default_qty_value 10)."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Contracts per trade if run on a contract-sized future (inert on crypto)."),
    ]

    META = StrategyMeta(
        id="vwap_deviation",
        name="VWAP Deviation Reversion (QUANT)",
        description=("VWAP mean reversion with a trend filter. Buys oversold dips below the lower "
                     "VWAP±ATR band while above the trend EMA (shorts the mirror, off by default), "
                     "taking profit on reversion back to the live VWAP. Stacks up to `pyramiding` "
                     "entries, each with its own ATR stop. Optional z-score / regime / volume / "
                     "session filters (off by default). Ported to match a TradingView VWAP "
                     "Deviation strategy."),
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
        high  = out["high"].astype(float).to_numpy()
        low   = out["low"].astype(float).to_numpy()
        close = out["close"].astype(float).to_numpy()
        time  = out["time"].astype(np.int64).to_numpy()
        vol   = (out["volume"].astype(float).to_numpy()
                 if "volume" in out.columns else np.ones(len(out)))
        n = len(out)

        dev_mult = float(p["deviation_atr"]); atr_len = int(p["atr_length"])
        rsi_len  = int(p["rsi_length"]);      ema_len = int(p["trend_ema"])
        atr_mult = float(p["atr_mult"])
        rsi_long = float(p["rsi_long_below"]); rsi_short = float(p["rsi_short_above"])
        long_on  = bool(p["enable_long"]);     short_on = bool(p["enable_short"])
        use_z    = bool(p["use_zscore"]); z_len = int(p["zscore_length"]); z_th = float(p["zscore_threshold"])
        use_reg  = bool(p["use_regime"]); reg_len = int(p["atr_regime_length"])
        use_volf = bool(p["use_volume"]); vol_len = int(p["volume_length"]); vol_mult = float(p["volume_mult"])

        vwap_off = int(p["vwap_anchor_offset_h"]) * 3600
        vwap = _session_vwap(time, close, vol, vwap_off)
        atr  = _atr(high, low, close, atr_len)
        rsi  = _rsi(close, rsi_len)
        ema  = _ema(close, ema_len)
        upper = vwap + atr * dev_mult
        lower = vwap - atr * dev_mult

        # Session gate (entries only). 24/7 -> always allowed.
        if bool(p.get("trade_24_7", True)):
            in_session = np.ones(n, dtype=bool)
        else:
            ts = pd.to_datetime(out["time"], unit="s", utc=True)
            ts.index = out.index
            in_session = session_mask(ts, p["sessions"]).to_numpy()

        # Optional filters as per-bar boolean arrays (True = pass / not used).
        if use_z:
            dev = close - vwap
            std = pd.Series(dev).rolling(z_len).std(ddof=0).to_numpy()   # ta.stdev = population
            zsc = np.divide(dev, std, out=np.full(n, np.nan), where=std > 0)
            z_long_ok  = np.isfinite(zsc) & (zsc < -z_th)
            z_short_ok = np.isfinite(zsc) & (zsc >  z_th)
        else:
            z_long_ok = z_short_ok = np.ones(n, dtype=bool)

        if use_reg:
            atr_ma = pd.Series(atr).rolling(reg_len).mean().to_numpy()
            reg_ok = np.isfinite(atr_ma) & (atr < atr_ma)
        else:
            reg_ok = np.ones(n, dtype=bool)

        if use_volf:
            vol_ma = pd.Series(vol).rolling(vol_len).mean().to_numpy()
            vol_ok = np.isfinite(vol_ma) & (vol > vol_ma * vol_mult)
        else:
            vol_ok = np.ones(n, dtype=bool)

        valid = np.isfinite(atr) & np.isfinite(rsi) & np.isfinite(ema) & np.isfinite(vwap)
        gates = in_session & reg_ok & vol_ok & valid

        # SHARED dynamic stop (matches the Pine): one stop for the WHOLE stacked
        # position, repositioned each bar at close ∓ atr_mult·ATR — NOT a per-entry
        # stop. We fold it into bar_exit so the engine closes ALL open tranches at
        # once (and we deliberately DON'T emit an `atr` column, which would switch
        # on the engine's per-tranche fixed stop instead). Stop level uses the
        # PRIOR bar (causal); exit is close-based, engine fills at next open.
        prev_close = pd.Series(close).shift(1).to_numpy()
        prev_atr   = pd.Series(atr).shift(1).to_numpy()

        # Raw per-bar entry conditions (NOT position-gated → engine stacks tranches).
        with np.errstate(invalid="ignore"):
            cond_long  = gates & z_long_ok  & (close < lower) & (rsi < rsi_long)  & (close > ema)
            cond_short = gates & z_short_ok & (close > upper) & (rsi > rsi_short) & (close < ema)
            long_stop  = prev_close - atr_mult * prev_atr
            short_stop = prev_close + atr_mult * prev_atr
            # Exit the whole stack: reversion back to VWAP OR the shared ATR stop.
            bar_exit_long  = valid & ((close >= vwap) | (close <= long_stop))
            bar_exit_short = valid & ((close <= vwap) | (close >= short_stop))
        if not long_on:
            cond_long = np.zeros(n, dtype=bool)
        if not short_on:
            cond_short = np.zeros(n, dtype=bool)

        out["cond_long"]      = cond_long
        out["cond_short"]     = cond_short
        out["bar_exit_long"]  = bar_exit_long
        out["bar_exit_short"] = bar_exit_short
        out["entry_long"]     = cond_long
        out["entry_short"]    = cond_short
        out["exit_long"]      = bar_exit_long
        out["exit_short"]     = bar_exit_short
        out["stop_price"]     = np.full(n, np.nan)
        out["vwap"]      = vwap
        out["upper_dev"] = upper
        out["lower_dev"] = lower
        out["ema_trend"] = ema
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict):
        """Live path with TradingView-style pyramiding. Returns a LIST of signals:
        a BUY/SELL per added tranche (up to `pyramiding`), and a single
        EXIT_LONG/EXIT_SHORT that closes the WHOLE stack when price reverts to the
        VWAP or hits the shared dynamic ATR stop. Exits ignore the session gate.

        State: `pos` (0/1/-1 = stack direction) and `count` (open tranche count).
        The shared stop is position-independent (close ∓ atr_mult·ATR from the
        prior bar), so we only need the count, not per-tranche entry prices."""
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        atr_len = int(p["atr_length"]); rsi_len = int(p["rsi_length"]); ema_len = int(p["trend_ema"])
        atr_mult = float(p["atr_mult"]); dev_mult = float(p["deviation_atr"])
        rsi_long = float(p["rsi_long_below"]); rsi_short = float(p["rsi_short_above"])
        long_on = bool(p["enable_long"]); short_on = bool(p["enable_short"])
        use_z = bool(p["use_zscore"]); z_len = int(p["zscore_length"]); z_th = float(p["zscore_threshold"])
        use_reg = bool(p["use_regime"]); reg_len = int(p["atr_regime_length"])
        use_volf = bool(p["use_volume"]); vol_len = int(p["volume_length"]); vol_mult = float(p["volume_mult"])
        max_tranches = max(1, int(p["pyramiding"]))

        t = int(candle["time"]); h = float(candle["high"]); l = float(candle["low"])
        c = float(candle["close"]); v = float(candle.get("volume", 0.0) or 0.0)

        buf = state.setdefault("buf", [])
        buf.append({"high": h, "low": l, "close": c, "volume": v})
        keep = max(ema_len, atr_len, rsi_len, z_len, reg_len, vol_len) * 3 + 60
        if len(buf) > keep:
            del buf[: len(buf) - keep]

        # Day-anchored VWAP accumulated in state (offset = chart-tz reset).
        day = (t + int(p["vwap_anchor_offset_h"]) * 3600) // _DAY
        if state.get("vwap_day") != day:
            state["vwap_day"] = day; state["vwap_pv"] = 0.0; state["vwap_vol"] = 0.0
        state["vwap_pv"] += c * v; state["vwap_vol"] += v
        vwap_now = (state["vwap_pv"] / state["vwap_vol"]) if state["vwap_vol"] > 0 else c

        n = len(buf)
        if n < max(atr_len, rsi_len, ema_len) + 2:
            return None

        highs = np.array([b["high"] for b in buf]); lows = np.array([b["low"] for b in buf])
        closes = np.array([b["close"] for b in buf]); vols = np.array([b["volume"] for b in buf])
        atr = _atr(highs, lows, closes, atr_len); rsi = _rsi(closes, rsi_len); ema = _ema(closes, ema_len)
        i = n - 1
        if not (np.isfinite(atr[i]) and np.isfinite(rsi[i]) and np.isfinite(ema[i])):
            return None

        upper = vwap_now + atr[i] * dev_mult; lower = vwap_now - atr[i] * dev_mult
        pos = int(state.get("pos", 0))
        count = int(state.get("count", 0))
        sigs: list[Signal] = []

        # Shared dynamic stop from the PRIOR bar (causal), for the whole stack.
        prev_close = float(closes[i - 1]); prev_atr = float(atr[i - 1])
        long_stop  = prev_close - atr_mult * prev_atr if np.isfinite(prev_atr) else -np.inf
        short_stop = prev_close + atr_mult * prev_atr if np.isfinite(prev_atr) else np.inf

        # ---- EXIT the whole stack (fires regardless of session) ----
        exited = False
        if pos == 1 and count > 0:
            if c >= vwap_now or c <= long_stop:
                sigs.append(Signal("long", "exit", c, t, "vwap_target" if c >= vwap_now else "atr_stop"))
                state["pos"] = 0; state["count"] = 0; pos = 0; count = 0; exited = True
        elif pos == -1 and count > 0:
            if c <= vwap_now or c >= short_stop:
                sigs.append(Signal("short", "exit", c, t, "vwap_target" if c <= vwap_now else "atr_stop"))
                state["pos"] = 0; state["count"] = 0; pos = 0; count = 0; exited = True

        # ---- ENTRY / ADD: one tranche per bar, up to `pyramiding` (gated) ----
        if not exited and count < max_tranches:
            ok = True
            if not bool(p.get("trade_24_7", True)):
                utc = datetime.fromtimestamp(t, tz=timezone.utc).time()
                in_sess = False
                for cfg in (p.get("sessions") or {}).values():
                    if cfg and cfg.get("enabled"):
                        win = (parse_hhmm(cfg.get("start", "00:00")), parse_hhmm(cfg.get("end", "00:00")))
                        if in_window_live(utc, win):
                            in_sess = True; break
                ok = in_sess
            if ok and use_reg:
                am = float(pd.Series(atr).rolling(reg_len).mean().to_numpy()[i]) if n >= reg_len else np.nan
                ok = bool(np.isfinite(am) and atr[i] < am)
            if ok and use_volf:
                vm = float(pd.Series(vols).rolling(vol_len).mean().to_numpy()[i]) if n >= vol_len else np.nan
                ok = bool(np.isfinite(vm) and vols[i] > vm * vol_mult)
            z_ok_long = z_ok_short = True
            if ok and use_z:
                if n >= z_len:
                    dev = closes - vwap_now
                    std = float(pd.Series(dev).rolling(z_len).std(ddof=0).to_numpy()[i])
                    zz = (dev[i] / std) if std > 0 else np.nan
                    z_ok_long = bool(np.isfinite(zz) and zz < -z_th)
                    z_ok_short = bool(np.isfinite(zz) and zz > z_th)
                else:
                    z_ok_long = z_ok_short = False
            if ok:
                long_ok  = long_on  and pos != -1 and c < lower and rsi[i] < rsi_long  and c > ema[i] and z_ok_long
                short_ok = short_on and pos != 1  and c > upper and rsi[i] > rsi_short and c < ema[i] and z_ok_short
                if long_ok:
                    state["pos"] = 1; state["count"] = count + 1
                    sigs.append(Signal("long", "entry", c, t, "vwap_dev"))
                elif short_ok:
                    state["pos"] = -1; state["count"] = count + 1
                    sigs.append(Signal("short", "entry", c, t, "vwap_dev"))

        return sigs or None
