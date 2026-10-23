"""
ANN Strategy v2 (Original) — faithful port of the TradingView "ANN Strategy v2" (Pine v2).

Plain-English rule set:

  x   = (this bar's ohlc4 − previous anchor period's ohlc4) / previous period's ohlc4
        anchor = 1D by default → "how far is price from yesterday's average price"
  out = a fixed, pre-trained 1 → 5 → 33 → 1 tanh network of x (no biases)
  out > 0 → long, out < 0 → short, out == 0 → keep the last side.

  Always in the market: every change of side is a flip (close + open the other way).

What the network really is: with no biases every layer is an odd function, so out(0) = 0
and sign(out) == sign(x) for any |x| below ~18.13%. Past that it turns around (a +30% day
reads as SHORT). In practice: long above yesterday's average, short below — except on
extreme days. Kept exactly as-is here so the port matches the Pine bar for bar; the
cleaned-up version is ann_strategy_v2_plus.py.

Faithfulness notes:
  - security(tickerid, '1D', ohlc4[1]) in Pine v2 (lookahead on) = the last COMPLETED
    daily bar, so no look-ahead. Here it is rebuilt from the chart bars on UTC period
    boundaries (Binance / TradingView crypto daily candles are UTC).
  - The Pine `threshold` input is declared but never used, so it is left out.
  - The first period in the data is usually partial, so it is never used as an anchor
    (the live warm-up drops it the same way).
  - Fill model = QuantLab honest mode (Pine process_orders_on_close = false):
    signal on the bar's close, fill at the next bar's open.
  - TradingView's default is 1 unit and 0 commission; here size is risk_pct of equity
    and fees come from the global Risk Settings.
"""
from __future__ import annotations

from typing import Optional, Union

import numpy as np
import pandas as pd

from .base import Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec


_ANCHORS = [
    {"value": "240", "label": "4 hours"},
    {"value": "1D",  "label": "1 day"},
    {"value": "1W",  "label": "1 week"},
]

# (length, offset) in seconds. Weeks start Monday 00:00 UTC (epoch 0 was a Thursday).
_PERIOD = {"240": (14_400, 0), "1D": (86_400, 0), "1W": (604_800, 345_600)}

# ---- the Pine network's weights, in Pine order ------------------------
_W1 = np.array([0.8446488687, -0.5674069006, 0.8676766445, 0.5200611473, -0.2215499554])

_W2 = np.array([   # row i = l2_i, columns = l1_0 .. l1_4
    [0.3341657935, -2.0060003664, 0.8606354375, 0.9184846912, -0.8531172267],
    [-0.0394076437, -0.4720374911, 0.2900968524, 1.0653326022, 0.3000188806],
    [-0.559307785, -0.9353655177, 1.2133832962, 0.1952686024, 0.8552068166],
    [-0.4293220754, 0.8484259409, -0.7154087313, 0.1102971055, 0.2279392724],
    [0.9111779155, 0.2801691115, 0.0039982713, -0.5648257117, 0.3281705155],
    [-0.2963954503, 0.4046532178, 0.2460580977, 0.6608675819, -0.8732022547],
    [0.8810811932, 0.6903706878, -0.5953059103, -0.3084040686, -0.4038498853],
    [-0.5687101164, 0.2736758588, -0.2217360382, 0.8742950972, 0.2997583987],
    [0.0708459913, 0.8221730616, -0.7213265567, -0.3810462836, 0.0503867753],
    [0.4880140595, 0.9466627196, 1.0163097961, -0.9500386514, -0.6341709382],
    [1.3402207103, 0.0013395288, 3.4813009133, -0.8636814677, 41.3171047132],
    [1.2388217292, -0.6520886912, 0.3508321737, 0.6640560714, 1.5936220597],
    [-0.1800525171, -0.2620989752, 0.056675277, -0.5045395315, 0.2732553554],
    [-0.7776331454, 0.1895231137, 0.5384918862, 0.093711904, -0.3725627758],
    [-0.3181583022, 0.2467979854, 0.4341718676, -0.7277619935, 0.1799381758],
    [-0.5558227731, 0.3666152536, 0.1538243225, -0.8915928174, -0.7659355684],
    [0.6111516061, -0.5459495224, -0.5724238425, -0.8553500765, -0.8696190472],
    [0.6843667454, 0.408652181, -0.8830470112, -0.8602324935, 0.1135462621],
    [-0.1569048216, -1.4643247888, 0.5557152813, 1.0482791924, 1.4523116833],
    [0.5207514017, -0.2734444192, -0.3328660936, -0.7941515963, -0.3536051491],
    [-0.4097807954, 0.3198619826, 0.461681627, -0.1135575498, 0.7103339851],
    [-0.8725014237, -1.0312091401, 0.2267643037, -0.6814258121, 0.7524828703],
    [-0.3986855003, 0.4962556631, -0.7330224516, 0.7355772164, 0.3180141739],
    [-1.083080442, 1.8752543187, 0.3623326265, -0.348145191, 0.1977935038],
    [-0.0291290625, 0.0612906199, 0.1219696687, -1.0273685429, 0.0872219768],
    [0.931791094, -0.313753684, -0.3028724837, 0.7387076712, 0.3806140391],
    [0.2630619402, -1.9827996702, -0.7741413496, 0.1262957444, 0.2248777886],
    [-0.2666322362, -1.124654664, 0.7288282621, -0.1384289204, 0.2395966188],
    [0.6611845175, 0.0466048937, -0.1980999993, 0.8152350927, 0.0032723211],
    [-0.3150344751, 0.1391754608, 0.5462816249, -0.7952302364, -0.7520712378],
    [-0.0576916066, 0.3678415302, 0.6802537378, 1.1437036331, -0.8637405666],
    [0.7016273068, 0.3978601709, 0.3157049654, -0.2528455662, -0.8614146703],
    [1.1741126834, -1.4046408959, 1.2914477803, 0.9904052964, -0.6980155826],
])

_W3 = np.array([
    -0.1366382003, 0.8161960822, -0.9458773183, 0.4692969576, 0.0126710629, -0.0403001012,
    -0.0116244898, -0.4874816289, -0.6392241448, -0.410338398, -0.1181027081, 0.1075562037,
    -0.5948728252, 0.5593677345, -0.3642935247, -0.2867603217, 0.142250271, -0.0535698019,
    -0.034007685, -0.3594532426, 0.2551095195, 0.4214344983, 0.8941621336, 0.6283377368,
    -0.7138020667, -0.1426738249, 0.172671223, 0.0714824385, -0.3268182144, -0.0078989755,
    -0.2032828145, -0.0260631534, 0.4918037012,
])


def ann(x):
    """The Pine network, vectorized. NaN in → NaN out (= Pine na → keep the last side)."""
    x = np.asarray(x, dtype=float)
    l1 = np.tanh(x[..., None] * _W1)
    l2 = np.tanh(l1 @ _W2.T)
    return np.tanh(l2 @ _W3)


# ---- anchor period (Pine security(..., ohlc4[1])) ---------------------
def period_id(t, anchor: str):
    length, offset = _PERIOD[anchor]
    return (np.asarray(t, dtype="int64") - offset) // length


def period_start(pid, anchor: str):
    length, offset = _PERIOD[anchor]
    return pid * length + offset


def prev_period_stats(df: pd.DataFrame, anchor: str):
    """Per bar: the previous completed period's ohlc4 and its range (high − low) / ohlc4.
    NaN until one full period has completed. The first period only counts if the data
    starts exactly on its boundary (otherwise it is partial)."""
    t = df["time"].to_numpy(dtype="int64")
    pid = period_id(t, anchor)
    g = pd.DataFrame({
        "pid": pid,
        "o": df["open"].astype(float).to_numpy(), "h": df["high"].astype(float).to_numpy(),
        "l": df["low"].astype(float).to_numpy(),  "c": df["close"].astype(float).to_numpy(),
    }).groupby("pid", sort=True).agg(o=("o", "first"), h=("h", "max"), l=("l", "min"), c=("c", "last"))
    o4 = (g["o"] + g["h"] + g["l"] + g["c"]) / 4.0
    rng = (g["h"] - g["l"]) / o4
    if len(t) and t[0] != period_start(pid[0], anchor):
        o4.iloc[0] = rng.iloc[0] = np.nan
    return o4.shift(1).reindex(pid).to_numpy(), rng.shift(1).reindex(pid).to_numpy()


def live_prev_period(candle: dict, state: dict, anchor: str):
    """on_candle twin of prev_period_stats(): feed one closed candle, get
    (prev ohlc4, prev range) for this bar, or (None, None) while warming up."""
    ts = int(candle["time"])
    o, h, l, c = (float(candle[k]) for k in ("open", "high", "low", "close"))
    pid = int(period_id(ts, anchor))
    cur = state.get("cur")
    if cur is None or cur["pid"] != pid:
        if cur is not None:
            o4 = (cur["o"] + cur["h"] + cur["l"] + cur["c"]) / 4.0
            state["prev"] = [o4, (cur["h"] - cur["l"]) / o4] if cur["complete"] else None
        state["cur"] = {"pid": pid, "o": o, "h": h, "l": l, "c": c,
                        "complete": cur is not None or ts == period_start(pid, anchor)}
    else:
        cur["h"], cur["l"], cur["c"] = max(cur["h"], h), min(cur["l"], l), c
    prev = state.get("prev")
    return (prev[0], prev[1]) if prev else (None, None)


# ---- side → position → one-shot flags ---------------------------------
def flip_columns(out: pd.DataFrame, bias: np.ndarray, sides: dict) -> pd.DataFrame:
    """bias per bar: +1 long, -1 short, NaN = keep the last side. A side that is switched
    off becomes flat. Writes one-shot entry/exit flags; a flip is exit + opposite entry
    on the same bar (both engines run exits before entries)."""
    b = pd.Series(bias).ffill().fillna(0).to_numpy()
    pos = np.where((b > 0) & bool(sides.get("long", True)), 1,
                   np.where((b < 0) & bool(sides.get("short", True)), -1, 0))
    prev = np.concatenate([[0], pos[:-1]])
    out["cond_long"]      = (pos == 1) & (prev != 1)
    out["cond_short"]     = (pos == -1) & (prev != -1)
    out["bar_exit_long"]  = (prev == 1) & (pos != 1)
    out["bar_exit_short"] = (prev == -1) & (pos != -1)
    out["entry_long"]     = out["cond_long"]
    out["entry_short"]    = out["cond_short"]
    out["exit_long"]      = out["bar_exit_long"]
    out["exit_short"]     = out["bar_exit_short"]
    return out


def live_flip(state: dict, bias: Optional[int], sides: dict, ts: int, price: float,
              reason: str) -> Union[Signal, list[Signal], None]:
    """on_candle twin of flip_columns(). The side (`bias`) is kept apart from `pos`, so
    after the live warm-up forces flat the runner rejoins the current side next bar."""
    if bias is not None:
        state["bias"] = bias
    b = int(state.get("bias", 0))
    want = 1 if (b > 0 and sides.get("long", True)) else -1 if (b < 0 and sides.get("short", True)) else 0
    pos = int(state.get("pos", 0))
    if want == pos:
        return None
    signals: list[Signal] = []
    if pos != 0:
        signals.append(Signal(side="long" if pos == 1 else "short", kind="exit", price=price, time=ts, reason=reason))
    if want != 0:
        signals.append(Signal(side="long" if want == 1 else "short", kind="entry", price=price, time=ts, reason=reason))
    state["pos"] = want
    return signals[0] if len(signals) == 1 else signals


class AnnStrategyV2(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("anchor", ParamType.SELECT, "1D", group="Signal", options=_ANCHORS,
                  description="Pine 'Timeframe' input: price is compared with the PREVIOUS "
                              "period's average (ohlc4). 1 day = yesterday, UTC."),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Position size as % of equity."),
    ]

    META = StrategyMeta(
        id="ann_v2_original",
        name="ANN Strategy v2 (Original)",
        description=("Faithful port of the TradingView ANN Strategy v2: a fixed neural net reads "
                     "how far price is from yesterday's average price. Always in the market, "
                     "flips long/short. In practice = long above yesterday's average, short below."),
        schema=PARAM_SCHEMA,
    )

    OVERLAYS = [
        OverlaySpec("anchor", "Prev period ohlc4", from_column="anchor", color="#60a5fa",
                    line_width=2, line_style="dashed"),
    ]

    def warmup_bars(self) -> int:
        return 1000 if self.p["anchor"] == "1W" else 500

    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        out = df.copy()
        prev_o4, _ = prev_period_stats(out, self.p["anchor"])
        o4 = ((out["open"] + out["high"] + out["low"] + out["close"]) / 4.0).to_numpy(dtype=float)
        y = ann((o4 - prev_o4) / prev_o4)
        out["anchor"] = prev_o4
        out["ann_out"] = y
        return flip_columns(out, np.where(y > 0, 1.0, np.where(y < 0, -1.0, np.nan)),
                            {"long": True, "short": True})

    def on_candle(self, candle: dict, state: dict) -> Union[Signal, list[Signal], None]:
        if not bool(candle.get("isClosed", False)):
            return None
        prev_o4, _ = live_prev_period(candle, state, self.p["anchor"])
        bias = None
        if prev_o4 is not None:
            o4 = (float(candle["open"]) + float(candle["high"]) + float(candle["low"]) + float(candle["close"])) / 4.0
            y = float(ann(np.array([(o4 - prev_o4) / prev_o4]))[0])
            bias = 1 if y > 0 else -1 if y < 0 else None
        return live_flip(state, bias, {"long": True, "short": True},
                         int(candle["time"]), float(candle["close"]), "ann_flip")
