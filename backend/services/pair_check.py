"""
Pair Check — is there a "leash" between two coins? (Market Lab, read-only)

Cointegration in plain words: two prices can each wander anywhere, but if the
gap between them keeps getting pulled back, they are cointegrated, like a dog on
a leash. Correlation is a different thing: two coins can move the same way every
day (high correlation) and still drift apart forever.

Everything here is CAUSAL: a value at bar t uses only bars <= t.

  1. Rolling fit. Over the trailing `window_days`, regress log(Y) on log(X):
         log Y ≈ a + b·log X            b = hedge ratio
     hedge = "equal" fixes b at 1, so the spread is just log(Y / X).
  2. Spread and z-score. spread_t = log Y_t − a_t − b_t·log X_t, and z is the
     spread divided by its standard deviation over the same window.
  3. Rolling cointegration test, re-run every `test_every_hours`: an augmented
     Dickey-Fuller (ADF) test on the window's spread. With a fitted b this is the
     Engle-Granger test, which needs a stricter cutoff than plain ADF because the
     fit already made the spread look as tidy as possible. Cutoffs come from
     MacKinnon (2010) response surfaces, so no statsmodels is needed.
  4. Half-life: after a gap opens, how long until half of it closes (AR(1) fit
     of the window's spread).
  5. Fake pair: X's own moves shuffled into a random path. Same size of moves,
     no link to Y. The tests and the trade sim also run on (Y, fake X), so every
     number has a "what luck alone gives" next to it.
  6. Gap trade: z past ±entry_z → short the expensive side, buy the cheap one
     (hedge locked at entry). Exit when z is back to exit_z, past stop_z (the
     leash broke), after max_hold_days, or (optional) when the test stops
     passing. Signal on a bar's close, fill at the next bar's open (QuantLab
     honest mode). Each trade puts 1× capital across both legs and nothing
     compounds, so the equity line is in % of starting capital and sizing-free.

Research only: nothing here is wired into a strategy or the live daemon.
"""
from __future__ import annotations

import math

import numpy as np
import pandas as pd

from services import market_data
from services.quant_metrics import _safe

MAX_POINTS = 800
ZOOM_POINTS = 4000
FAKE_SEED = 7

_TF_SEC = {"1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
           "1h": 3600, "2h": 7200, "4h": 14400, "1d": 86400}

# MacKinnon (2010), constant only: crit(T) = b0 + b1/T + b2/T² + b3/T³.
# 1 series = plain ADF (hedge fixed at 1); 2 series = Engle-Granger (hedge fitted).
_CRIT = {
    1: {0.01: (-3.43035, -6.5393, -16.786, -79.433),
        0.05: (-2.86154, -2.8903, -4.234, -40.040),
        0.10: (-2.56677, -1.5384, -2.809, 0.0)},
    2: {0.01: (-3.89644, -10.9519, -33.527, 0.0),
        0.05: (-3.33613, -6.1101, -6.823, 0.0),
        0.10: (-3.04445, -4.2412, -2.720, 0.0)},
}
LEVELS = (0.10, 0.05, 0.01)          # strip grade 1, 2, 3 (0 = fails all)
GRADE_LABELS = ["Fails", "Passes at 10%", "Passes at 5%", "Passes at 1%"]
EXIT_LABELS = {"closed": "Gap closed", "stop": "Leash broke (z-stop)",
               "time": "Held too long", "test_failed": "Test stopped passing"}


def crit_value(n_series: int, level: float, n_obs: int) -> float:
    b0, b1, b2, b3 = _CRIT[n_series][level]
    return b0 + b1 / n_obs + b2 / n_obs ** 2 + b3 / n_obs ** 3


def adf_tstat(e: np.ndarray, lags: int) -> tuple[float, int]:
    """t-stat on rho in  Δe_t = c + rho·e_{t-1} + Σ φ_i·Δe_{t-i}  (OLS), and the
    number of observations used. Very negative = the gap gets pulled back."""
    de = np.diff(e)
    n = de.size - lags
    if n < 20:
        return float("nan"), n
    cols = [np.ones(n), e[lags:-1]]
    for i in range(1, lags + 1):
        cols.append(de[lags - i: de.size - i])
    X = np.column_stack(cols)
    y = de[lags:]
    xtx_inv = np.linalg.pinv(X.T @ X)
    coef = xtx_inv @ (X.T @ y)
    res = y - X @ coef
    s2 = float(res @ res) / (n - X.shape[1])
    se = math.sqrt(max(s2 * xtx_inv[1, 1], 1e-300))
    return float(coef[1] / se), n


def half_life_bars(e: np.ndarray) -> float:
    """Bars until half a gap closes, from Δe_t = c + λ·e_{t-1}. inf if it doesn't revert."""
    de = np.diff(e)
    lag = e[:-1] - e[:-1].mean()
    denom = float(lag @ lag)
    if denom <= 0:
        return float("inf")
    lam = float(lag @ (de - de.mean())) / denom
    if not -1.0 < lam < 0.0:
        return float("inf")
    return -math.log(2.0) / math.log1p(lam)


# --------------------------------------------------------------------------- #
# Data
# --------------------------------------------------------------------------- #
def _load(symbol: str, timeframe: str) -> tuple[pd.DataFrame, str]:
    """The cached parquet, or one built from a finer cached timeframe (1h from
    15m, ...), whichever reaches further back: a 1h file downloaded later can be
    much shorter than the 15m history. A built series drops its unfinished last candle."""
    cands = []
    try:
        cands.append((market_data.load_parquet(symbol, timeframe), timeframe))
    except FileNotFoundError:
        pass
    target = _TF_SEC.get(timeframe)
    for base in ("15m", "5m", "1m"):
        if target is None or _TF_SEC[base] >= target or target % _TF_SEC[base]:
            continue
        try:
            df = market_data.load_parquet(symbol, base)
        except FileNotFoundError:
            continue
        bucket = (df["time"].astype("int64") // target * target).rename("time")
        out = df.groupby(bucket).agg(open=("open", "first"), high=("high", "max"),
                                     low=("low", "min"), close=("close", "last"),
                                     n=("close", "size"))
        if len(out) and out["n"].iloc[-1] < target // _TF_SEC[base]:
            out = out.iloc[:-1]
        cands.append((out.drop(columns="n").reset_index(), f"{timeframe} built from {base}"))
        break
    if not cands:
        raise FileNotFoundError(
            f"No cached {timeframe} data for {symbol}, and no finer timeframe to build it from. "
            "Download it on the Downloads page first.")
    return min(cands, key=lambda c: int(c[0]["time"].iloc[0]) if len(c[0]) else 2**62)


def _aligned(sym_y, sym_x, timeframe, start, end):
    dy, src_y = _load(sym_y, timeframe)
    dx, src_x = _load(sym_x, timeframe)
    m = dy[["time", "open", "close"]].merge(dx[["time", "open", "close"]], on="time",
                                            suffixes=("_y", "_x"))
    if start is not None:
        m = m[m["time"] >= int(start)]
    if end is not None:
        m = m[m["time"] <= int(end)]
    m = m.dropna().sort_values("time").reset_index(drop=True)
    return m, {"y": src_y, "x": src_x}


# --------------------------------------------------------------------------- #
# Params
# --------------------------------------------------------------------------- #
def _num(params, key, default, lo, hi):
    try:
        v = float(params.get(key, default))
    except (TypeError, ValueError):
        v = default
    return min(hi, max(lo, v)) if math.isfinite(v) else default


def _params(params: dict) -> dict:
    p = params or {}
    level = _num(p, "level", 0.05, 0.0, 1.0)
    return {
        "window_days": _num(p, "window_days", 30.0, 2.0, 365.0),
        "test_every_hours": _num(p, "test_every_hours", 24.0, 0.25, 24.0 * 30),
        "hedge": "equal" if p.get("hedge") == "equal" else "rolling",
        "level": min(LEVELS, key=lambda lv: abs(lv - level)),
        "use_gate": bool(p.get("use_gate", True)),
        "exit_on_fail": bool(p.get("exit_on_fail", False)),
        "entry_z": _num(p, "entry_z", 2.0, 0.1, 10.0),
        "exit_z": _num(p, "exit_z", 0.0, -5.0, 5.0),
        "stop_z": _num(p, "stop_z", 4.0, 0.2, 20.0),
        "max_hold_days": _num(p, "max_hold_days", 3.0, 0.01, 365.0),
        "fee_pct": _num(p, "fee_pct", 0.0, 0.0, 10.0),
        "slippage_bps": _num(p, "slippage_bps", 0.0, 0.0, 500.0),
        "zoom_days": _num(p, "zoom_days", 90.0, 1.0, 3650.0),
    }


# --------------------------------------------------------------------------- #
# Rolling fit + tests (one pair)
# --------------------------------------------------------------------------- #
def rolling_z(ly: np.ndarray, lx: np.ndarray, W: int, hedge: str = "rolling") -> dict:
    """Per-bar hedge ratio, intercept, spread size and z-score, each from the W bars
    ending at that bar (inclusive), so causal. Shared with drift_check."""
    sy, sx = pd.Series(ly), pd.Series(lx)
    ols_beta = (sy.rolling(W).cov(sx, ddof=0) / sx.rolling(W).var(ddof=0)).to_numpy()
    if hedge == "equal":
        d = sy - sx
        beta = np.where(np.isfinite(ols_beta), 1.0, np.nan)
        alpha = d.rolling(W).mean().to_numpy()
        sd = d.rolling(W).std(ddof=0).to_numpy()
    else:
        beta = ols_beta
        alpha = sy.rolling(W).mean().to_numpy() - beta * sx.rolling(W).mean().to_numpy()
        resid_var = sy.rolling(W).var(ddof=0).to_numpy() - beta ** 2 * sx.rolling(W).var(ddof=0).to_numpy()
        sd = np.sqrt(np.clip(resid_var, 0.0, None))
    with np.errstate(divide="ignore", invalid="ignore"):
        z = (ly - alpha - beta * lx) / sd
    z[~np.isfinite(z)] = np.nan
    return {"beta": beta, "ols_beta": ols_beta, "alpha": alpha, "sd": sd, "z": z}


def _fit(ly: np.ndarray, lx: np.ndarray, W: int, step: int, hedge: str) -> dict:
    """rolling_z() plus a cointegration test every `step` bars."""
    rz = rolling_z(ly, lx, W, hedge)
    beta, ols_beta, alpha, z = rz["beta"], rz["ols_beta"], rz["alpha"], rz["z"]

    rets = pd.Series(np.r_[np.nan, np.diff(ly)]).rolling(W - 1).corr(pd.Series(np.r_[np.nan, np.diff(lx)]))
    n_series = 1 if hedge == "equal" else 2
    lags = max(1, int(4 * (W / 100.0) ** 0.25))
    idx = np.arange(W - 1, len(ly), step)
    grade = np.zeros(idx.size, dtype=int)
    stat = np.full(idx.size, np.nan)
    hl = np.full(idx.size, np.nan)
    for k, t in enumerate(idx):
        sl = slice(t - W + 1, t + 1)
        e = ly[sl] - alpha[t] - beta[t] * lx[sl]
        tstat, n_obs = adf_tstat(e, lags)
        stat[k] = tstat
        if math.isfinite(tstat):
            grade[k] = sum(tstat < crit_value(n_series, lv, n_obs) for lv in LEVELS)
        hl[k] = half_life_bars(e)
    return {"beta": beta, "ols_beta": ols_beta, "z": z, "corr": rets.to_numpy(),
            "test_idx": idx, "grade": grade, "stat": stat, "hl_bars": hl, "lags": lags,
            "n_series": n_series}


def _per_bar(test_idx: np.ndarray, values: np.ndarray, n: int, fill):
    """Carry each test's value forward until the next test (causal)."""
    out = np.full(n, fill, dtype=np.asarray(values).dtype if values.size else float)
    for k, t in enumerate(test_idx):
        end = test_idx[k + 1] if k + 1 < test_idx.size else n
        out[t:end] = values[k]
    return out


# --------------------------------------------------------------------------- #
# Gap trade
# --------------------------------------------------------------------------- #
def _simulate(z: np.ndarray, beta: np.ndarray, gate_ok: np.ndarray, p: dict, max_hold: int):
    """One trade at a time. Returns (signal_bar, fill_bar, exit_signal_bar, exit_fill_bar,
    side, locked_beta, z_in, z_out, reason) per closed trade. side +1 = long the spread
    (buy Y, sell X), -1 = short it. A trade still open at the end is left out."""
    zl, bl, gl = z.tolist(), beta.tolist(), gate_ok.tolist()
    entry, exit_z, stop = p["entry_z"], p["exit_z"], p["stop_z"]
    trades, pos = [], 0
    s = e = 0
    b_lock = z_in = 0.0
    for t in range(len(zl) - 1):
        zt = zl[t]
        if pos == 0:
            # Never open past the stop: a gap already that wide is a broken leash.
            if zt != zt or not gl[t] or bl[t] != bl[t] or abs(zt) >= stop:
                continue
            if zt >= entry:
                pos = -1
            elif zt <= -entry:
                pos = 1
            else:
                continue
            s, e, b_lock, z_in = t, t + 1, bl[t], zt
            continue
        reason = None
        if zt == zt:
            if (pos == -1 and zt <= exit_z) or (pos == 1 and zt >= -exit_z):
                reason = "closed"
            elif abs(zt) >= stop and (zt > 0) == (pos == -1):
                reason = "stop"
        if reason is None and t - s >= max_hold:
            reason = "time"
        if reason is None and p["exit_on_fail"] and not gl[t]:
            reason = "test_failed"
        if reason:
            trades.append((s, e, t, t + 1, pos, b_lock, z_in, zt, reason))
            pos = 0
    return trades


def _book(trades, oy, ox, cost: float, n: int):
    """Mark-to-market every bar on opens. Move open[t-1] → open[t] is booked at t."""
    leg_y, leg_x, costs = np.zeros(n), np.zeros(n), np.zeros(n)
    rows = []
    for s, e, xs, x, side, b, z_in, z_out, reason in trades:
        gross = 1.0 + abs(b)
        uy = (side / gross) / oy[e]
        ux = (-side * b / gross) / ox[e]
        leg_y[e + 1:x + 1] += uy * np.diff(oy[e:x + 1])
        leg_x[e + 1:x + 1] += ux * np.diff(ox[e:x + 1])
        costs[e] += cost
        costs[x] += cost
        ry, rx = uy * (oy[x] - oy[e]), ux * (ox[x] - ox[e])
        rows.append({"s": s, "e": e, "xs": xs, "x": x, "side": side, "beta": b,
                     "z_in": z_in, "z_out": z_out, "reason": reason,
                     "ry": ry, "rx": rx, "gross": ry + rx, "net": ry + rx - 2 * cost})
    return leg_y, leg_x, costs, rows


def _trade_stats(rows, bar_sec, n_bars, net_curve) -> dict:
    net = np.array([r["net"] for r in rows], dtype=float)
    n = int(net.size)
    in_mkt = sum(r["x"] - r["e"] for r in rows) / n_bars if n_bars else 0.0
    dd = float(np.max(np.maximum.accumulate(net_curve) - net_curve)) if net_curve.size else 0.0
    base = {"trades": n, "total_net_pct": _safe(float(net.sum()) * 100) if n else 0.0,
            "max_dd_pct": _safe(dd), "time_in_market_pct": _safe(in_mkt * 100)}
    if n == 0:
        return {**base, "avg_net_pct": None, "win_rate": None, "t_stat": None,
                "profit_factor": None, "avg_hold_hours": None}
    sd = float(net.std(ddof=1)) if n >= 2 else 0.0
    wins, losses = net[net > 0].sum(), -net[net < 0].sum()
    hold = np.array([(r["x"] - r["e"]) * bar_sec / 3600 for r in rows])
    return {**base,
            "avg_net_pct": _safe(float(net.mean()) * 100),
            "win_rate": _safe(float(np.mean(net > 0)) * 100),
            "t_stat": _safe(float(net.mean()) / (sd / math.sqrt(n))) if n >= 5 and sd > 0 else None,
            "profit_factor": _safe(float(wins / losses)) if losses > 0 else None,
            "avg_hold_hours": _safe(float(hold.mean()))}


def _run_trades(t_arr, oy, ox, fit, p, bar_sec, use_gate):
    n = len(t_arr)
    grade_bar = _per_bar(fit["test_idx"], fit["grade"], n, -1)
    need = LEVELS.index(p["level"]) + 1
    gate_ok = grade_bar >= need if use_gate else grade_bar >= 0
    max_hold = max(1, int(round(p["max_hold_days"] * 86400 / bar_sec)))
    cost = p["fee_pct"] / 100.0 + p["slippage_bps"] / 10000.0
    pp = {**p, "exit_on_fail": p["exit_on_fail"] and use_gate}
    trades = _simulate(fit["z"], fit["beta"], gate_ok, pp, max_hold)
    leg_y, leg_x, costs, rows = _book(trades, oy, ox, cost, n)
    net_curve = np.cumsum(leg_y + leg_x - costs) * 100
    return {"rows": rows, "leg_y": leg_y, "leg_x": leg_x, "costs": costs, "net_curve": net_curve,
            "stats": _trade_stats(rows, bar_sec, n, net_curve)}


# --------------------------------------------------------------------------- #
# Output helpers
# --------------------------------------------------------------------------- #
def _series(t_arr, values, cap=MAX_POINTS):
    v = np.asarray(values, dtype=float)
    step = max(1, int(math.ceil(len(t_arr) / cap)))
    idx = np.arange(0, len(t_arr), step)
    if len(t_arr) and idx[-1] != len(t_arr) - 1:
        idx = np.r_[idx, len(t_arr) - 1]
    return [{"time": int(t_arr[i]), "value": _safe(float(v[i]))} for i in idx if np.isfinite(v[i])]


def _daily_link(daily_pnl: np.ndarray, day_inv: np.ndarray, close: np.ndarray):
    """(correlation, beta) of the strategy's daily P&L with one coin's daily log move.
    Near 0 = market-neutral, which is the point of a pair trade."""
    day_close = pd.Series(close).groupby(day_inv).last().to_numpy()
    r, s = np.diff(np.log(day_close)), daily_pnl[1:]
    if r.size < 10 or s.std() == 0 or r.std() == 0:
        return None, None
    return _safe(float(np.corrcoef(s, r)[0, 1])), _safe(float(np.cov(s, r)[0, 1] / r.var(ddof=1)))


def _pct(mask) -> float:
    return _safe(float(np.mean(mask)) * 100) if np.size(mask) else 0.0


def _pass_rates(grade) -> dict:
    return {"1": _pct(grade >= 3), "5": _pct(grade >= 2), "10": _pct(grade >= 1)}


def _leash_verdict(real: float, fake: float, level_label: str) -> dict:
    base = max(fake, 5.0)
    if real >= 50 and real >= 3 * base:
        return {"tone": "profit", "label": "A real leash",
                "text": f"Passes the test at {level_label} in {real:.2f}% of windows, against {fake:.2f}% "
                        f"for a fake pair. The gap keeps getting pulled back most of the time."}
    if real >= 2 * base:
        return {"tone": "amber", "label": "Sometimes tied",
                "text": f"Passes at {level_label} in {real:.2f}% of windows against {fake:.2f}% for a fake "
                        f"pair. Only the passing stretches are tradeable, and they come and go."}
    return {"tone": "loss", "label": "No reliable leash",
            "text": f"Passes at {level_label} in only {real:.2f}% of windows, close to the {fake:.2f}% "
                    f"a fake pair gets by luck. Most passes here are chance, not a real link."}


def _trade_verdict(main: dict, fake: dict) -> dict:
    n, t = main["trades"], main["t_stat"]
    if n < 30:
        return {"tone": "amber", "text": f"Only {n} trades. Too few to tell skill from luck."}
    total = main["total_net_pct"] or 0
    if total <= 0:
        return {"tone": "loss", "text": f"Loses money over the period ({total:+.2f}% of capital). "
                                        f"The gaps this setup trades tend to keep widening, not close."}
    beats_fake = total > (fake["total_net_pct"] or 0)
    if t is not None and t >= 2 and beats_fake:
        return {"tone": "profit", "text": f"The gap trade makes money per trade beyond luck (t = {t:.2f}) "
                                          f"and beats the same rules on the fake pair."}
    if beats_fake:
        return {"tone": "amber", "text": "Beats the fake pair, but the average trade is not clearly "
                                         "different from zero (t below 2)."}
    return {"tone": "loss", "text": "Does no better than the same rules on a fake pair. The profit, if "
                                    "any, is not coming from the leash."}


# --------------------------------------------------------------------------- #
# Entry point
# --------------------------------------------------------------------------- #
def analyze(df: pd.DataFrame, timeframe: str, params: dict | None = None,
            names: tuple[str, str] = ("Y", "X")) -> dict:
    """`df` = aligned bars with time, open_y, close_y, open_x, close_x."""
    p = _params(params or {})
    t_arr = df["time"].to_numpy(dtype="int64")
    n = len(t_arr)
    bar_sec = int(np.median(np.diff(t_arr))) if n > 1 else _TF_SEC.get(timeframe, 3600)
    W = max(20, int(round(p["window_days"] * 86400 / bar_sec)))
    step = max(1, int(round(p["test_every_hours"] * 3600 / bar_sec)))
    if n < W + 5 * step + 10:
        raise ValueError(f"Need more data: {n} bars, but the {p['window_days']:g}-day window alone is "
                         f"{W} bars. Widen the date range or shorten the window.")

    oy, cy = df["open_y"].to_numpy(float), df["close_y"].to_numpy(float)
    ox, cx = df["open_x"].to_numpy(float), df["close_x"].to_numpy(float)
    ly, lx = np.log(cy), np.log(cx)

    # Fake X: X's own bar moves in a shuffled order. Same size of moves, no link to Y.
    rng = np.random.default_rng(FAKE_SEED)
    lfx = lx[0] + np.r_[0.0, np.cumsum(rng.permutation(np.diff(lx)))]
    cfx = np.exp(lfx)
    ofx = np.r_[cfx[0], cfx[:-1]]         # no real opens for a fake series: previous close

    fit = _fit(ly, lx, W, step, p["hedge"])
    fake_fit = _fit(ly, lfx, W, step, p["hedge"])

    main = _run_trades(t_arr, oy, ox, fit, p, bar_sec, p["use_gate"])
    alt = _run_trades(t_arr, oy, ox, fit, p, bar_sec, not p["use_gate"])
    fake = _run_trades(t_arr, oy, ofx, fake_fit, p, bar_sec, p["use_gate"])

    level_label = f"{int(p['level'] * 100)}%"
    need = LEVELS.index(p["level"]) + 1
    grade, ti = fit["grade"], fit["test_idx"]
    real_rates, fake_rates = _pass_rates(grade), _pass_rates(fake_fit["grade"])
    real_at, fake_at = real_rates[str(int(p["level"] * 100))], fake_rates[str(int(p["level"] * 100))]
    hl_h = fit["hl_bars"] * bar_sec / 3600
    beta_t = fit["ols_beta"][ti]
    corr_t = fit["corr"][ti]

    # Strip: consecutive tests with the same grade merged into one segment.
    segs = []
    for k, t in enumerate(ti):
        end = int(t_arr[ti[k + 1]]) if k + 1 < ti.size else int(t_arr[-1])
        lab = GRADE_LABELS[grade[k]]
        if segs and segs[-1]["regime"] == lab:
            segs[-1]["end_time"] = end
        else:
            segs.append({"regime": lab, "start_time": int(t_arr[t]), "end_time": end})

    # Zoom: z-score of the last `zoom_days` with the main sim's entries and exits.
    z0 = int(t_arr[-1] - p["zoom_days"] * 86400)
    zi = np.nonzero(t_arr >= z0)[0]
    markers = []
    for r in main["rows"]:
        for bar, kind in ((r["s"], "entry"), (r["xs"], "exit")):
            if t_arr[bar] >= z0 and np.isfinite(fit["z"][bar]):
                markers.append({"time": int(t_arr[bar]), "value": _safe(float(fit["z"][bar])),
                                "kind": kind, "side": "long" if r["side"] == 1 else "short",
                                "reason": EXIT_LABELS[r["reason"]] if kind == "exit" else None})

    # Market-neutral check: the strategy's daily P&L against each coin's daily move.
    _, day_inv = np.unique(t_arr // 86400, return_inverse=True)
    daily_pnl = np.bincount(day_inv, weights=main["leg_y"] + main["leg_x"] - main["costs"])
    corr_x, beta_x = _daily_link(daily_pnl, day_inv, cx)
    corr_y, beta_y = _daily_link(daily_pnl, day_inv, cy)

    # Exit reasons and years (main sim).
    reasons = []
    for key, label in EXIT_LABELS.items():
        rs = [r["net"] for r in main["rows"] if r["reason"] == key]
        if rs:
            reasons.append({"reason": label, "n": len(rs), "avg_net_pct": _safe(float(np.mean(rs)) * 100),
                            "sum_net_pct": _safe(float(np.sum(rs)) * 100)})
    years = {}
    for r in main["rows"]:
        y = pd.Timestamp(int(t_arr[r["s"]]), unit="s", tz="UTC").year
        years.setdefault(y, []).append(r["net"])
    year_rows = [{"year": int(y), "n": len(v), "sum_net_pct": _safe(float(np.sum(v)) * 100),
                  "win_rate": _safe(float(np.mean(np.array(v) > 0)) * 100)} for y, v in sorted(years.items())]

    hl_entry = [hl_h[np.searchsorted(ti, r["s"], side="right") - 1] for r in main["rows"]
                if np.searchsorted(ti, r["s"], side="right") > 0]
    hold_h = [(r["x"] - r["e"]) * bar_sec / 3600 for r in main["rows"]]

    gross_curve = np.cumsum(main["leg_y"] + main["leg_x"]) * 100
    has_costs = p["fee_pct"] > 0 or p["slippage_bps"] > 0
    passing = grade >= need
    gate_word = "gate on" if p["use_gate"] else "gate off"

    return {
        "meta": {
            "symbol_y": names[0], "symbol_x": names[1], "timeframe": timeframe,
            "bars": n, "first_time": int(t_arr[0]), "last_time": int(t_arr[-1]),
            "bar_seconds": bar_sec, "window_bars": W, "test_every_bars": step,
            "adf_lags": fit["lags"], "tests": int(ti.size),
            "test_name": "ADF on log(Y/X)" if p["hedge"] == "equal" else "Engle-Granger (ADF on the fitted spread)",
            "crit_5pct": _safe(crit_value(fit["n_series"], 0.05, W - fit["lags"] - 1)),
            "params": p,
            "caveat": ("Every value is causal (built only from bars up to that point), but you chose the "
                       "settings after seeing these results, and windows overlap so they are not independent "
                       "tests. Treat a good-looking result as something to confirm on data you haven't looked at."),
        },
        "summary": {
            "pass_pct": real_rates, "fake_pass_pct": fake_rates,
            "beta_median": _safe(float(np.nanmedian(beta_t))) if ti.size else None,
            "beta_p10": _safe(float(np.nanpercentile(beta_t, 10))) if ti.size else None,
            "beta_p90": _safe(float(np.nanpercentile(beta_t, 90))) if ti.size else None,
            "corr_median": _safe(float(np.nanmedian(corr_t))) if ti.size else None,
            "halflife_median_hours": _safe(float(np.median(hl_h[passing]))) if passing.any() else None,
            "halflife_all_median_hours": _safe(float(np.median(hl_h[np.isfinite(hl_h)])))
                                         if np.isfinite(hl_h).any() else None,
            "verdict": _leash_verdict(real_at, fake_at, level_label),
        },
        "prices": {
            "y": _series(t_arr, cy / cy[0] * 100),
            "x": _series(t_arr, cx / cx[0] * 100),
        },
        "rolling": {
            "strip": segs,
            "beta": _series(t_arr[ti], beta_t),
            "corr": _series(t_arr[ti], corr_t),
            "halflife_hours": _series(t_arr[ti], np.where(np.isfinite(hl_h), np.minimum(hl_h, W * bar_sec / 3600), np.nan)),
            "halflife_cap_hours": _safe(W * bar_sec / 3600),
        },
        "zoom": {
            "start_time": int(t_arr[zi[0]]) if zi.size else None,
            "z": _series(t_arr[zi], fit["z"][zi], cap=ZOOM_POINTS) if zi.size else [],
            "markers": markers,
        },
        "trading": {
            "main": {**main["stats"], "label": f"This pair, {gate_word}"},
            "alt": {**alt["stats"], "label": f"This pair, {'gate off' if p['use_gate'] else 'gate on'}"},
            "fake": {**fake["stats"], "label": f"Fake pair, {gate_word}"},
            "verdict": _trade_verdict(main["stats"], fake["stats"]),
            "has_costs": has_costs,
            "cost_round_trip_pct": _safe(2 * (p["fee_pct"] + p["slippage_bps"] / 100.0)),
            "equity": {
                "net": _series(t_arr, main["net_curve"]),
                "gross": _series(t_arr, gross_curve) if has_costs else [],
                "fake_net": _series(t_arr, fake["net_curve"]),
                "alt_net": _series(t_arr, alt["net_curve"]),
            },
            "legs": {
                "y": _series(t_arr, np.cumsum(main["leg_y"]) * 100),
                "x": _series(t_arr, np.cumsum(main["leg_x"]) * 100),
            },
            "neutrality": {"corr_x": corr_x, "beta_x": beta_x, "corr_y": corr_y, "beta_y": beta_y},
            "exit_reasons": reasons,
            "years": year_rows,
            "median_hold_hours": _safe(float(np.median(hold_h))) if hold_h else None,
            "median_halflife_at_entry_hours": _safe(float(np.median([h for h in hl_entry if np.isfinite(h)])))
                                              if any(np.isfinite(h) for h in hl_entry) else None,
        },
    }


def pair_check(symbol_y: str, symbol_x: str, timeframe: str, start=None, end=None,
               params: dict | None = None) -> dict:
    if symbol_y == symbol_x:
        raise ValueError("Pick two different coins.")
    if timeframe not in _TF_SEC:
        raise ValueError(f"Unsupported timeframe {timeframe}.")
    df, sources = _aligned(symbol_y, symbol_x, timeframe, start, end)
    if df.empty:
        raise ValueError(f"{symbol_y} and {symbol_x} have no {timeframe} bars in common in this range.")
    out = analyze(df, timeframe, params, names=(symbol_y, symbol_x))
    out["meta"]["sources"] = sources
    return out
