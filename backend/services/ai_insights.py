"""
AI-powered insights for backtest / Monte Carlo / Walk-Forward results.

All Claude API calls go through this module — the frontend never sees the API
key. The key is loaded from `backend/.env` via python-dotenv on import.

Three entry points:
  analyze_monte_carlo(mc)        -> human-readable analysis (text)
  analyze_walkforward(wf)        -> human-readable analysis (text)
  suggest_walkforward(meta)      -> structured {is_bars, oos_bars, n_trials, metric, rationale}

Implementation notes:
- Model: claude-haiku-4-5 (fast + cheap; adequate for structured-data summary).
- We compact the result payload before sending — full backtest blobs are
  huge (every bar of the equity curve, every trade) and most of it is noise
  for an AI summary. We extract just the headline stats + a few distilled
  signals per analysis.
- System prompts are cached (`cache_control: ephemeral`) so repeated calls
  reuse the prefix at ~0.1× input cost.
"""
from __future__ import annotations

import json
import logging
import os
from typing import Any, Optional

from dotenv import load_dotenv

log = logging.getLogger(__name__)

# Load .env from backend/ (same dir as this file's parent). Idempotent.
_ENV_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), ".env")
load_dotenv(_ENV_PATH)

_MODEL = "claude-haiku-4-5"
_MAX_TOKENS = 2000


class AIDisabledError(RuntimeError):
    """Raised when ANTHROPIC_API_KEY isn't configured."""


def _client():
    """Lazy import + construct so the rest of the app still boots if anthropic
    isn't installed yet (during a partial deploy)."""
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        raise AIDisabledError(
            "ANTHROPIC_API_KEY is not set. Add it to backend/.env and restart."
        )
    try:
        import anthropic
    except ImportError as e:
        raise AIDisabledError(
            "anthropic package is not installed. Run `pip install -r requirements.txt`."
        ) from e
    return anthropic.Anthropic(api_key=api_key)


# ---------------------------------------------------------------------------
# Payload compaction — strip the giant per-bar arrays before sending to Claude.
# ---------------------------------------------------------------------------

def _compact_backtest_stats(result: dict) -> dict:
    """Extract only the headline numbers from a backtest result."""
    s = result.get("stats", {}) or {}
    a = result.get("analytics", {}) or {}
    return {
        "strategy_id": result.get("strategy_id"),
        "symbol": result.get("symbol"),
        "timeframe": result.get("timeframe"),
        "stats": {
            "starting_capital":   s.get("starting_capital"),
            "final_equity":       s.get("final_equity"),
            "total_return_pct":   s.get("total_return_pct"),
            "trades":             s.get("trades"),
            "win_rate":           s.get("win_rate"),
            "profit_factor":      s.get("profit_factor"),
            "sharpe":             s.get("sharpe"),
            "max_drawdown_pct":   s.get("max_drawdown_pct"),
            "avg_pnl_dollars":    s.get("avg_pnl_dollars"),
            "long":  s.get("long"),
            "short": s.get("short"),
        },
        "analytics": {
            "exposure_pct":              a.get("exposure_pct"),
            "max_drawdown_duration_bars": a.get("max_drawdown_duration_bars"),
            "streaks":                   a.get("streaks"),
            "trading_days":              a.get("trading_days"),
            "commission_dollars":        a.get("commission_dollars"),
        },
    }


def _compact_mc(mc: dict) -> dict:
    """Strip fan paths + envelopes — keep distribution percentiles only."""
    return {
        "method": mc.get("method"),
        "n_sims": mc.get("n_sims"),
        "starting_capital": mc.get("starting_capital"),
        "original": mc.get("original"),
        "prob_profit": mc.get("prob_profit"),
        "prob_ruin": mc.get("prob_ruin"),
        "distribution": {
            k: {kk: vv for kk, vv in (d or {}).items() if kk != "histogram"}
            for k, d in (mc.get("distribution") or {}).items()
        },
    }


def _compact_wf(wf: dict) -> dict:
    """Drop per-bar equity + per-trade arrays; keep stats + per-window summaries."""
    windows = []
    for w in wf.get("windows") or []:
        os_stats = w.get("oos_stats") or {}
        windows.append({
            "window_idx": w.get("window_idx"),
            "is_start": w.get("is_start"),
            "is_end":   w.get("is_end"),
            "oos_start": w.get("oos_start"),
            "oos_end":   w.get("oos_end"),
            "best_params": {
                k: v for k, v in (w.get("best_params") or {}).items()
                if k not in ("sessions", "sides")
            },
            "is_score": w.get("is_score"),
            "oos_stats": {
                "total_return_pct":   os_stats.get("total_return_pct"),
                "sharpe":             os_stats.get("sharpe"),
                "profit_factor":      os_stats.get("profit_factor"),
                "trades":             os_stats.get("trades"),
                "win_rate":           os_stats.get("win_rate"),
                "max_drawdown_pct":   os_stats.get("max_drawdown_pct"),
            },
        })
    compact = _compact_backtest_stats(wf)
    compact["wf_spec"] = wf.get("wf_spec")
    compact["windows"] = windows
    return compact


# ---------------------------------------------------------------------------
# Prompts (system messages are cached)
# ---------------------------------------------------------------------------

_MC_SYSTEM = """You are a senior quant analyst writing concise, actionable insights for a trader who just ran a Monte Carlo simulation on their backtest. Your audience is technically literate.

Structure your response in plain text (no markdown headers, no code fences) with these sections, each a short paragraph (2-4 sentences):

ROBUSTNESS — How much of the original result was luck vs. real edge? Reference prob_profit, the p05-p95 spread of total return, and how the original metric sits inside the distribution.

TAIL RISK — Worst-case drawdown across the simulated paths. Is prob_ruin material? Compare the p05 drawdown to the original.

WHAT THIS MC TELLS YOU (AND WHAT IT DOESN'T) — Be specific about the method: trade-order bootstrap only tests sequencing luck (not regime change); block bootstrap tests path-dependence; synthetic tests parameter robustness against alternate price histories.

VERDICT — One line: would you deploy this? What additional test would you run before risking real capital?

Be direct. Skip preamble like "Based on the data...". Don't restate the numbers verbatim — interpret them. Keep total response under 250 words."""

_WF_SYSTEM = """You are a senior quant analyst reviewing a Walk-Forward Optimization (WFA) result for a trader. The trader is technically literate and wants to know whether the strategy generalizes out-of-sample.

Structure your response in plain text (no markdown headers, no code fences) with these sections, each a short paragraph (2-4 sentences):

OOS PERFORMANCE — Is the stitched out-of-sample result actually any good? Reference Sharpe, profit factor, max DD, and total return. Compare to a "do nothing" baseline.

WINDOW STABILITY — Did the optimal parameters drift across windows? Were the chosen params suspiciously different per window (overfit signal), or stable (real edge signal)? Did some windows blow up?

IS-vs-OOS DEGRADATION — How much did the model degrade from in-sample optimization scores to actual OOS performance? Heavy degradation = overfitting.

VERDICT — One line: is this strategy ready for paper trading? What is the single biggest concern?

Be direct. Skip preamble. Don't restate every number — interpret. Keep total response under 250 words."""

_WF_SUGGEST_SYSTEM = """You are a senior quant configuring a Walk-Forward Optimization (WFA) job. You will be given the dataset size, timeframe, search space, and a few constraints. Return a single JSON object with recommended parameters and a one-paragraph rationale.

Heuristics to apply:
- IS window: large enough to capture multiple regimes (e.g., a few weeks to several months of bars depending on timeframe), but small enough that the strategy can adapt to drift. Common rule: 60-80% of an annual cycle worth of bars, but cap so we get at least 6-10 windows out of available data.
- OOS window: typically 15-30% of the IS window. Too small = noisy scoring; too big = stale optimization.
- Number of windows = (total_bars - is_bars) / oos_bars. Aim for 8-20 windows total.
- n_trials: scale with search space size. ~30 for tiny (1-2 params), ~50 default, ~100-150 for large (5+ params). Cap at 200 to keep runtime reasonable.
- Metric: prefer Sharpe for balanced risk-adjusted optimization; profit_factor when the user clearly wants robustness over returns; total_return only if the user is explicitly return-maximizing.

Return ONLY the JSON object matching the provided schema. No prose outside JSON."""


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def analyze_monte_carlo(mc: dict) -> dict:
    """Returns {text, model, usage}."""
    client = _client()
    payload = _compact_mc(mc)
    msg = client.messages.create(
        model=_MODEL,
        max_tokens=_MAX_TOKENS,
        system=[{
            "type": "text",
            "text": _MC_SYSTEM,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{
            "role": "user",
            "content": (
                "Here is the Monte Carlo result to analyze:\n\n"
                + json.dumps(payload, indent=2)
            ),
        }],
    )
    return _format_text_response(msg)


def analyze_walkforward(wf: dict) -> dict:
    """Returns {text, model, usage}."""
    client = _client()
    payload = _compact_wf(wf)
    msg = client.messages.create(
        model=_MODEL,
        max_tokens=_MAX_TOKENS,
        system=[{
            "type": "text",
            "text": _WF_SYSTEM,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{
            "role": "user",
            "content": (
                "Here is the Walk-Forward result to analyze:\n\n"
                + json.dumps(payload, indent=2)
            ),
        }],
    )
    return _format_text_response(msg)


_WF_SUGGEST_SCHEMA = {
    "type": "object",
    "properties": {
        "is_bars":   {"type": "integer", "description": "In-sample window size in bars"},
        "oos_bars":  {"type": "integer", "description": "Out-of-sample window size in bars"},
        "n_trials":  {"type": "integer", "description": "Optuna trials per window"},
        "metric":    {"type": "string",  "enum": ["sharpe", "profit_factor", "total_return"]},
        "rationale": {"type": "string",  "description": "1-2 sentence explanation of the choices"},
        "expected_windows": {"type": "integer", "description": "Predicted number of WFA windows produced"},
    },
    "required": ["is_bars", "oos_bars", "n_trials", "metric", "rationale", "expected_windows"],
    "additionalProperties": False,
}


_BT_SECTION_SYSTEMS = {
    "overview": """You are a senior quant analyst reviewing a backtest. Read the headline stats and identify in 3-4 short paragraphs:
1) Did this strategy actually make money, and is the return reasonable for the risk taken? Reference total return, Sharpe, profit factor.
2) Is the trade frequency / exposure reasonable, or is it overtrading / undertrading?
3) Long vs short side imbalance — which side carries the result?
4) One-line verdict: deploy candidate, refine, or kill?
Plain text, no markdown headers. Under 200 words.""",
    "sessions": """You are a quant analyzing trade-session breakdown. Identify in 2-3 paragraphs:
1) Which sessions are the strongest / weakest contributors?
2) Is one session inflating the entire result (concentration risk)?
3) Recommendation: should the strategy be restricted to specific sessions?
Plain text, no headers. Under 180 words.""",
    "heatmap": """You are a quant analyzing an hour-of-day × day-of-week PnL heatmap. Identify in 2-3 paragraphs:
1) Strongest and weakest cells (specific weekday + hour combos).
2) Patterns — is performance concentrated in certain hours / days, or diffuse?
3) Practical recommendation: should the strategy filter trade entries by time-of-day?
Plain text, no headers. Under 180 words.""",
    "monthly": """You are a quant analyzing monthly P&L history. Identify in 2-3 paragraphs:
1) Win rate of months and any clusters of losing months (regime sensitivity).
2) Outliers — is one month carrying the year?
3) Trend — is performance stable, decaying, or improving over time?
Plain text, no headers. Under 180 words.""",
    "drawdown": """You are a quant analyzing the equity drawdown curve. Identify in 2-3 paragraphs:
1) Is max DD acceptable for the achieved return?
2) DD duration / time-to-recover — is the strategy psychologically tradable?
3) Open drawdown at end — has it recovered to ATH, or is it currently underwater?
Plain text, no headers. Under 180 words.""",
    "distribution": """You are a quant analyzing the per-trade PnL distribution and trade-duration distribution. Identify in 2-3 paragraphs:
1) Is the PnL distribution symmetric, right-skewed (good — fat winners), or left-skewed (bad — picking up pennies in front of a steamroller)?
2) Trade duration — quick scalps or longer holds? Is duration consistent or scattered?
3) What this implies for capital efficiency and risk-of-ruin.
Plain text, no headers. Under 180 words.""",
    "advanced": """You are a senior quant reviewing the adversarial / robustness metrics block. Cover in 3-4 paragraphs:
1) Statistical significance — is the edge real (t-test p-value)? Sample size adequate?
2) Concentration — do the top-10 winners dominate (luck risk) or is the edge broad?
3) Risk-adjusted returns — Sortino, Calmar, K-Ratio, Ulcer interpretations.
4) Robustness (if walk-forward data present): parameter stability, deflated Sharpe, WFE.
Plain text, no headers. Under 250 words.""",
    "trades": """You are a quant analyzing the trade record. Cover in 2-3 paragraphs:
1) Quality of best vs worst trades — are biggest wins/losses outliers?
2) MAE vs MFE pattern — are stops too tight (large MAE on winners) or are exits early (MFE >> realized PnL)?
3) Recommendation: is risk management appropriate?
Plain text, no headers. Under 180 words.""",
}


def _compact_section(result: dict, section: str) -> dict:
    """Slim down the backtest result to just the slice relevant to a section."""
    base = {
        "strategy_id": result.get("strategy_id"),
        "symbol": result.get("symbol"),
        "timeframe": result.get("timeframe"),
    }
    s = result.get("stats") or {}
    a = result.get("analytics") or {}

    if section == "overview":
        return {**base, "stats": s, "analytics": {
            "exposure_pct": a.get("exposure_pct"),
            "max_drawdown_duration_bars": a.get("max_drawdown_duration_bars"),
            "streaks": a.get("streaks"),
            "trading_days": a.get("trading_days"),
            "commission_dollars": a.get("commission_dollars"),
        }}
    if section == "sessions":
        return {**base, "by_session": a.get("by_session"),
                "total_trades": s.get("trades"), "total_pnl": s.get("total_return_dollars")}
    if section == "heatmap":
        return {**base, "heatmap": a.get("heatmap"),
                "total_trades": s.get("trades")}
    if section == "monthly":
        return {**base, "monthly_returns": a.get("monthly_returns"),
                "total_return_pct": s.get("total_return_pct")}
    if section == "drawdown":
        adv_dd = (a.get("advanced") or {}).get("drawdown") or {}
        return {**base,
                "max_drawdown_pct": s.get("max_drawdown_pct"),
                "max_drawdown_dollars": s.get("max_drawdown_dollars"),
                "max_drawdown_duration_bars": a.get("max_drawdown_duration_bars"),
                "advanced_drawdown": adv_dd,
                "final_equity": s.get("final_equity"),
                "starting_capital": s.get("starting_capital")}
    if section == "distribution":
        return {**base,
                "distribution_pnl_pct": a.get("distribution_pnl_pct"),
                "distribution_duration_min": a.get("distribution_duration_min"),
                "best_trade": a.get("best_trade"),
                "worst_trade": a.get("worst_trade"),
                "advanced_distribution": (a.get("advanced") or {}).get("distribution")}
    if section == "advanced":
        return {**base, "advanced": a.get("advanced"), "stats": {
            "trades": s.get("trades"), "win_rate": s.get("win_rate"),
            "sharpe": s.get("sharpe"), "profit_factor": s.get("profit_factor"),
            "total_return_pct": s.get("total_return_pct"),
        }}
    if section == "trades":
        # Sample best/worst 20 + advanced edge (MAE/MFE) for a useful slice.
        trades = result.get("trades") or []
        srt = sorted(trades, key=lambda t: t.get("pnl_dollars") or 0)
        worst = srt[:20]
        best = srt[-20:]
        return {**base,
                "n_trades": len(trades),
                "best_20": best, "worst_20": worst,
                "edge": (a.get("advanced") or {}).get("edge"),
                "stats": {"avg_pnl_dollars": s.get("avg_pnl_dollars"),
                          "win_rate": s.get("win_rate")}}
    return {**base, "stats": s}


def analyze_backtest_section(payload: dict) -> dict:
    """payload: {result: <backtest result>, section: <section id>}"""
    result = payload.get("result") or {}
    section = str(payload.get("section") or "overview").lower()
    if section not in _BT_SECTION_SYSTEMS:
        raise ValueError(f"unknown section: {section}")
    client = _client()
    compact = _compact_section(result, section)
    msg = client.messages.create(
        model=_MODEL,
        max_tokens=_MAX_TOKENS,
        system=[{
            "type": "text",
            "text": _BT_SECTION_SYSTEMS[section],
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{
            "role": "user",
            "content": (
                f"Section to analyze: {section}\n\n"
                + json.dumps(compact, indent=2)
            ),
        }],
    )
    return _format_text_response(msg)


def suggest_walkforward(meta: dict) -> dict:
    """meta: {strategy_id, symbol, timeframe, rows, first_time, last_time,
             search_space_len, search_space, timeframe_seconds}
    Returns {suggestion: {...schema...}, model, usage}."""
    client = _client()
    msg = client.messages.create(
        model=_MODEL,
        max_tokens=_MAX_TOKENS,
        system=[{
            "type": "text",
            "text": _WF_SUGGEST_SYSTEM,
            "cache_control": {"type": "ephemeral"},
        }],
        output_config={
            "format": {
                "type": "json_schema",
                "schema": _WF_SUGGEST_SCHEMA,
            }
        },
        messages=[{
            "role": "user",
            "content": "Configure a walk-forward job for:\n\n" + json.dumps(meta, indent=2),
        }],
    )
    text = next((b.text for b in msg.content if b.type == "text"), "{}")
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError:
        log.warning("WF suggest returned non-JSON: %r", text[:200])
        parsed = {}
    return {
        "suggestion": parsed,
        "model": msg.model,
        "usage": _usage_dict(msg),
    }


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _format_text_response(msg) -> dict:
    text = "".join(b.text for b in msg.content if b.type == "text").strip()
    return {
        "text": text,
        "model": msg.model,
        "usage": _usage_dict(msg),
    }


def _usage_dict(msg) -> dict:
    u = msg.usage
    return {
        "input_tokens":               getattr(u, "input_tokens", 0),
        "output_tokens":              getattr(u, "output_tokens", 0),
        "cache_read_input_tokens":    getattr(u, "cache_read_input_tokens", 0),
        "cache_creation_input_tokens": getattr(u, "cache_creation_input_tokens", 0),
    }
