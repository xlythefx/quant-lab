"""
Black-Scholes toolkit (pure numpy/scipy — no app imports, no options data required).

Two things live here:

1. The classic option-pricing machinery (price, Greeks, implied vol). This is the
   textbook Black-Scholes. You need an option chain to use it for real pricing, but
   the implied-vol solver is here for when ES/Deribit option data gets wired in.

2. The *practical* part you can use TODAY with plain OHLCV: the Black-Scholes
   "expected move" — how big a price move is statistically NORMAL over a horizon,
   given volatility. This is the bridge to the VWMA-reversion strategy:

       expected 1-sigma move = price * sigma * sqrt(T)

   Fading a move that sits INSIDE the expected range = normal mean reversion (safe).
   Fading a move OUTSIDE it = you're shorting a tail event (dangerous — that's the
   short-gamma blow-up that kills mean reverters).

Everything is causal and self-contained; this module imports nothing app-level so it
is safe to use from strategies, Market Lab, or a standalone script.
"""
from __future__ import annotations

import numpy as np
import pandas as pd
from scipy.stats import norm

# A trading year. Crypto trades 24/7/365; equity futures are closer to 252 sessions.
# Only matters for annualizing — the expected-move math below uses bars directly and
# is unit-agnostic, so this constant is just for reporting annualized vol.
SECONDS_PER_YEAR = 365.0 * 24 * 3600


# --------------------------------------------------------------------------- #
# 1. Classic Black-Scholes (needs an option: strike K, expiry T, rate r)
# --------------------------------------------------------------------------- #

def _d1_d2(S, K, T, r, sigma):
    """The two Black-Scholes intermediate terms. Vectorized."""
    S, K, T, sigma = map(np.asarray, (S, K, T, sigma))
    sqrtT = np.sqrt(np.maximum(T, 1e-12))
    d1 = (np.log(S / K) + (r + 0.5 * sigma**2) * T) / (sigma * sqrtT + 1e-12)
    d2 = d1 - sigma * sqrtT
    return d1, d2


def bs_price(S, K, T, r, sigma, call=True):
    """Black-Scholes fair value of a European option.

    S=spot, K=strike, T=years to expiry, r=risk-free rate, sigma=annualized vol.
    """
    d1, d2 = _d1_d2(S, K, T, r, sigma)
    disc = np.exp(-r * np.asarray(T))
    if call:
        return S * norm.cdf(d1) - K * disc * norm.cdf(d2)
    return K * disc * norm.cdf(-d2) - S * norm.cdf(-d1)


def bs_greeks(S, K, T, r, sigma, call=True):
    """The sensitivities — delta, gamma, vega, theta, rho. Returns a dict."""
    d1, d2 = _d1_d2(S, K, T, r, sigma)
    sqrtT = np.sqrt(np.maximum(T, 1e-12))
    pdf = norm.pdf(d1)
    disc = np.exp(-r * np.asarray(T))
    delta = norm.cdf(d1) if call else norm.cdf(d1) - 1.0
    gamma = pdf / (S * sigma * sqrtT + 1e-12)
    vega = S * pdf * sqrtT                      # per 1.0 change in vol (×0.01 for per-vol-point)
    if call:
        theta = (-S * pdf * sigma / (2 * sqrtT) - r * K * disc * norm.cdf(d2))
        rho = K * T * disc * norm.cdf(d2)
    else:
        theta = (-S * pdf * sigma / (2 * sqrtT) + r * K * disc * norm.cdf(-d2))
        rho = -K * T * disc * norm.cdf(-d2)
    return {"delta": delta, "gamma": gamma, "vega": vega, "theta": theta, "rho": rho}


def implied_vol(price, S, K, T, r, call=True, lo=1e-4, hi=5.0, tol=1e-6, iters=100):
    """Recover the volatility the market is pricing in, by inverting bs_price.

    Bisection (robust, always converges for a valid arbitrage-free price). This is
    the 'IV' that becomes a forward-looking regime signal once option data exists.
    Returns np.nan if the target price is outside the achievable range.
    """
    lo_p = bs_price(S, K, T, r, lo, call)
    hi_p = bs_price(S, K, T, r, hi, call)
    if not (lo_p <= price <= hi_p):
        return float("nan")
    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if bs_price(S, K, T, r, mid, call) > price:
            hi = mid
        else:
            lo = mid
        if hi - lo < tol:
            break
    return 0.5 * (lo + hi)


# --------------------------------------------------------------------------- #
# 2. The practical part — usable TODAY on plain OHLCV (no option chain)
# --------------------------------------------------------------------------- #

def realized_vol(close: pd.Series, window: int = 20) -> pd.Series:
    """Per-bar realized volatility = rolling std of log returns (causal).

    This is sigma in 'per-bar' units (not annualized) — exactly what the
    expected-move formula wants when the horizon is measured in bars.
    """
    logret = np.log(close.astype(float)).diff()
    return logret.rolling(window).std()


def expected_move(close: pd.Series, sigma_bar: pd.Series, horizon_bars: float = 1.0,
                  n_sigma: float = 1.0) -> pd.Series:
    """Black-Scholes expected move over `horizon_bars`, in price units.

        move = price * sigma_per_bar * sqrt(horizon_bars) * n_sigma

    A 1-sigma move is the 'normal' range (~68% of moves fall inside it under the
    lognormal assumption). n_sigma=2 ≈ the 95% range.
    """
    return close.astype(float) * sigma_bar * np.sqrt(horizon_bars) * n_sigma


def fade_safety(df: pd.DataFrame, vol_window: int = 20, n_sigma: float = 1.0,
                ref_col: str = "vwma", horizon_bars: float = 1.0) -> pd.DataFrame:
    """Score how 'safe' it is to fade the current move, the Black-Scholes way.

    For each bar, compares the actual distance of price from a reference level
    (the VWMA if present, else the rolling mean it's reverting to) against the
    BS-expected n-sigma move. Returns a frame with:

        bs_sigma_bar : per-bar realized vol (Black-Scholes sigma)
        bs_move      : expected n-sigma move in price units
        actual_dist  : |close - reference|
        stretch      : actual_dist / bs_move   (>1 = move is bigger than 'normal')
        fade_safe    : stretch <= 1            (True = inside BS-normal range)

    Mean reversion wants `fade_safe == True`: the move it's fading is statistically
    ordinary. When stretch >> 1, the move is a tail event — the regime where a
    short-gamma reverter bleeds.

    `horizon_bars` sets the timescale of the 'normal' move (move ∝ √horizon). The
    default of 1 measures a single-bar move — correct when `actual_dist` is itself
    a one-bar displacement. But a deviation from a K-bar VWMA accumulates over ~K
    bars, so comparing it to a 1-bar move makes everything look like a tail event;
    pass `horizon_bars ≈ the averaging window` (e.g. the VWMA length) so the
    expected move is measured over the same timescale the deviation formed on.
    """
    out = pd.DataFrame(index=df.index)
    close = df["close"].astype(float)
    sigma = realized_vol(close, vol_window)
    if ref_col in df.columns:
        ref = df[ref_col].astype(float)
    else:
        ref = close.rolling(vol_window).mean()

    out["bs_sigma_bar"] = sigma
    out["bs_move"] = expected_move(close, sigma, horizon_bars=horizon_bars, n_sigma=n_sigma)
    out["actual_dist"] = (close - ref).abs()
    out["stretch"] = out["actual_dist"] / out["bs_move"].replace(0, np.nan)
    out["fade_safe"] = out["stretch"] <= 1.0
    return out


# --------------------------------------------------------------------------- #
# 3. Plain-English reporting — turn the numbers into sentences a human reads
# --------------------------------------------------------------------------- #

def describe_bar(stretch: float) -> str:
    """One-line verdict for a single bar's `stretch` value (move / expected move)."""
    if not np.isfinite(stretch):
        return "no reading yet (still warming up)"
    if stretch <= 0.5:
        return f"VERY CALM (move is {stretch:.0%} of normal) -- textbook fade  [GOOD]"
    if stretch <= 1.0:
        return f"NORMAL (move is {stretch:.0%} of normal) -- safe to fade  [GOOD]"
    if stretch <= 2.0:
        return f"STRETCHED (move is {stretch:.1f}x normal) -- fade with caution  [WARN]"
    return f"TAIL EVENT (move is {stretch:.1f}x normal) -- do NOT fade  [DANGER]"


def summarize_fade_safety(df: pd.DataFrame, vol_window: int = 20,
                          n_sigma: float = 1.0, label: str = "this market") -> str:
    """Run fade_safety over a price history and return a plain-English report.

    Designed to be printed straight to a console — no quant background needed.
    """
    fs = fade_safety(df, vol_window=vol_window, n_sigma=n_sigma)
    valid = fs.dropna(subset=["stretch"])
    if valid.empty:
        return f"Not enough data for {label} to compute Black-Scholes fade safety."

    safe_pct = valid["fade_safe"].mean()
    tail_pct = (valid["stretch"] > 2.0).mean()
    med = valid["stretch"].median()
    last = valid.iloc[-1]

    lines = [
        f"Black-Scholes fade-safety report -- {label}",
        "=" * 52,
        f"Bars analyzed:            {len(valid):,}",
        f"Safe-to-fade bars:        {safe_pct:.0%}   (move within the normal range)",
        f"Tail-event bars:          {tail_pct:.0%}   (move > 2x normal = danger zone)",
        f"Typical move size:        {med:.0%} of 'normal'",
        "",
        "RIGHT NOW (most recent bar):",
        f"  Price is {last['actual_dist']:.2f} away from its mean.",
        f"  Black-Scholes says a normal move is ~{last['bs_move']:.2f}.",
        f"  Verdict: {describe_bar(last['stretch'])}",
        "",
        "How to read this:",
        "  stretch <= 1  -> the move is statistically ordinary -> mean reversion is safe.",
        "  stretch >> 1  -> a freak/tail move -> fading it is the short-gamma trap.",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# Sanity demo — run `python backend/services/black_scholes.py`
# --------------------------------------------------------------------------- #
if __name__ == "__main__":
    # (a) Classic BS round-trip: price an option, then recover its vol.
    S, K, T, r, true_sigma = 100.0, 100.0, 0.25, 0.04, 0.20
    c = float(bs_price(S, K, T, r, true_sigma, call=True))
    iv = implied_vol(c, S, K, T, r, call=True)
    g = bs_greeks(S, K, T, r, true_sigma, call=True)
    print("=== Classic Black-Scholes (textbook) ===")
    print(f"  ATM call, S={S} K={K} T={T}y vol={true_sigma:.0%}  ->  price = {c:.4f}")
    print(f"  implied vol recovered from price          ->  {iv:.4%}  (should be 20%)")
    print(f"  delta={g['delta']:.3f}  gamma={g['gamma']:.4f}  vega={g['vega']:.3f}")

    # (b) Practical expected-move demo on a synthetic price path (no data needed).
    rng_close = pd.Series(100 * np.exp(np.cumsum(
        np.linspace(-0.001, 0.001, 300) + 0.01 * np.sin(np.arange(300) / 7.0))))
    df = pd.DataFrame({"close": rng_close})
    fs = fade_safety(df, vol_window=20, n_sigma=1.0)
    inside = fs["fade_safe"].mean()
    print("\n=== Black-Scholes 'fade safety' on a sample path ===")
    print(f"  bars inside the BS-normal 1-sigma range: {inside:.0%}")
    print(f"  median stretch (move / expected move):   {fs['stretch'].median():.2f}")
    print("  -> fade when stretch <= 1 (normal move), stand aside when >> 1 (tail).")
