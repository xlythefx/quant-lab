"""
VWMA Reversion — z-score mean reversion around the volume-weighted moving
average, gated by RSI bands and UTC session windows. ATR stop-loss.

Self-contained: all indicator math (VWMA, RSI, ATR, z-score, sessions)
implemented with numpy/pandas in this file. No shared feature library.
"""
from __future__ import annotations

from datetime import datetime, timezone
from typing import Optional

import numpy as np
import pandas as pd

from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)
from services.strategies.regime import (
    RegimeDetector, REGIME_LABELS, _regime_labels, _regime_params,
)
from services.strategies.session_utils import parse_hhmm, in_window_live, session_mask


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
    # Wilder's smoothing
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


# ---------------------------------------------------------------------------
# Regime gating helpers
# ---------------------------------------------------------------------------

def _regime_method(p) -> str:
    """Which regime engine to gate with: 'adx' | 'five' | 'hmm'.

    Falls back to the legacy use_five_regime boolean when regime_method is absent
    (so old saved params / presets keep working)."""
    m = p.get("regime_method")
    if m in ("adx", "five", "hmm"):
        return m
    return "five" if p.get("use_five_regime") else "adx"


# Cache the (slow) causal-HMM per-bar labels so toggling allowed-moods or other
# (non-HMM) params re-uses the fit. Keyed by the price data + HMM-fit params, so a
# cache hit only happens for an identical series + identical model settings.
_HMM_LABEL_CACHE = {}
_HMM_LABEL_CACHE_MAX = 8


def _hmm_labels_for(out: pd.DataFrame, p, prog=None) -> pd.Series:
    """Per-bar causal HMM mood label for each row of `out` (Series, out.index).

    Bars before the first fit (or when there isn't enough data to fit) are
    "Warmup"; low-confidence bars are "Undecided". Both are excluded from any
    allowed-moods set, so they never take entries. Result is cached.

    `prog` (optional) is {"sid","label",...} injected by the portfolio runner; when
    present (and the labels aren't a cache hit), the slow rolling fit reports its
    per-refit progress over the socket so the dashboard can show a live bar.
    """
    import hashlib
    from services.strategies.regime_hmm import causal_hmm_labels

    close = out["close"].to_numpy(dtype=float)
    n_states = int(p.get("hmm_n_states", 5))
    ranging_ratio = float(p.get("hmm_ranging_ratio", 0.10))
    undecided_below = float(p.get("hmm_undecided_below", 0.5))
    key = (hashlib.md5(close.tobytes()).hexdigest(), n_states, ranging_ratio, undecided_below)
    cached = _HMM_LABEL_CACHE.get(key)
    if cached is not None:
        return cached  # cache hit → instant, nothing to report

    # Per-refit progress → socket (only when a sid was injected by the runner).
    on_progress = None
    if prog and prog.get("sid"):
        from services import event_bus
        sid = prog["sid"]
        label = prog.get("label", "strategy")

        def on_progress(done, total):
            event_bus.emit("backtest_progress", {
                "stage": "hmm", "label": label,
                "refit": int(done), "n_refits": int(total),
                "pct": round(100.0 * done / total, 1) if total else 0.0,
            }, to=sid)

    hmm_p = {"n_states": n_states, "ranging_ratio": ranging_ratio,
             "undecided_below": undecided_below}
    try:
        res = causal_hmm_labels(out, hmm_p, on_progress=on_progress)
        lab_by_time = dict(zip((int(t) for t in res["times"]), res["labels"]))
        labels = out["time"].map(lab_by_time).fillna("Warmup")
    except ValueError:
        # Not enough data to fit the HMM over this window → no mood info → no entries.
        labels = pd.Series("Warmup", index=out.index)
    labels.index = out.index

    if len(_HMM_LABEL_CACHE) >= _HMM_LABEL_CACHE_MAX:
        _HMM_LABEL_CACHE.pop(next(iter(_HMM_LABEL_CACHE)))
    _HMM_LABEL_CACHE[key] = labels
    return labels


def _hmm_in_regime(out: pd.DataFrame, p, prog=None) -> pd.Series:
    """Boolean Series: True where the HMM mood is in the allowed set."""
    labels = _hmm_labels_for(out, p, prog)
    allowed = [k for k, on in (p.get("allowed_hmm_moods") or {}).items() if on]
    return labels.isin(allowed)


# ---------------------------------------------------------------------------
# Strategy
# ---------------------------------------------------------------------------

class VwmaReversionStrategy(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("vwma_length",  ParamType.INT,   30,  min=5,  max=200, step=1, group="VWMA"),
        ParamSpec("z_threshold",  ParamType.FLOAT, 1.5, min=0.5, max=4.0, step=0.1, group="VWMA"),
        ParamSpec("rsi_length",   ParamType.INT,   25,  min=5,  max=50,  step=1, group="RSI"),
        ParamSpec("rsi_long_max", ParamType.INT,   35,  min=25, max=40,  step=1, group="RSI"),
        ParamSpec("rsi_short_min",ParamType.INT,   65,  min=60, max=75,  step=1, group="RSI"),
        ParamSpec("atr_stop",     ParamType.BOOL,  True, group="Stop",
                  description="Use ATR-based stop loss. Turn off to exit only on mean reversion."),
        ParamSpec("atr_length",   ParamType.INT,   10,  min=5,  max=50,  step=1, group="Stop"),
        ParamSpec("atr_mult",     ParamType.FLOAT, 6.0, min=1,  max=20,  step=0.5, group="Stop"),
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
                  description="UTC session windows where new entries are allowed. "
                              "Edit start/end per session as needed."),
        ParamSpec("sides", ParamType.SIDES,
                  {"long": True, "short": True},
                  group="Direction"),
        ParamSpec("use_regime", ParamType.BOOL, False, group="Regime",
                  description="Master switch: gate entries by market regime. Pick the method below. "
                              "Exits always fire regardless."),
        ParamSpec("regime_method", ParamType.SELECT, "adx", group="Regime",
                  options=[
                      {"value": "adx",  "label": "ADX (ranging vs trending)"},
                      {"value": "five", "label": "5-Regime classifier"},
                      {"value": "hmm",  "label": "HMM moods (backtest only, slower)"},
                  ],
                  description="Which regime engine gates entries when Use Regime is on. ADX and 5-Regime "
                              "are fast; HMM re-fits a model over the whole backtest (slower; not used live)."),
        ParamSpec("regime_adx_period",    ParamType.INT,   20,   min=5,  max=50,  step=1,   group="Regime"),
        ParamSpec("regime_adx_threshold", ParamType.FLOAT, 40.0, min=10.0, max=60.0, step=1.0, group="Regime"),
        ParamSpec("allowed_regimes", ParamType.REGIMES,
                  {"Trending Up": False, "Trending Down": False,
                   "High-Volatility": False, "Quiet": True, "Choppy-Range": True},
                  group="Regime",
                  description="5-Regime method: only allow entries while the market is in one of the "
                              "checked regimes."),
        ParamSpec("allowed_hmm_moods", ParamType.REGIMES,
                  {"Bearish Volatile": False, "Bearish Normal": True, "Ranging": True,
                   "Bullish Normal": True, "Bullish Volatile": False},
                  group="Regime",
                  description="HMM method: only allow entries while the HMM mood is one of the checked "
                              "ones. Warmup / Undecided bars never take entries."),
        ParamSpec("pyramiding", ParamType.INT, 1, min=1, max=20, step=1, group="Risk",
                  description="Max concurrent positions per side. Each tranche is sized at the strategy's Risk%. Set to 1 to disable stacking."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of current equity per trade. Notional = equity × risk_pct ÷ entry_price."),
    ]

    META = StrategyMeta(
        id="vwma_reversion",
        name="VWMA Reversion",
        description=("Z-score mean reversion around VWMA, RSI filter, ATR stop-loss, "
                     "UTC session gating. Long when oversold near band, short when overbought."),
        schema=PARAM_SCHEMA,
    )

    PRESETS = {
        "BTC 15m": {
            "vwma_length":  15,
            "z_threshold":  1.3,
            "rsi_length":   15,
            "sides":        {"long": True, "short": False},
            "use_regime":   False,
            "sessions":     {
                "tokyo":  {"enabled": False},
                "ny_pm":  {"enabled": True},
            },
        },
        "LTCUSDT": {
            "vwma_length":  23,
            "z_threshold":  1.5,
            "rsi_length":   15,
            "atr_length":   10,
            "atr_mult":     6.0,
            "sides":        {"long": True, "short": False},
            "sessions":     {
                "tokyo":  {"enabled": True},   # Asia
                "london": {"enabled": True},   # London
                "ny_am":  {"enabled": False},  # Main (off)
                "ny_pm":  {"enabled": False},
            },
        },
        "ZECUSDT": {
            "vwma_length":  17,
            "z_threshold":  1.5,
            "rsi_length":   15,
            "sides":        {"long": True, "short": False},
            "sessions":     {
                "tokyo":  {"enabled": True},   # Asia
                "london": {"enabled": True},   # London
                "ny_am":  {"enabled": True},   # Main (on)
                "ny_pm":  {"enabled": False},
            },
        },
    }

    TIMEFRAME_DEFAULTS = {
        "1m": {
            "z_threshold":   1.0,
            "rsi_long_max":  45,
            "rsi_short_min": 55,
            "trade_24_7":    True,
        },
    }

    SYMBOL_DEFAULTS = {
        "LTCUSDT": {
            "vwma_length": 23,
            "rsi_length":  15,
            "sides":       {"long": True, "short": False},
            "sessions":    {"ny_pm": {"enabled": False}},
        },
    }

    OVERLAYS = [
        OverlaySpec("vwma",  "VWMA",  from_column="vwma",       color="#fbbf24", line_width=2),
        OverlaySpec("upper", "+z·σ",  from_column="upper_band", color="rgba(34,211,238,0.55)", line_style="dashed"),
        OverlaySpec("lower", "-z·σ",  from_column="lower_band", color="rgba(34,211,238,0.55)", line_style="dashed"),
        # ATR stop level, drawn only while a trade is open (NaN when flat or when
        # atr_stop is off). The sparse line breaks between trades because
        # _build_overlays emits whitespace for the NaN gaps.
        OverlaySpec("atr_stop", "ATR stop", from_column="stop_price",
                    color="rgba(239,68,68,0.85)", line_width=1, line_style="dashed"),
    ]

    def __init__(self, params=None):
        # Migrate legacy params (use_five_regime bool) to regime_method BEFORE the
        # base merge strips unknown keys — so old saved configs/presets that only
        # have use_five_regime still pick the right method.
        params = dict(params or {})
        if "regime_method" not in params and "use_five_regime" in params:
            params["regime_method"] = "five" if params.get("use_five_regime") else "adx"
        super().__init__(params)

    # ---- vectorized (backtest) ----------------------------------------
    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        close = out["close"].astype(float)
        high = out["high"].astype(float)
        low = out["low"].astype(float)
        vol = out["volume"].astype(float) if "volume" in out.columns else pd.Series(1.0, index=out.index)

        mean = _vwma(close, vol, p["vwma_length"])
        # ddof=0 (population) — matches TradingView's ta.stdev() and is the
        # right formula when the rolling window IS the distribution, not a
        # sample of one.
        std = close.rolling(p["vwma_length"]).std(ddof=0).replace(0, 1e-9)
        zscore = (close - mean) / std
        rsi = _rsi(close, p["rsi_length"])
        atr = _atr(high, low, close, p["atr_length"])

        ts_for_mask = pd.to_datetime(out["time"], unit="s", utc=True)
        ts_for_mask.index = out.index
        if bool(p.get("trade_24_7")):
            in_session = pd.Series(True, index=out.index)
        else:
            in_session = session_mask(ts_for_mask, p["sessions"])

        sides = p["sides"]
        if sides.get("long"):
            long_cond = in_session & (zscore < -p["z_threshold"]) & (rsi < p["rsi_long_max"])
        else:
            long_cond = pd.Series(False, index=out.index)
        if sides.get("short"):
            short_cond = in_session & (zscore > p["z_threshold"]) & (rsi > p["rsi_short_min"])
        else:
            short_cond = pd.Series(False, index=out.index)

        if p.get("use_regime"):
            method = _regime_method(p)
            if method == "five":
                # 5-regime membership filter (causal labeler shared with Market Lab).
                rp = _regime_params({
                    "adx_period": p["regime_adx_period"],
                    "adx_trend_thresh": p["regime_adx_threshold"],
                })
                labels = _regime_labels(out, rp)
                allowed = [k for k, on in (p.get("allowed_regimes") or {}).items() if on]
                in_regime = pd.Series(np.isin(labels, allowed), index=out.index)
            elif method == "hmm":
                # Data-driven HMM moods (causal; slower — re-fits over the window).
                # self._progress (set by the portfolio runner) carries the sid for
                # live per-refit progress; absent in plain/standalone runs.
                in_regime = _hmm_in_regime(out, p, getattr(self, "_progress", None))
            else:
                # Binary ADX ranging filter (original behavior).
                in_regime = RegimeDetector(p["regime_adx_period"], p["regime_adx_threshold"]).detect(out)
            long_cond  = long_cond  & in_regime
            short_cond = short_cond & in_regime

        # Walk forward to compute entries / exits respecting position state.
        n = len(out)
        entry_long = np.zeros(n, dtype=bool)
        entry_short = np.zeros(n, dtype=bool)
        exit_long = np.zeros(n, dtype=bool)
        exit_short = np.zeros(n, dtype=bool)
        stop_price = np.full(n, np.nan)

        mean_a = mean.to_numpy()
        close_a = close.to_numpy()
        atr_a = atr.to_numpy()
        ins = in_session.to_numpy()
        lc = long_cond.to_numpy()
        sc = short_cond.to_numpy()

        pos = 0           # 0 flat, 1 long, -1 short
        entry_p = np.nan
        atr_at_entry = np.nan
        cur_stop = np.nan          # active position's ATR stop level (for the overlay line)
        # Display gate: only paint the stop line when the ATR stop is enabled, so
        # the line vanishes from the chart when atr_stop is turned off. NOTE: this
        # gates only the drawn line, not the exit logic below — kept separate so
        # backtest behaviour is unchanged. At pyramiding=1 (default) the line
        # tracks the real trade; with pyramiding>1 it reflects the base position.
        atr_on = bool(p.get("atr_stop", True))

        for t in range(n):
            m = mean_a[t]
            c = close_a[t]
            if not np.isfinite(m):
                continue

            if pos == 0:
                if ins[t]:
                    if lc[t]:
                        pos = 1
                        entry_p = c
                        atr_at_entry = atr_a[t] if np.isfinite(atr_a[t]) else np.nan
                        entry_long[t] = True
                        if np.isfinite(atr_at_entry):
                            cur_stop = entry_p - p["atr_mult"] * atr_at_entry
                            if atr_on:
                                stop_price[t] = cur_stop
                    elif sc[t]:
                        pos = -1
                        entry_p = c
                        atr_at_entry = atr_a[t] if np.isfinite(atr_a[t]) else np.nan
                        entry_short[t] = True
                        if np.isfinite(atr_at_entry):
                            cur_stop = entry_p + p["atr_mult"] * atr_at_entry
                            if atr_on:
                                stop_price[t] = cur_stop
            elif pos == 1:
                stop_hit = (np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                            and c <= entry_p - p["atr_mult"] * atr_at_entry)
                if atr_on and np.isfinite(cur_stop):
                    stop_price[t] = cur_stop   # keep the line visible through the trade
                if c >= m or stop_hit:
                    exit_long[t] = True
                    pos = 0
                    entry_p = np.nan
                    atr_at_entry = np.nan
                    cur_stop = np.nan
            else:  # pos == -1
                stop_hit = (np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                            and c >= entry_p + p["atr_mult"] * atr_at_entry)
                if atr_on and np.isfinite(cur_stop):
                    stop_price[t] = cur_stop   # keep the line visible through the trade
                if c <= m or stop_hit:
                    exit_short[t] = True
                    pos = 0
                    entry_p = np.nan
                    atr_at_entry = np.nan
                    cur_stop = np.nan

        out["entry_long"] = entry_long
        out["entry_short"] = entry_short
        out["exit_long"] = exit_long
        out["exit_short"] = exit_short
        out["stop_price"] = stop_price
        # Raw per-bar conditions for the engine's pyramiding/MTM path.
        # cond_*: bar-level entry condition independent of position state.
        # bar_exit_*: bar-level mean-revert exit (price crossed back through VWMA).
        # atr: per-bar ATR for per-tranche stop calculation in the engine.
        out["cond_long"]      = long_cond.fillna(False).astype(bool)
        out["cond_short"]     = short_cond.fillna(False).astype(bool)
        out["bar_exit_long"]  = (close >= mean).fillna(False).astype(bool)
        out["bar_exit_short"] = (close <= mean).fillna(False).astype(bool)
        # Emit atr only when the stop is enabled. The engine gates ATR-stop
        # logic on "atr" column presence, so omitting it cleanly disables it.
        if bool(p.get("atr_stop", True)):
            out["atr"] = atr
        # Overlay columns referenced by OVERLAYS:
        out["vwma"] = mean
        out["upper_band"] = mean + std * p["z_threshold"]
        out["lower_band"] = mean - std * p["z_threshold"]
        return out

    # ---- on_candle (live) ---------------------------------------------
    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        """
        State keys we maintain:
          buf:        list of recent {time,o,h,l,c,v} dicts (len <= warmup)
          pos:        0 / 1 / -1
          entry_p:    float
          atr_at_entry: float

        NOTE: Single-position only. The backtest engine supports pyramiding
        (see backtest_engine.py — tranches list), but this live path holds
        at most one position at a time. If you trade live with pyramiding>1
        in risk_config, live behavior will NOT match the backtest equity
        curve. Extend `state` to a tranches list to align them.
        """
        if not bool(candle.get("isClosed", False)):
            return None  # only act on closed bars

        p = self.p
        warmup = max(p["vwma_length"], p["rsi_length"], p["atr_length"]) * 4
        # The 5-regime labeler needs enough trailing history for its volatility
        # lookback, or the live label won't match the backtest label.
        if p.get("use_regime") and _regime_method(p) == "five":
            rp_live = _regime_params({
                "adx_period": p["regime_adx_period"],
                "adx_trend_thresh": p["regime_adx_threshold"],
            })
            warmup = max(warmup, int(rp_live["vol_lookback"]) + int(rp_live["vol_window"]))
        buf = state.setdefault("buf", [])
        buf.append({
            "time": int(candle["time"]),
            "open": float(candle["open"]),
            "high": float(candle["high"]),
            "low": float(candle["low"]),
            "close": float(candle["close"]),
            "volume": float(candle.get("volume", 0.0)),
        })
        # keep only what we need
        if len(buf) > warmup * 2:
            del buf[: len(buf) - warmup * 2]
        if len(buf) < warmup:
            return None  # not enough data yet

        df = pd.DataFrame(buf)
        close = df["close"]
        high = df["high"]
        low = df["low"]
        vol = df["volume"]

        mean = _vwma(close, vol, p["vwma_length"])
        # ddof=0 (population) — matches TradingView's ta.stdev() and is the
        # right formula when the rolling window IS the distribution, not a
        # sample of one.
        std = close.rolling(p["vwma_length"]).std(ddof=0).replace(0, 1e-9)
        zscore = (close - mean) / std
        rsi = _rsi(close, p["rsi_length"])
        atr = _atr(high, low, close, p["atr_length"])

        m = float(mean.iloc[-1]) if np.isfinite(mean.iloc[-1]) else np.nan
        if not np.isfinite(m):
            return None
        c = float(close.iloc[-1])
        z = float(zscore.iloc[-1])
        r = float(rsi.iloc[-1])
        a = float(atr.iloc[-1]) if np.isfinite(atr.iloc[-1]) else np.nan
        ts = int(df["time"].iloc[-1])

        # session gate
        if bool(p.get("trade_24_7")):
            in_sess = True
        else:
            utc = datetime.fromtimestamp(ts, tz=timezone.utc).time()
            in_sess = False
            for cfg in (p["sessions"] or {}).values():
                if not cfg or not cfg.get("enabled"):
                    continue
                win = (parse_hhmm(cfg.get("start", "00:00")), parse_hhmm(cfg.get("end", "00:00")))
                if in_window_live(utc, win):
                    in_sess = True
                    break

        pos = state.get("pos", 0)
        entry_p = state.get("entry_p", np.nan)
        atr_at_entry = state.get("atr_at_entry", np.nan)
        sides = p["sides"]

        if p.get("use_regime") and pos == 0:
            method = _regime_method(p)
            if method == "five":
                rp = _regime_params({
                    "adx_period": p["regime_adx_period"],
                    "adx_trend_thresh": p["regime_adx_threshold"],
                })
                last_label = _regime_labels(df, rp)[-1]
                allowed = [k for k, on in (p.get("allowed_regimes") or {}).items() if on]
                if last_label not in allowed:
                    return None  # current regime not allowed — block new entries; exits still fire
            elif method == "hmm":
                # HMM gating is backtest-only — re-fitting a rolling HMM on every
                # closed bar live is impractical. So live does NOT gate on HMM
                # (entries pass through); live will diverge from an HMM-gated
                # backtest. Use ADX/5-Regime for live regime gating.
                pass
            else:
                rd = RegimeDetector(p["regime_adx_period"], p["regime_adx_threshold"])
                if rd.last_adx(df) >= p["regime_adx_threshold"]:
                    return None  # trending — block new entries; exits still fire below

        if pos == 0:
            if not in_sess:
                return None
            if sides.get("long") and z < -p["z_threshold"] and r < p["rsi_long_max"]:
                state["pos"] = 1
                state["entry_p"] = c
                state["atr_at_entry"] = a
                return Signal(side="long", kind="entry", price=c, time=ts, reason="z_long")
            if sides.get("short") and z > p["z_threshold"] and r > p["rsi_short_min"]:
                state["pos"] = -1
                state["entry_p"] = c
                state["atr_at_entry"] = a
                return Signal(side="short", kind="entry", price=c, time=ts, reason="z_short")
            return None

        atr_on = bool(p.get("atr_stop", True))
        if pos == 1:
            stop_hit = (atr_on and np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                        and c <= entry_p - p["atr_mult"] * atr_at_entry)
            if c >= m or stop_hit:
                state["pos"] = 0
                state["entry_p"] = np.nan
                state["atr_at_entry"] = np.nan
                return Signal(side="long", kind="exit", price=c, time=ts,
                              reason="atr_stop" if stop_hit else "z_revert")
            return None

        # pos == -1
        stop_hit = (atr_on and np.isfinite(atr_at_entry) and np.isfinite(entry_p)
                    and c >= entry_p + p["atr_mult"] * atr_at_entry)
        if c <= m or stop_hit:
            state["pos"] = 0
            state["entry_p"] = np.nan
            state["atr_at_entry"] = np.nan
            return Signal(side="short", kind="exit", price=c, time=ts,
                          reason="atr_stop" if stop_hit else "z_revert")
        return None
