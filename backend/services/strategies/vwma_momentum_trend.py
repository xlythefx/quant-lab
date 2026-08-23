"""
VWMA Momentum (Trend) — a longer-timeframe (1h/4h) trend-following cousin of
vwma_momentum, built from the time-series-momentum research rather than just
re-tuned numbers.

What's different from vwma_momentum (and WHY):
  1. Slower core. Defaults are tuned in WALL-CLOCK terms for 1h — VWMA(120) ≈ 5
     days — because parameters are measured in bars, so the same number is a
     different strategy on each timeframe. This targets multi-day trends, the
     horizon the momentum literature actually documents.
  2. Sustained-break confirmation (`confirm_bars`). Require price to hold beyond
     the VWMA for a few bars, not a one-bar poke. Practical analog of the research
     "skip a period" rule (avoid the short-term reversal right at the cross).
  3. Volatility-targeted sizing (Barroso & Santa-Clara 2015, "Momentum has its
     moments"). Size each bar by target_ATR% / current_ATR%, clamped — smaller
     when volatile, bigger when calm, to hold roughly constant risk. Historically
     raises Sharpe AND cuts the rare momentum crashes (Daniel & Moskowitz 2016).
     Uses the engine's opt-in `risk_scale` column (same hook as vwma_reversion_pro).
  4. Optional slow-trend regime filter (only trade with a slow EMA). Default OFF —
     filters earn their place through the gauntlet, they are not bolted on by faith.

Long-only by default (crypto short-side pitfalls); shorts implementable via `sides`.
Exit is the honest VWMA cross (close-based, feed-robust). Self-contained indicators.

Engine contract: cond_long/cond_short (raw per-bar entries), bar_exit_long/short
(per-bar VWMA-cross exits), risk_scale (per-bar size multiplier). The engine owns
position state; this file emits stateless per-bar columns + display markers.

Research: Moskowitz, Ooi & Pedersen (2012) Time-Series Momentum; Hurst, Ooi &
Pedersen (AQR) A Century of Evidence on Trend-Following; Barroso & Santa-Clara
(2015); Daniel & Moskowitz (2016). Crypto intraday momentum is a weaker, more
crowded claim than the monthly cross-asset canon — expect a modest edge and lean
on vol-targeting + honest costs.
"""
from __future__ import annotations

from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)


# ---------------------------------------------------------------------------
# Self-contained indicators
# ---------------------------------------------------------------------------

def _vwma(close: pd.Series, volume: pd.Series, length: int) -> pd.Series:
    pv = (close * volume).rolling(length).sum()
    vsum = volume.rolling(length).sum().replace(0, np.nan)
    return pv / vsum


def _rsi(close: pd.Series, length: int) -> pd.Series:
    diff = close.diff()
    up = diff.clip(lower=0)
    down = -diff.clip(upper=0)
    avg_up = up.ewm(alpha=1 / length, adjust=False).mean()
    avg_down = down.ewm(alpha=1 / length, adjust=False).mean()
    rs = avg_up / avg_down.replace(0, np.nan)
    return 100 - (100 / (1 + rs))


def _atr(high: pd.Series, low: pd.Series, close: pd.Series, length: int) -> pd.Series:
    prev_close = close.shift(1)
    tr = pd.concat([
        (high - low).abs(),
        (high - prev_close).abs(),
        (low - prev_close).abs(),
    ], axis=1).max(axis=1)
    return tr.ewm(alpha=1 / length, adjust=False).mean()


class VwmaMomentumTrendStrategy(Strategy):
    PARAM_SCHEMA = [
        # ---- Trend core (defaults in wall-clock terms for 1h) ----
        ParamSpec("vwma_length", ParamType.INT, 120, min=20, max=400, step=1, group="Trend",
                  description="VWMA lookback. 120 ≈ 5 days on 1h. Bigger = slower, longer trends."),
        ParamSpec("confirm_bars", ParamType.INT, 1, min=0, max=10, step=1, group="Trend",
                  description="Require price to hold beyond the VWMA for this many extra bars "
                              "before entering (a sustained break, not a one-bar poke). 0 = off."),
        # ---- Optional slow-trend regime filter (default OFF) ----
        ParamSpec("use_trend_filter", ParamType.BOOL, False, group="Trend Filter",
                  description="Only trade WITH a slow EMA (long above it, short below)."),
        ParamSpec("trend_ema_length", ParamType.INT, 200, min=50, max=600, step=1, group="Trend Filter"),
        # ---- RSI gate (default OFF — earn its place) ----
        ParamSpec("use_rsi_filter", ParamType.BOOL, False, group="RSI"),
        ParamSpec("rsi_length", ParamType.INT, 21, min=5, max=60, step=1, group="RSI"),
        ParamSpec("rsi_long_min", ParamType.INT, 50, min=10, max=80, step=1, group="RSI",
                  description="Long requires RSI above this (shorts require RSI below 100-this)."),
        # ---- Volume gate (default OFF) ----
        ParamSpec("use_volume_filter", ParamType.BOOL, False, group="Volume"),
        ParamSpec("vol_length", ParamType.INT, 48, min=5, max=300, step=1, group="Volume"),
        ParamSpec("vol_mult", ParamType.FLOAT, 1.2, min=0.5, max=5.0, step=0.05, group="Volume"),
        # ---- Volatility-targeted sizing (the research edge, default ON) ----
        ParamSpec("use_vol_target", ParamType.BOOL, True, group="Vol Targeting",
                  description="Scale each entry by target_ATR% / current_ATR% (clamped) — "
                              "smaller when volatile, bigger when calm. Barroso & Santa-Clara."),
        ParamSpec("atr_length", ParamType.INT, 14, min=5, max=100, step=1, group="Vol Targeting"),
        ParamSpec("vol_target_pct", ParamType.FLOAT, 1.0, min=0.1, max=10.0, step=0.1, group="Vol Targeting",
                  description="Target per-bar ATR as % of price. Position size aims to keep this constant."),
        ParamSpec("vol_scale_min", ParamType.FLOAT, 0.25, min=0.05, max=1.0, step=0.05, group="Vol Targeting"),
        ParamSpec("vol_scale_max", ParamType.FLOAT, 3.0, min=1.0, max=10.0, step=0.5, group="Vol Targeting"),
        # ---- Direction (default LONG only) ----
        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": False}, group="Direction"),
        # ---- Sizing ----
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Crypto/spot base sizing: notional = equity × risk_pct × vol_scale ÷ price."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures sizing: contracts (risk_pct inert on futures)."),
        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=20, step=1, group="Risk"),
    ]

    META = StrategyMeta(
        id="vwma_momentum_trend",
        name="VWMA Momentum (Trend)",
        description=("Longer-timeframe (1h/4h) trend-following VWMA momentum with "
                     "volatility-targeted sizing (Barroso & Santa-Clara), sustained-break "
                     "confirmation, and an optional slow-trend filter. Long-only default. "
                     "Exit on the VWMA cross."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("vwma", "VWMA", from_column="vwma", color="#fbbf24", line_width=2),
        OverlaySpec("trend_ema", "Trend EMA", from_column="trend_ema_disp",
                    color="rgba(148,163,184,0.7)", line_width=1, line_style="dashed"),
    ]

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        n = len(out)
        close = out["close"].astype(float)
        high = out["high"].astype(float)
        low = out["low"].astype(float)
        vol = out["volume"].astype(float) if "volume" in out.columns else pd.Series(1.0, index=out.index)

        vwma = _vwma(close, vol, int(p["vwma_length"]))
        slope = vwma - vwma.shift(1)
        atr = _atr(high, low, close, int(p["atr_length"]))

        # Filters (each a pass-through when its toggle is off).
        if bool(p["use_trend_filter"]):
            trend_ema = close.ewm(span=int(p["trend_ema_length"]), adjust=False).mean()
            trend_ok_long = close > trend_ema
            trend_ok_short = close < trend_ema
        else:
            trend_ema = pd.Series(np.nan, index=out.index)
            trend_ok_long = pd.Series(True, index=out.index)
            trend_ok_short = pd.Series(True, index=out.index)

        if bool(p["use_rsi_filter"]):
            rsi = _rsi(close, int(p["rsi_length"]))
            rsi_ok_long = rsi > float(p["rsi_long_min"])
            rsi_ok_short = rsi < (100.0 - float(p["rsi_long_min"]))
        else:
            rsi_ok_long = pd.Series(True, index=out.index)
            rsi_ok_short = pd.Series(True, index=out.index)

        if bool(p["use_volume_filter"]):
            vol_avg = vol.rolling(int(p["vol_length"])).mean()
            vol_ok = vol > vol_avg * float(p["vol_mult"])
        else:
            vol_ok = pd.Series(True, index=out.index)

        # Sustained break: price held beyond VWMA for confirm_bars+1 bars.
        cb = int(p["confirm_bars"])
        above = (close > vwma)
        below = (close < vwma)
        if cb > 0:
            sustained_above = above.rolling(cb + 1).sum().eq(cb + 1)
            sustained_below = below.rolling(cb + 1).sum().eq(cb + 1)
        else:
            sustained_above = above
            sustained_below = below

        sides = p["sides"]
        long_on = bool(sides.get("long"))
        short_on = bool(sides.get("short"))

        long_cond = (sustained_above & (slope > 0) & trend_ok_long & rsi_ok_long & vol_ok) if long_on \
            else pd.Series(False, index=out.index)
        short_cond = (sustained_below & (slope < 0) & trend_ok_short & rsi_ok_short & vol_ok) if short_on \
            else pd.Series(False, index=out.index)

        # Exit on the VWMA cross against the position (close-based, feed-robust).
        exit_long_cond = (close < vwma) & (slope < 0)
        exit_short_cond = (close > vwma) & (slope > 0)

        # Volatility-targeted size multiplier (per bar) — the research edge.
        if bool(p["use_vol_target"]):
            atr_pct = (atr / close.replace(0, np.nan)) * 100.0
            scale = float(p["vol_target_pct"]) / atr_pct.replace(0, np.nan)
            scale = scale.clip(lower=float(p["vol_scale_min"]), upper=float(p["vol_scale_max"])).fillna(1.0)
            risk_scale = scale.to_numpy()
        else:
            risk_scale = np.ones(n)

        # ---- Display-only sim: entry/exit markers for the chart. Single-position;
        # the real P&L comes from the engine reading cond_/bar_exit_/risk_scale.
        lc = long_cond.fillna(False).to_numpy()
        sc = short_cond.fillna(False).to_numpy()
        xl = exit_long_cond.fillna(False).to_numpy()
        xs = exit_short_cond.fillna(False).to_numpy()
        entry_long = np.zeros(n, dtype=bool)
        entry_short = np.zeros(n, dtype=bool)
        exit_long = np.zeros(n, dtype=bool)
        exit_short = np.zeros(n, dtype=bool)
        pos = 0
        for t in range(1, n):
            if pos == 1 and xl[t - 1]:
                exit_long[t] = True; pos = 0
            elif pos == -1 and xs[t - 1]:
                exit_short[t] = True; pos = 0
            if pos == 0:
                if lc[t - 1]:
                    entry_long[t] = True; pos = 1
                elif sc[t - 1]:
                    entry_short[t] = True; pos = -1

        out["entry_long"] = entry_long
        out["entry_short"] = entry_short
        out["exit_long"] = exit_long
        out["exit_short"] = exit_short
        out["stop_price"] = np.full(n, np.nan)
        # Raw per-bar columns the engines consume.
        out["cond_long"] = long_cond.fillna(False).astype(bool)
        out["cond_short"] = short_cond.fillna(False).astype(bool)
        out["bar_exit_long"] = exit_long_cond.fillna(False).astype(bool)
        out["bar_exit_short"] = exit_short_cond.fillna(False).astype(bool)
        out["risk_scale"] = risk_scale
        # Overlays.
        out["vwma"] = vwma
        out["trend_ema_disp"] = trend_ema
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """Live mirror. NOTE: volatility-targeted SIZING is a backtest hook
        (risk_scale); live position size is set by the webhook receiver, so the
        live path only mirrors the ENTRY/EXIT timing here. See CLAUDE.md live-vs-
        backtest parity note (single-position; pyramiding>1 diverges)."""
        if not bool(candle.get("isClosed", False)):
            return None
        p = self.p
        need = max(int(p["vwma_length"]), int(p["atr_length"]),
                   int(p["trend_ema_length"]) if bool(p["use_trend_filter"]) else 0,
                   int(p["rsi_length"]) if bool(p["use_rsi_filter"]) else 0,
                   int(p["vol_length"]) if bool(p["use_volume_filter"]) else 0)
        warmup = need * 4
        buf = state.setdefault("buf", [])
        buf.append({
            "time": int(candle["time"]),
            "open": float(candle["open"]), "high": float(candle["high"]),
            "low": float(candle["low"]), "close": float(candle["close"]),
            "volume": float(candle.get("volume", 0.0)),
        })
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        if len(buf) < max(need + int(p["confirm_bars"]) + 2, 5):
            return None

        d = pd.DataFrame(buf)
        close = d["close"]; vol = d["volume"]
        vwma = _vwma(close, vol, int(p["vwma_length"]))
        slope = vwma - vwma.shift(1)

        c = float(close.iloc[-1]); vw = float(vwma.iloc[-1]); sl = float(slope.iloc[-1])
        if not (np.isfinite(c) and np.isfinite(vw) and np.isfinite(sl)):
            return None
        ts = int(d["time"].iloc[-1])

        # Filters.
        if bool(p["use_trend_filter"]):
            tema = float(close.ewm(span=int(p["trend_ema_length"]), adjust=False).mean().iloc[-1])
            trend_ok_long = c > tema
            trend_ok_short = c < tema
        else:
            trend_ok_long = trend_ok_short = True

        if bool(p["use_rsi_filter"]):
            rsi_v = float(_rsi(close, int(p["rsi_length"])).iloc[-1])
            rsi_ok_long = rsi_v > float(p["rsi_long_min"])
            rsi_ok_short = rsi_v < (100.0 - float(p["rsi_long_min"]))
        else:
            rsi_ok_long = rsi_ok_short = True

        if bool(p["use_volume_filter"]):
            va = float(vol.rolling(int(p["vol_length"])).mean().iloc[-1])
            vok = float(vol.iloc[-1]) > va * float(p["vol_mult"]) if np.isfinite(va) else False
        else:
            vok = True

        # Sustained break over confirm_bars+1 closes.
        cb = int(p["confirm_bars"])
        k = cb + 1
        recent_close = close.iloc[-k:]
        recent_vwma = vwma.iloc[-k:]
        sustained_above = bool((recent_close > recent_vwma).all()) if recent_vwma.notna().all() else False
        sustained_below = bool((recent_close < recent_vwma).all()) if recent_vwma.notna().all() else False

        sides = p["sides"]
        long_on = bool(sides.get("long"))
        short_on = bool(sides.get("short"))
        pos = state.get("pos", 0)

        if pos == 0:
            if long_on and sustained_above and sl > 0 and trend_ok_long and rsi_ok_long and vok:
                state["pos"] = 1
                return Signal(side="long", kind="entry", price=c, time=ts, reason="vwma_trend_up")
            if short_on and sustained_below and sl < 0 and trend_ok_short and rsi_ok_short and vok:
                state["pos"] = -1
                return Signal(side="short", kind="entry", price=c, time=ts, reason="vwma_trend_down")
            return None
        if pos == 1 and c < vw and sl < 0:
            state["pos"] = 0
            return Signal(side="long", kind="exit", price=c, time=ts, reason="vwma_cross")
        if pos == -1 and c > vw and sl > 0:
            state["pos"] = 0
            return Signal(side="short", kind="exit", price=c, time=ts, reason="vwma_cross")
        return None
