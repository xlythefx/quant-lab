"""
Advanced quant metrics — the adversarial / "try to disprove the strategy" layer.

All pure functions. No I/O. Takes the same trade list + equity curve the
backtest_engine already produces. Returns a nested dict with five sections:

  trade_stats   — expectancy, top-10 concentration, basic shape of edge
  risk_adjusted — sortino, calmar, mar, omega, gain-to-pain, k-ratio
  drawdown      — ulcer index, pain ratio, recovery time
  distribution  — skew, kurtosis, tail ratio, t-test, prob of ruin
  edge          — MAE / MFE summary (only if trades carry mae_pct / mfe_pct)
  robustness    — only when wf_trials is supplied:
                  parameter_stability, deflated_sharpe, walk_forward_efficiency

Designed to be safe on empty / degenerate inputs — every metric returns
None or a sentinel float rather than NaN / raising.
"""
from __future__ import annotations

import math
from typing import Optional

import numpy as np
from scipy import stats


# ---------------------------------------------------------------------------
# Public entry
# ---------------------------------------------------------------------------

def compute(
    trades: list[dict],
    equity_curve: list[dict],
    starting_capital: float,
    bars_per_year: float,
    wf_trials: Optional[list[dict]] = None,
) -> dict:
    out: dict = {
        "trade_stats":   _trade_stats(trades),
        "risk_adjusted": _risk_adjusted(trades, equity_curve, starting_capital, bars_per_year),
        "drawdown":      _drawdown(equity_curve, starting_capital, bars_per_year),
        "distribution":  _distribution(trades, starting_capital),
        "edge":          _edge(trades),
    }
    if wf_trials:
        out["robustness"] = _robustness(wf_trials, bars_per_year)
    return out


# ---------------------------------------------------------------------------
# Trade-level stats: expectancy + concentration of P&L
# ---------------------------------------------------------------------------

def _trade_stats(trades: list[dict]) -> dict:
    if not trades:
        return _empty_trade_stats()

    pnl = np.array([float(t["pnl_dollars"]) for t in trades], dtype=float)
    wins = pnl[pnl > 0]
    losses = pnl[pnl < 0]

    n = len(trades)
    win_rate = float(len(wins)) / n
    avg_win = float(wins.mean()) if wins.size else 0.0
    avg_loss = float(losses.mean()) if losses.size else 0.0   # negative

    expectancy = float(pnl.mean())
    # Expectancy in R-multiples: avg trade / avg risk (|avg_loss|).
    expectancy_R = (expectancy / abs(avg_loss)) if avg_loss < 0 else None

    # Concentration: how much of total wins / losses come from the top 10?
    gross_profit = float(wins.sum()) if wins.size else 0.0
    gross_loss = float(-losses.sum()) if losses.size else 0.0

    if wins.size and gross_profit > 0:
        top_w = np.sort(wins)[-10:]
        top10_winners_share = float(top_w.sum() / gross_profit)
    else:
        top10_winners_share = None

    if losses.size and gross_loss > 0:
        top_l = np.sort(-losses)[-10:]  # 10 biggest losses (by magnitude)
        top10_losers_share = float(top_l.sum() / gross_loss)
    else:
        top10_losers_share = None

    # Two flags for the UI badges.
    luck_winners = (top10_winners_share is not None and top10_winners_share > 0.5)
    luck_losers = (top10_losers_share is not None and top10_losers_share > 0.5)

    # Payoff ratio (avg_win / |avg_loss|).
    payoff = (avg_win / abs(avg_loss)) if avg_loss < 0 else None

    # SQN (Van Tharp): sqrt(n) * expectancy / std(pnl).
    sqn = None
    if n >= 3:
        std_pnl = float(pnl.std(ddof=1))
        if std_pnl > 0:
            sqn = _safe(math.sqrt(n) * expectancy / std_pnl)

    # Geometric mean per-trade return from pnl_pct_equity (compounding-aware average).
    geo_mean_pct = None
    pnl_pct_eq = np.array([float(t.get("pnl_pct_equity", 0.0)) / 100.0 for t in trades])
    if n >= 1 and np.all(pnl_pct_eq > -1.0):
        try:
            geo_mean_pct = _safe((float(np.exp(np.mean(np.log(1.0 + pnl_pct_eq)))) - 1.0) * 100.0)
        except Exception:
            pass

    # Max consecutive loss: worst cumulative dollar damage from a losing streak.
    max_consec_loss = 0.0
    cur_run = 0.0
    for p in pnl:
        if p < 0:
            cur_run += p
            if cur_run < max_consec_loss:
                max_consec_loss = cur_run
        else:
            cur_run = 0.0
    max_consec_loss_dollars = _safe(max_consec_loss) if max_consec_loss < 0 else None

    return {
        "expectancy_dollars": expectancy,
        "expectancy_R": expectancy_R,
        "avg_win": avg_win,
        "avg_loss": avg_loss,
        "payoff_ratio": payoff,
        "win_rate": win_rate,
        "top10_winners_share": top10_winners_share,
        "top10_losers_share": top10_losers_share,
        "luck_dependent_wins": bool(luck_winners),
        "luck_dependent_losses": bool(luck_losers),
        "n_winners": int(wins.size),
        "n_losers": int(losses.size),
        "sqn": sqn,
        "geometric_mean_return_pct": geo_mean_pct,
        "max_consec_loss_dollars": max_consec_loss_dollars,
    }


def _empty_trade_stats() -> dict:
    return {
        "expectancy_dollars": 0.0, "expectancy_R": None,
        "avg_win": 0.0, "avg_loss": 0.0, "payoff_ratio": None,
        "win_rate": 0.0,
        "top10_winners_share": None, "top10_losers_share": None,
        "luck_dependent_wins": False, "luck_dependent_losses": False,
        "n_winners": 0, "n_losers": 0,
        "sqn": None, "geometric_mean_return_pct": None, "max_consec_loss_dollars": None,
    }


# ---------------------------------------------------------------------------
# Risk-adjusted return metrics
# ---------------------------------------------------------------------------

def _risk_adjusted(trades: list[dict], equity_curve: list[dict],
                   starting_capital: float, bars_per_year: float) -> dict:
    if len(equity_curve) < 3 or starting_capital <= 0:
        return _empty_risk_adjusted()

    eq = np.array([p["equity"] for p in equity_curve], dtype=float)
    times = np.array([p["time"] for p in equity_curve], dtype=float)
    final_eq = float(eq[-1])

    # CAGR
    years = max((times[-1] - times[0]) / (365.25 * 24 * 3600), 1e-9)
    if final_eq > 0:
        cagr = (final_eq / starting_capital) ** (1.0 / years) - 1.0
    else:
        cagr = -1.0
    cagr = float(cagr)

    # Per-bar equity returns
    denom = np.where(np.abs(eq[:-1]) < 1e-9, 1e-9, eq[:-1])
    r = (eq[1:] - eq[:-1]) / denom
    r = r[np.isfinite(r)]

    sortino = None
    if r.size >= 2:
        # Standard target downside deviation (MAR=0): RMS of shortfalls below 0
        # over ALL periods — not std() of only the negative returns.
        shortfall = np.minimum(r, 0.0)
        dd_dev = float(np.sqrt(np.mean(shortfall ** 2)))
        if dd_dev > 0:
            sortino = float(r.mean() / dd_dev * math.sqrt(bars_per_year))

    # Max drawdown % for Calmar / MAR
    peak = np.maximum.accumulate(eq)
    dd = (eq - peak) / np.where(peak < 1e-9, 1e-9, peak)
    max_dd = float(abs(dd.min())) if dd.size else 0.0
    calmar = float(cagr / max_dd) if max_dd > 0 else None
    mar = calmar  # alias — same definition in this context

    # Omega ratio (threshold = 0) on per-trade equity returns when available,
    # otherwise on per-bar returns.
    if trades:
        tr = np.array([float(t.get("pnl_pct_equity", 0.0)) / 100.0 for t in trades])
    else:
        tr = r
    omega = None
    if tr.size:
        gains = tr[tr > 0].sum()
        losses = -tr[tr < 0].sum()
        if losses > 0:
            omega = float(gains / losses)
        elif gains > 0:
            omega = float("inf")
    # Omega ratio (threshold = 0) and Gain-to-Pain are identical at threshold = 0.
    gain_to_pain = omega  # alias — same formula when threshold = 0

    # K-Ratio: slope of log(equity) vs bar index / std-error of that slope.
    # Measures equity-curve smoothness (high = steady grind, low = lumpy).
    k_ratio = None
    if eq.size >= 5 and (eq > 0).all():
        x = np.arange(eq.size, dtype=float)
        log_eq = np.log(eq)
        try:
            res = stats.linregress(x, log_eq)
            if res.stderr and res.stderr > 0 and math.isfinite(res.stderr):
                k_ratio = float(res.slope / res.stderr)
        except Exception:
            k_ratio = None

    return {
        "cagr_pct": cagr * 100.0,
        "sortino": _safe(sortino),
        "calmar": _safe(calmar),
        "mar": _safe(mar),
        "omega": _safe(omega),
        "gain_to_pain": _safe(gain_to_pain),
        "k_ratio": _safe(k_ratio),
    }


def _empty_risk_adjusted() -> dict:
    return {
        "cagr_pct": 0.0,
        "sortino": None, "calmar": None, "mar": None,
        "omega": None, "gain_to_pain": None, "k_ratio": None,
    }


# ---------------------------------------------------------------------------
# Drawdown-shape metrics: Ulcer / Pain / time-to-recovery
# ---------------------------------------------------------------------------

def _drawdown(equity_curve: list[dict], starting_capital: float,
              bars_per_year: float) -> dict:
    if not equity_curve:
        return {"ulcer_index": None, "pain_ratio": None,
                "max_drawdown_pct": 0.0, "max_drawdown_duration_bars": 0,
                "time_to_recovery_bars": None, "recovered_from_deepest_dd": True,
                "open_drawdown_pct": 0.0, "final_equity_above_start": False}

    eq = np.array([p["equity"] for p in equity_curve], dtype=float)
    times = np.array([p["time"] for p in equity_curve], dtype=float)
    peak = np.maximum.accumulate(eq)
    dd_pct = (eq - peak) / np.where(peak < 1e-9, 1e-9, peak) * 100.0

    # Ulcer index = RMS of drawdown depth %.
    ulcer = float(np.sqrt(np.mean(dd_pct ** 2))) if dd_pct.size else 0.0

    # Pain ratio = CAGR / ulcer.
    years = max((times[-1] - times[0]) / (365.25 * 24 * 3600), 1e-9)
    final_eq = float(eq[-1])
    cagr = (final_eq / starting_capital) ** (1.0 / years) - 1.0 if (final_eq > 0 and starting_capital > 0) else -1.0
    pain_ratio = float(cagr * 100.0 / ulcer) if ulcer > 0 else None

    # Duration: longest bar-stretch underwater.
    cur_under = 0
    max_under = 0
    for v in dd_pct:
        if v < 0:
            cur_under += 1
            max_under = max(max_under, cur_under)
        else:
            cur_under = 0

    max_dd_pct = float(abs(dd_pct.min()))

    # Time-to-recovery from the deepest trough.
    trough_idx = int(dd_pct.argmin())
    ttr = None
    recovered_from_deepest = True
    if trough_idx < len(eq):
        peak_at_trough = float(peak[trough_idx])
        recovered_at = None
        for i in range(trough_idx + 1, len(eq)):
            if eq[i] >= peak_at_trough:
                recovered_at = i
                break
        if recovered_at is not None:
            ttr = int(recovered_at - trough_idx)
        else:
            recovered_from_deepest = False

    # Open drawdown at backtest end: how far below the all-time high are we
    # at the final bar? Negative (or zero). This is the metric most users
    # want when they ask "did the strategy recover?" — it's independent of
    # how the deepest trough was reached.
    ath = float(peak[-1])
    final_eq = float(eq[-1])
    open_dd_pct = (final_eq - ath) / ath * 100.0 if ath > 0 else 0.0

    return {
        "ulcer_index": ulcer,
        "pain_ratio": _safe(pain_ratio),
        "max_drawdown_pct": max_dd_pct,
        "max_drawdown_duration_bars": int(max_under),
        "time_to_recovery_bars": ttr,
        "recovered_from_deepest_dd": bool(recovered_from_deepest),
        "open_drawdown_pct": float(open_dd_pct),
        "final_equity_above_start": bool(final_eq > starting_capital),
    }


# ---------------------------------------------------------------------------
# Distribution: shape of returns + statistical significance
# ---------------------------------------------------------------------------

def _distribution(trades: list[dict], starting_capital: float) -> dict:
    if not trades:
        return _empty_distribution()

    # Per-trade equity-impact returns (fractional, not %).
    r = np.array([float(t.get("pnl_pct_equity", 0.0)) / 100.0 for t in trades])

    if r.size < 2:
        return _empty_distribution()

    sk = float(stats.skew(r, bias=False)) if r.size >= 3 else None
    ku = float(stats.kurtosis(r, fisher=True, bias=False)) if r.size >= 4 else None

    # Tail ratio: |p95| / |p5| > 1 means right-fat (good).
    p05 = float(np.percentile(r, 5))
    p95 = float(np.percentile(r, 95))
    if p05 < 0 and p95 > 0:
        tail_ratio = float(abs(p95) / abs(p05))
    else:
        tail_ratio = None

    # T-test: is mean trade return greater than zero?
    t_stat = None
    p_value = None
    significance = "not_significant"
    if r.size >= 3 and r.std(ddof=1) > 0:
        try:
            tr = stats.ttest_1samp(r, popmean=0.0, alternative="greater")
            t_stat = float(tr.statistic)
            p_value = float(tr.pvalue)
            if math.isfinite(p_value):
                if p_value < 0.01:
                    significance = "significant"
                elif p_value < 0.05:
                    significance = "marginal"
        except Exception:
            pass

    # Probability of ruin (closed-form for fixed bet sizing).
    # ((1 − edge) / (1 + edge))^n where edge = p·R − (1−p), n = bankroll / risk-per-trade
    pnl_dollars = np.array([float(t["pnl_dollars"]) for t in trades])
    wins = pnl_dollars[pnl_dollars > 0]
    losses = pnl_dollars[pnl_dollars < 0]
    prob_ruin = None
    if wins.size and losses.size and starting_capital > 0:
        p = float(wins.size) / len(trades)
        avg_w = float(wins.mean())
        avg_l = float(-losses.mean())
        if avg_l > 0:
            payoff = avg_w / avg_l
            edge = p * payoff - (1.0 - p)
            if edge <= 0:
                prob_ruin = 1.0
            else:
                # Number of avg-loss "bets" the starting bankroll can absorb.
                n_bets = max(1.0, starting_capital / avg_l)
                # Clamp to keep math finite for huge edges.
                n_bets = min(n_bets, 1000.0)
                base = (1.0 - edge) / (1.0 + edge)
                prob_ruin = float(base ** n_bets) if base > 0 else 0.0

    # VaR 95% and CVaR (Expected Shortfall) using pnl_pct_equity in %.
    r_pct = r * 100.0
    var_95 = None
    cvar_95 = None
    if r.size >= 10:
        var_95_raw = float(np.percentile(r_pct, 5))
        var_95 = _safe(var_95_raw)
        below = r_pct[r_pct <= var_95_raw]
        if below.size > 0:
            cvar_95 = _safe(float(below.mean()))

    return {
        "skewness": sk,
        "kurtosis_excess": ku,
        "tail_ratio": tail_ratio,
        "t_stat": t_stat,
        "t_pvalue": p_value,
        "significance": significance,
        "prob_ruin": _safe(prob_ruin),
        "n_trades": int(len(trades)),
        "var_95_pct": var_95,
        "cvar_95_pct": cvar_95,
    }


def _empty_distribution() -> dict:
    return {
        "skewness": None, "kurtosis_excess": None, "tail_ratio": None,
        "t_stat": None, "t_pvalue": None, "significance": "not_significant",
        "prob_ruin": None, "n_trades": 0,
        "var_95_pct": None, "cvar_95_pct": None,
    }


# ---------------------------------------------------------------------------
# MAE / MFE edge analysis
# ---------------------------------------------------------------------------

def _edge(trades: list[dict]) -> Optional[dict]:
    if not trades or not any("mae_pct" in t for t in trades):
        return None
    mae = np.array([float(t["mae_pct"]) for t in trades if "mae_pct" in t])
    mfe = np.array([float(t["mfe_pct"]) for t in trades if "mfe_pct" in t])
    if not (np.isfinite(mae).any() and np.isfinite(mfe).any()):
        return None
    avg_mae = float(np.nanmean(mae)) if mae.size else 0.0
    avg_mfe = float(np.nanmean(mfe)) if mfe.size else 0.0
    convexity = (avg_mfe / abs(avg_mae)) if avg_mae < 0 else None
    return {
        "avg_mae_pct": avg_mae,
        "avg_mfe_pct": avg_mfe,
        "convexity": _safe(convexity),
        "n": int(len(trades)),
    }


# ---------------------------------------------------------------------------
# Robustness: parameter stability + deflated Sharpe + WFE
# ---------------------------------------------------------------------------

def _robustness(wf_trials: list[dict], bars_per_year: float) -> dict:
    """
    wf_trials is a dict-bundle from walkforward.py:
      {
        "optuna_trials": list[{params, value}],   # all trials across all windows
        "window_pairs":  list[{is_score, oos_sharpe, oos_return_pct}],
        "best_sharpe_oos": float | None,
      }
    """
    optuna_trials = wf_trials.get("optuna_trials") or []
    window_pairs = wf_trials.get("window_pairs") or []
    best_oos_sharpe = wf_trials.get("best_sharpe_oos")

    # ---- Parameter stability: stdev of scores in the top decile of trials.
    # Higher score (lower variance) = flatter optimum = more robust.
    stability = None
    if len(optuna_trials) >= 10:
        values = np.array(
            [t["value"] for t in optuna_trials if t.get("value") is not None and math.isfinite(t["value"])],
            dtype=float,
        )
        if values.size >= 10:
            top_n = max(2, int(round(values.size * 0.1)))
            top = np.sort(values)[-top_n:]
            top_mean = float(top.mean())
            top_std = float(top.std(ddof=1)) if top.size > 1 else 0.0
            # Normalize by |mean| so the score is scale-free; clip to [0, 1].
            if abs(top_mean) > 1e-9:
                stability = max(0.0, 1.0 - top_std / abs(top_mean))
            else:
                stability = 0.0

    # ---- Deflated Sharpe (Bailey & López de Prado).
    # Adjusts the best observed Sharpe for the fact that many trials were tested.
    deflated_sharpe = None
    if optuna_trials and best_oos_sharpe is not None and math.isfinite(best_oos_sharpe):
        vals = np.array(
            [t["value"] for t in optuna_trials if t.get("value") is not None and math.isfinite(t["value"])],
            dtype=float,
        )
        N = vals.size
        if N >= 2:
            sr_std = float(vals.std(ddof=1))
            if sr_std > 0:
                # DSR adapted for WFA: uses best OOS Sharpe (more conservative than
                # IS-space original). Expected max Sharpe under the null (Bailey &
                # López de Prado eq. 4):
                euler = 0.5772156649
                # Φ⁻¹ approximation: scipy.stats.norm.ppf
                z1 = stats.norm.ppf(1.0 - 1.0 / N) if N > 1 else 0.0
                z2 = stats.norm.ppf(1.0 - 1.0 / (N * math.e)) if N > 1 else 0.0
                expected_max_sr = sr_std * ((1.0 - euler) * z1 + euler * z2)
                # Deflated Sharpe: probability that observed best > expected max
                # under the null distribution of trial Sharpes. We approximate
                # with a normal CDF using N-1 effective dof.
                z = (best_oos_sharpe - expected_max_sr) / max(sr_std, 1e-9)
                deflated_sharpe = float(stats.norm.cdf(z))

    # ---- Walk-Forward Efficiency: median(oos / is) across windows.
    wfe_median = None
    pct_positive = None
    if window_pairs:
        ratios = []
        valid_windows = [w for w in window_pairs if w.get("oos_sharpe") is not None]
        if valid_windows:
            positives = sum(1 for w in valid_windows if w["oos_sharpe"] > 0)
            pct_positive = float(positives) / len(valid_windows) * 100.0
        for w in window_pairs:
            is_s = w.get("is_score")
            oos_s = w.get("oos_sharpe")
            if is_s is not None and oos_s is not None and is_s > 0:
                ratios.append(oos_s / is_s)
        if ratios:
            wfe_median = float(np.median(ratios))

    return {
        "parameter_stability_score": _safe(stability),
        "deflated_sharpe_probability": _safe(deflated_sharpe),
        "walk_forward_efficiency": _safe(wfe_median),
        "pct_windows_positive_oos": _safe(pct_positive),
        "n_trials": int(len(optuna_trials)),
        "n_windows": int(len(window_pairs)),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _safe(v):
    """Coerce non-finite floats to None so JSON serialization stays clean."""
    if v is None:
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    if not math.isfinite(f):
        return None
    return f


def infer_bars_per_year(time_a) -> float:
    """Mean-bar-interval based annualization factor.
    Shared with backtest_engine._compute_stats."""
    t = np.asarray(time_a, dtype=float)
    if t.size < 2:
        return 0.0
    dt = float(np.diff(t).mean())
    if dt <= 0:
        return 0.0
    return 365.25 * 24.0 * 3600.0 / dt


def cost_attribution(trades, total_return_dollars, slippage_bps) -> dict:
    """How much of the PnL was eaten by commissions vs slippage.

    Fees are EXACT: each trade carries `fees` = entry + exit commission (the
    engine subtracts them as they happen). Slippage is ESTIMATED: the engine
    bakes it into fill prices and never records it separately, so we
    reconstruct it as the configured rate applied to each side's notional —
    `(entry_notional + exit_notional) * slippage_bps/1e4`. For 1-tick-scale
    slippage the approximation error is < 0.01% of the slippage itself.

    `units` already embeds the futures contract multiplier, so the same
    formula gives correct dollar slippage for crypto and futures alike.

    Net PnL is the truth from the equity curve (passed in); gross is the
    frictionless counterfactual `net + total_cost` — i.e. what the book would
    have made with zero fees and zero slippage.
    """
    n = len(trades)
    fee_dollars = float(sum(t.get("fees", 0.0) for t in trades))
    slip_rate = float(slippage_bps) / 10000.0
    traded_notional = 0.0
    slippage_dollars = 0.0
    for t in trades:
        u = abs(float(t.get("units", 0.0)))
        entry_notional = abs(float(t.get("entry_price", 0.0))) * u
        exit_notional  = abs(float(t.get("exit_price", 0.0))) * u
        traded_notional += entry_notional + exit_notional
        slippage_dollars += (entry_notional + exit_notional) * slip_rate

    total_cost = fee_dollars + slippage_dollars
    net = float(total_return_dollars)
    gross = net + total_cost
    return {
        "n_trades": n,
        "fee_dollars": fee_dollars,
        "slippage_dollars": slippage_dollars,
        "total_cost_dollars": total_cost,
        "net_pnl_dollars": net,
        "gross_pnl_dollars": gross,
        # how big a bite costs took out of the frictionless edge
        "cost_pct_of_gross": (total_cost / abs(gross) * 100.0) if abs(gross) > 1e-9 else 0.0,
        "cost_per_trade_dollars": (total_cost / n) if n else 0.0,
        "traded_notional_dollars": traded_notional,
        "cost_bps_of_notional": (total_cost / traded_notional * 10000.0) if traded_notional > 1e-9 else 0.0,
        "fee_share_pct": (fee_dollars / total_cost * 100.0) if total_cost > 1e-9 else 0.0,
        "slippage_share_pct": (slippage_dollars / total_cost * 100.0) if total_cost > 1e-9 else 0.0,
        # echo the assumptions used, for display
        "slippage_bps": float(slippage_bps),
    }
