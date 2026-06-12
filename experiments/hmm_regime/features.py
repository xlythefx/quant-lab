"""
Causal observation features for the Gaussian-HMM regime experiment.

Three observations, chosen to answer three different questions about the market:
    1. trend slope       -> is it moving, and which way?      (direction)
    2. realized vol (20)  -> how violently is it moving?        (risk state)
    3. rolling Hurst      -> is the move persistent or noisy?   (trend persistence)

NOTE on the trend feature: the first version used the 1-bar log return, but at hourly
resolution its per-state mean was ~0 (no regime-level direction, just noise) so the HMM
only separated states by volatility. We replaced it with a normalized rolling linreg
slope (%/bar over `trend_window` bars) — the same trend measure the deterministic
detector uses (regime.py:_regime_labels) — so the HMM can actually find bull vs bear
regimes, not just calm vs volatile.

Every feature at bar i uses only bars <= i (trailing windows), so the feature
matrix itself is causal. NOTE: the HMM *fit* in this experiment is still
full-sample (look-ahead) — see hmm_model.py / README. The causal feature build
just keeps the door open for a rolling refit later without changing definitions.

Conventions mirror backend/services/market_lab.py so the experiment and the app
agree on what "log return" and "realized vol" mean:
    _log_returns      -> market_lab.py:_log_returns  (np.diff(np.log(close)))
    realized vol (20) -> market_lab.py:forecast_volatility (rolling std of log ret)
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from sklearn.preprocessing import StandardScaler

FEATURE_NAMES = ["trend", "rv20", "hurst"]


def rolling_slope(close: np.ndarray, window: int = 36) -> np.ndarray:
    """Causal rolling linreg slope of close, normalized to %/bar — the 'direction'
    feature. Mirrors the slope used in backend/services/strategies/regime.py so the
    HMM and the deterministic detector agree on what 'trend' means.

    Aligned to `close` (length N); first window-1 entries are NaN.
    """
    c = np.asarray(close, dtype=float)
    n = c.size
    out = np.full(n, np.nan)
    if n < window:
        return out
    x = np.arange(window, dtype=float)
    x_dev = x - x.mean()
    x_ss = float(np.dot(x_dev, x_dev))
    for i in range(window - 1, n):
        win = c[i - window + 1: i + 1]
        beta = float(np.dot(x_dev, win - win.mean())) / x_ss if x_ss > 0 else 0.0
        out[i] = (beta / win[-1]) if win[-1] > 0 else 0.0
    return out


def log_returns(close: np.ndarray) -> np.ndarray:
    """Bar-to-bar log returns. Length N-1; ret[i] is the return INTO bar i+1.

    Same definition as market_lab._log_returns so the numbers are comparable.
    """
    c = np.asarray(close, dtype=float)
    return np.diff(np.log(c))


def realized_vol(log_ret: pd.Series, window: int = 20) -> pd.Series:
    """Rolling std of log returns (raw, not annualized) — the 'risk state' feature."""
    return log_ret.rolling(window).std()


def rolling_hurst(log_ret: np.ndarray, window: int = 100) -> np.ndarray:
    """Causal rolling Hurst exponent via classic R/S analysis.

    For each trailing window of log returns, the rescaled range R/S is computed
    over a few sub-period sizes and the Hurst exponent is the slope of
    log(R/S) vs log(size). Interpretation:
        H ~ 0.5  -> random walk (no memory)
        H > 0.5  -> persistent / trending
        H < 0.5  -> anti-persistent / mean-reverting

    Output is aligned to `log_ret` (same length); the first `window-1` entries
    are NaN (insufficient warmup). Pure trailing windows -> causal.
    """
    x = np.asarray(log_ret, dtype=float)
    n = x.size
    out = np.full(n, np.nan)
    if window < 16 or n < window:
        return out

    # Sub-period sizes used for the R/S regression (powers-ish of 2 up to window).
    sizes = []
    s = 8
    while s <= window:
        sizes.append(s)
        s *= 2
    if len(sizes) < 2:
        sizes = [window // 2, window]
    log_sizes = np.log(np.asarray(sizes, dtype=float))

    for end in range(window - 1, n):
        seg = x[end - window + 1: end + 1]
        rs_vals = []
        ok_sizes = []
        for size in sizes:
            # Split the window into non-overlapping chunks of `size`; average R/S.
            n_chunks = window // size
            if n_chunks < 1:
                continue
            rs_chunk = []
            for k in range(n_chunks):
                chunk = seg[k * size: (k + 1) * size]
                mean = chunk.mean()
                dev = np.cumsum(chunk - mean)
                R = dev.max() - dev.min()
                S = chunk.std()
                if S > 0 and np.isfinite(R):
                    rs_chunk.append(R / S)
            if rs_chunk:
                rs_vals.append(np.mean(rs_chunk))
                ok_sizes.append(size)
        if len(rs_vals) >= 2:
            ls = np.log(np.asarray(ok_sizes, dtype=float))
            lr = np.log(np.asarray(rs_vals, dtype=float))
            # Hurst = slope of log(R/S) vs log(size).
            slope = np.polyfit(ls, lr, 1)[0]
            out[end] = float(slope)
    return out


def build_features(df: pd.DataFrame, trend_window: int = 36,
                   rv_window: int = 20, hurst_window: int = 250):
    """Assemble the causal observation matrix for the HMM.

    Returns (feat_df, scaled_matrix, scaler) where:
      - feat_df: DataFrame with columns ["time", "close", "log_ret", *FEATURE_NAMES]
                 (raw, un-scaled, for plotting/CSV). log_ret is kept for display only;
                 the HMM input columns are FEATURE_NAMES = [trend, rv20, hurst].
      - scaled_matrix: float ndarray of the 3 standardized features (HMM input)
      - scaler: the fitted StandardScaler (kept for reference)

    Warmup rows with any NaN feature are dropped so the HMM never sees NaNs.
    """
    close = df["close"].to_numpy(dtype=float)
    time_a = df["time"].to_numpy()

    lr = log_returns(close)                 # length N-1, aligned to bars[1:]
    lr_s = pd.Series(lr)
    rv = realized_vol(lr_s, rv_window).to_numpy()
    hurst = rolling_hurst(lr, hurst_window)
    trend = rolling_slope(close, trend_window)[1:]   # align to bars[1:]

    # All arrays aligned to bars[1:] (the log-return index).
    feat = pd.DataFrame({
        "time": time_a[1:],
        "close": close[1:],
        "log_ret": lr,
        "trend": trend,
        "rv20": rv,
        "hurst": hurst,
    })
    feat = feat.dropna().reset_index(drop=True)

    X = feat[FEATURE_NAMES].to_numpy(dtype=float)
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)
    return feat, X_scaled, scaler
