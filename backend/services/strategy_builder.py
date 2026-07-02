"""
AI Strategy Builder — the streaming, tool-using chat behind the Strategy Sandbox.

A single Claude (claude-sonnet-4-6) conversation that can:
  - list_strategies / read_strategy / run_backtest   (SAFE — run automatically)
  - create_strategy / edit_strategy /
    archive_strategy / delete_strategy                (MUTATING — user must approve)

The whole conversation lives in the browser and is re-sent each turn (like
ai_insights.chat_walkforward). This module owns the agentic loop and streams
the turn to the frontend over SSE. When Claude calls a SAFE tool we run it and
keep going; when it calls a MUTATING tool we DON'T run it — we emit a `proposal`
event and stop, so the UI can show an Approve/Reject card. On the next request
(`pending_action`) we execute (or decline) the approved tool, feed the result
back, and let Claude continue.

SSE events emitted (each: "event: <name>\\ndata: <json>\\n\\n"):
  token            {text}                  streaming assistant text
  tool_ran         {name, summary}         a safe tool finished (UI chip)
  backtest_result  {result}                full backtest payload for the chart
  strategies_changed {}                    a file changed — refresh strategy lists
  proposal         {tool_use_id, name, input}   mutating tool awaiting approval
  state            {messages}              updated opaque message array to persist
  done             {awaiting_approval?}    turn finished
  error            {message}
"""
from __future__ import annotations

import json
import logging
from typing import Iterator

from services import ai_insights, market_data, portfolio_runner, strategy_files, strategy_registry
from services.portfolio_runner import StrategySpec

log = logging.getLogger(__name__)

_MODEL = "claude-sonnet-4-6"
_MAX_TOKENS = 8000
_MAX_TURNS = 8            # backstop against a runaway tool loop
_READ_CAP = 24000        # truncate read_strategy source fed to the model

ALLOWED_SYMBOLS = ("BTCUSDT", "ES")
SAFE_TOOLS = {"list_strategies", "read_strategy", "run_backtest"}
MUTATING_TOOLS = {"create_strategy", "edit_strategy", "archive_strategy", "delete_strategy"}


# ---------------------------------------------------------------------------
# System prompt: behaviour + the authoring contract (cached) + live context
# ---------------------------------------------------------------------------

_AUTHORING_GUIDE = '''You are the AI Strategy Builder inside "QuantLab", a personal trading-research app. \
You help the user turn a plain-English trading idea into a real, runnable strategy file, tune or fix \
existing ones, back-test them, and archive/delete them. Your user is NOT a quant — they are smart but \
new to trading jargon.

HOW TO BEHAVE
- Be warm, concise and plain-spoken. The first time you use a finance term, define it in one short line \
in parentheses, e.g. "drawdown (the worst drop from a previous peak)".
- INTERROGATE BEFORE YOU BUILD. Ask a few focused questions to pin down the idea: which market, long/short \
or both, what triggers a buy/sell, how to exit, whether to use a stop-loss, and any time-of-day limits. \
Meet the user halfway — propose sensible defaults and say which option you'd recommend and why. Don't \
dump all questions at once; have a natural back-and-forth.
- TELL THEM WHAT YOU'LL DO, THEN DO IT. Before any change to a file, explain in one or two plain sentences \
what you're about to create/edit/delete. Then call the matching tool. Calling a create/edit/delete/archive \
tool does NOT change anything by itself — it shows the user an Approve/Reject card, so you don't need to \
separately ask "shall I proceed?". After they approve you'll see the result and can continue.
- Only two markets are available right now: BTCUSDT (Bitcoin, a crypto pair) and ES (the S&P 500 futures \
contract, $50 per index point). If the user asks for anything else, say it's not wired up yet.
- After you create or edit a strategy, offer to back-test it (try it on past data) and, once you have \
results, interpret them in plain words rather than reciting raw numbers.

THE STRATEGY FILE CONTRACT (follow EXACTLY when writing code)
- One Python file per strategy, saved as services/strategies/<id>.py. The <id> is a lowercase slug \
(letters, digits, underscores) and MUST equal the StrategyMeta id and the file name you pass to the tool.
- Import ONLY numpy, pandas, and from services.strategies.base. No other imports, no file/network access.
- Define a class subclassing Strategy with: PARAM_SCHEMA (list of ParamSpec), META (StrategyMeta), \
optional OVERLAYS (list of OverlaySpec), and methods vectorized(self, df) and on_candle(self, candle, state).
- vectorized(df) receives a DataFrame with columns time, open, high, low, close, volume and MUST return \
that same DataFrame with these columns added (one row per input bar, do not drop/reindex rows):
    entry_long, entry_short, exit_long, exit_short  -> boolean arrays (when to open/close)
    stop_price                                       -> float array, np.nan when no stop is active
  Plus one column per OverlaySpec.from_column for any chart lines you declare.
- CAUSAL ONLY: a value at bar i may use only bars 0..i (use .rolling()/.shift(), never look ahead).
- Always walk position state in a simple loop so you emit clean entry/exit *edges* (open only when flat, \
close only when in a position) — see the template.
- SIZING: always include BOTH a `risk_pct` (FLOAT) param and a `contracts` (INT) param. The engine picks \
automatically: BTCUSDT uses risk_pct (% of equity per trade, compounds); ES uses contracts (fixed, $50/pt). \
You don't size positions in code — just expose the params.
- on_candle is for live trading; for the sandbox just `return None` (back-testing uses vectorized()).

REFERENCE TEMPLATE (a complete, valid moving-average-cross strategy — adapt it):
```python
from __future__ import annotations
from typing import Optional
import numpy as np
import pandas as pd
from services.strategies.base import (
    Strategy, StrategyMeta, ParamSpec, ParamType, Signal, OverlaySpec,
)


class MaCrossStrategy(Strategy):
    PARAM_SCHEMA = [
        ParamSpec("fast", ParamType.INT, 10, min=2, max=100, step=1, group="Moving averages"),
        ParamSpec("slow", ParamType.INT, 30, min=5, max=300, step=1, group="Moving averages"),
        ParamSpec("sides", ParamType.SIDES, {"long": True, "short": True}, group="Direction"),
        ParamSpec("risk_pct", ParamType.FLOAT, 3.0, min=0.1, max=100.0, step=0.1, group="Risk",
                  description="Crypto sizing: % of equity per trade."),
        ParamSpec("contracts", ParamType.INT, 1, min=1, max=100, step=1, group="Risk",
                  description="Futures sizing: contracts per trade (ES = $50/pt)."),
    ]
    META = StrategyMeta(
        id="ma_cross",
        name="MA Cross",
        description="Go long when the fast moving average is above the slow one, short when below.",
        schema=PARAM_SCHEMA,
    )
    OVERLAYS = [
        OverlaySpec("fast_ma", "Fast MA", from_column="fast_ma", color="#fbbf24", line_width=2),
        OverlaySpec("slow_ma", "Slow MA", from_column="slow_ma", color="#22d3ee", line_width=2),
    ]

    def vectorized(self, df: pd.DataFrame) -> pd.DataFrame:
        p = self.p
        out = df.copy()
        close = out["close"].astype(float)
        fast = close.rolling(p["fast"]).mean()
        slow = close.rolling(p["slow"]).mean()

        n = len(out)
        entry_long = np.zeros(n, dtype=bool)
        entry_short = np.zeros(n, dtype=bool)
        exit_long = np.zeros(n, dtype=bool)
        exit_short = np.zeros(n, dtype=bool)
        fa = fast.to_numpy()
        sa = slow.to_numpy()
        allow_long = bool(p["sides"].get("long", True))
        allow_short = bool(p["sides"].get("short", True))

        pos = 0  # 0 flat, 1 long, -1 short
        for t in range(n):
            if not (np.isfinite(fa[t]) and np.isfinite(sa[t])):
                continue
            up = fa[t] > sa[t]
            if pos == 0:
                if up and allow_long:
                    pos = 1; entry_long[t] = True
                elif (not up) and allow_short:
                    pos = -1; entry_short[t] = True
            elif pos == 1:
                if not up:
                    exit_long[t] = True; pos = 0
            else:
                if up:
                    exit_short[t] = True; pos = 0

        out["entry_long"] = entry_long
        out["entry_short"] = entry_short
        out["exit_long"] = exit_long
        out["exit_short"] = exit_short
        out["stop_price"] = np.full(n, np.nan)
        out["fast_ma"] = fast
        out["slow_ma"] = slow
        return out

    def on_candle(self, candle: dict, state: dict) -> Optional[Signal]:
        return None  # live mode not used by the sandbox
```
When you create or edit, pass the COMPLETE file content as `code` and a one-line plain-English `summary` \
of what it does. Keep strategies simple and readable unless asked otherwise.'''


def _system(symbol: str, timeframe: str) -> list:
    return [
        {"type": "text", "text": _AUTHORING_GUIDE, "cache_control": {"type": "ephemeral"}},
        {"type": "text",
         "text": f"Current context: the user is looking at {symbol} on the {timeframe} timeframe. "
                 f"Default to these for back-tests and the smoke-test unless they say otherwise."},
    ]


# ---------------------------------------------------------------------------
# Tool definitions
# ---------------------------------------------------------------------------

_CODE_PROP = {"type": "string", "description": "The COMPLETE Python file content for the strategy."}
_SUMMARY_PROP = {"type": "string", "description": "One-line plain-English summary of what this does (shown on the approval card)."}

TOOLS = [
    {
        "name": "list_strategies",
        "description": "List every registered strategy (id, name, description, archived flag, params). "
                       "Use this to see what already exists before tuning or to avoid id clashes.",
        "input_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "read_strategy",
        "description": "Return the full source code of an existing strategy so you can tune or fix it.",
        "input_schema": {
            "type": "object",
            "properties": {"strategy_id": {"type": "string"}},
            "required": ["strategy_id"], "additionalProperties": False,
        },
    },
    {
        "name": "run_backtest",
        "description": "Back-test a registered strategy on historical data and show it on the chart. "
                       "Returns headline stats. Symbol must be BTCUSDT or ES.",
        "input_schema": {
            "type": "object",
            "properties": {
                "strategy_id": {"type": "string"},
                "symbol": {"type": "string", "enum": list(ALLOWED_SYMBOLS)},
                "timeframe": {"type": "string", "description": "e.g. 1m, 15m, 1h"},
                "params": {"type": "object", "description": "Parameter overrides; omit to use defaults."},
            },
            "required": ["strategy_id", "symbol", "timeframe"], "additionalProperties": False,
        },
    },
    {
        "name": "create_strategy",
        "description": "Create a NEW strategy file. Requires user approval. After approval the file is "
                       "written, the registry reloads, and a smoke back-test verifies it runs.",
        "input_schema": {
            "type": "object",
            "properties": {
                "strategy_id": {"type": "string", "description": "lowercase slug; must equal META.id and the file name."},
                "code": _CODE_PROP, "summary": _SUMMARY_PROP,
            },
            "required": ["strategy_id", "code", "summary"], "additionalProperties": False,
        },
    },
    {
        "name": "edit_strategy",
        "description": "Replace the full contents of an EXISTING strategy file. Requires user approval. "
                       "The previous version is backed up and restored automatically if the new code fails.",
        "input_schema": {
            "type": "object",
            "properties": {
                "strategy_id": {"type": "string"}, "code": _CODE_PROP, "summary": _SUMMARY_PROP,
            },
            "required": ["strategy_id", "code", "summary"], "additionalProperties": False,
        },
    },
    {
        "name": "archive_strategy",
        "description": "Hide (or un-hide) a strategy from the default list without deleting it. Requires approval.",
        "input_schema": {
            "type": "object",
            "properties": {
                "strategy_id": {"type": "string"},
                "archived": {"type": "boolean", "description": "true to archive, false to un-archive."},
                "summary": _SUMMARY_PROP,
            },
            "required": ["strategy_id"], "additionalProperties": False,
        },
    },
    {
        "name": "delete_strategy",
        "description": "Delete a strategy file (moved to a recoverable _trash folder). Requires approval.",
        "input_schema": {
            "type": "object",
            "properties": {"strategy_id": {"type": "string"}, "summary": _SUMMARY_PROP},
            "required": ["strategy_id"], "additionalProperties": False,
        },
    },
]


# ---------------------------------------------------------------------------
# Tool execution
# ---------------------------------------------------------------------------

def _check_symbol(symbol: str) -> str:
    s = (symbol or "").upper().strip()
    if s not in ALLOWED_SYMBOLS:
        raise ValueError(f"only {', '.join(ALLOWED_SYMBOLS)} are available right now (got '{symbol}').")
    return s


def _run_backtest(strategy_id: str, symbol: str, timeframe: str, params: dict) -> tuple[dict, dict]:
    """Run a single-strategy backtest via the same path as /api/strategies/run.
    Returns (full_result_for_chart, compact_stats_for_model)."""
    symbol = _check_symbol(symbol)
    broker = market_data.broker_for(symbol, timeframe)
    if broker is None:
        raise ValueError(f"no cached data for {symbol} {timeframe}. "
                         f"BTCUSDT has 1m/15m/1h; ES has 15m/1h.")
    spec = StrategySpec(strategy_id=strategy_id, symbol=symbol, timeframe=timeframe,
                        params=params or {}, priority=1, broker=broker)
    pres = portfolio_runner.run_portfolio([spec])
    psd = pres["per_strategy"].get(strategy_id, {})
    full = {
        "strategy_id": strategy_id, "symbol": symbol, "timeframe": timeframe,
        "params": psd.get("spec", {}).get("params", params or {}),
        "candles": psd.get("candles", []), "overlays": psd.get("overlays", []),
        "trades": psd.get("trades", []), "equity": psd.get("equity", []),
        "stats": psd.get("stats", {}), "analytics": psd.get("analytics", {}),
    }
    return full, ai_insights._compact_backtest_stats(full)


def _compact_strategy_list() -> list:
    out = []
    for d in strategy_registry.list_strategies():
        out.append({
            "id": d["id"], "name": d["name"], "description": d["description"],
            "kind": d.get("kind"), "archived": d.get("archived", False),
            "params": [{"name": s["name"], "type": s["type"], "default": s["default"]}
                       for s in d.get("schema", [])],
        })
    return out


def _execute_tool(name: str, tool_input: dict, symbol: str, timeframe: str):
    """Run one tool. Returns (content_str, is_error, events) where events is a
    list of (sse_event_name, data) to emit to the client."""
    ti = tool_input or {}
    try:
        if name == "list_strategies":
            return json.dumps(_compact_strategy_list()), False, [("tool_ran", {"name": name, "summary": "Listed strategies"})]

        if name == "read_strategy":
            src = strategy_files.read_strategy_source(ti["strategy_id"])
            if len(src) > _READ_CAP:
                src = src[:_READ_CAP] + "\n# ...(truncated)..."
            return src, False, [("tool_ran", {"name": name, "summary": f"Read {ti['strategy_id']}"})]

        if name == "run_backtest":
            full, compact = _run_backtest(ti["strategy_id"], ti.get("symbol", symbol),
                                          ti.get("timeframe", timeframe), ti.get("params") or {})
            return (json.dumps(compact, default=str), False,
                    [("backtest_result", {"result": full}),
                     ("tool_ran", {"name": name, "summary": f"Back-tested {ti['strategy_id']} on {full['symbol']} {full['timeframe']}"})])

        if name == "create_strategy":
            res = strategy_files.create_strategy(ti["strategy_id"], ti["code"], symbol, timeframe)
            return res["message"], False, [("strategies_changed", {}),
                                           ("tool_ran", {"name": name, "summary": res["message"]})]
        if name == "edit_strategy":
            res = strategy_files.edit_strategy(ti["strategy_id"], ti["code"], symbol, timeframe)
            return res["message"], False, [("strategies_changed", {}),
                                           ("tool_ran", {"name": name, "summary": res["message"]})]
        if name == "archive_strategy":
            res = strategy_files.archive_strategy(ti["strategy_id"], bool(ti.get("archived", True)))
            return res["message"], False, [("strategies_changed", {}),
                                           ("tool_ran", {"name": name, "summary": res["message"]})]
        if name == "delete_strategy":
            res = strategy_files.delete_strategy(ti["strategy_id"])
            return res["message"], False, [("strategies_changed", {}),
                                           ("tool_ran", {"name": name, "summary": res["message"]})]

        return f"ERROR: unknown tool '{name}'.", True, []
    except strategy_files.StrategyFileError as e:
        return f"ERROR: {e}", True, []
    except KeyError as e:
        return f"ERROR: strategy not found: {e}", True, []
    except Exception as e:
        log.exception("tool %s failed", name)
        return f"ERROR: {type(e).__name__}: {e}", True, []


# ---------------------------------------------------------------------------
# SSE streaming loop
# ---------------------------------------------------------------------------

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, default=str)}\n\n"


def _friendly_error(e: Exception) -> str:
    """Surface the human-readable message from an Anthropic API error (billing,
    auth, rate limit) instead of the raw exception repr."""
    body = getattr(e, "body", None)
    if isinstance(body, dict):
        msg = (body.get("error") or {}).get("message")
        if msg:
            return msg
    return f"{type(e).__name__}: {e}"


def _serialize_blocks(content) -> list:
    """Anthropic content blocks -> minimal plain dicts we can store + resend."""
    out = []
    for b in content:
        if b.type == "text":
            out.append({"type": "text", "text": b.text})
        elif b.type == "tool_use":
            out.append({"type": "tool_use", "id": b.id, "name": b.name, "input": b.input})
    return out


def _stream_turn(client, messages, symbol, timeframe):
    """Stream one model turn; yield token SSE; return (assistant_blocks, stop_reason)."""
    with client.messages.stream(
        model=_MODEL, max_tokens=_MAX_TOKENS,
        system=_system(symbol, timeframe), tools=TOOLS, messages=messages,
    ) as stream:
        for text in stream.text_stream:
            yield _sse("token", {"text": text})
        final = stream.get_final_message()
    return _serialize_blocks(final.content), final.stop_reason


def _result_block(tool_use_id, content, is_error):
    block = {"type": "tool_result", "tool_use_id": tool_use_id, "content": content}
    if is_error:
        block["is_error"] = True
    return block


def stream_chat(body: dict) -> Iterator[str]:
    """Main entry — a generator of SSE strings for the route to stream."""
    try:
        client = ai_insights._client()
    except ai_insights.AIDisabledError as e:
        yield _sse("error", {"message": str(e)})
        return

    symbol = (body.get("symbol") or "BTCUSDT")
    timeframe = (body.get("timeframe") or "15m")
    messages = list(body.get("messages") or [])
    user_input = body.get("user_input")
    pending = body.get("pending_action")

    if user_input:
        messages.append({"role": "user", "content": user_input})

    try:
        # Resume after an Approve/Reject: build tool_results for the last
        # assistant turn's tool_use blocks (all in ONE user turn, as the API requires).
        if pending:
            last = messages[-1] if messages else None
            if not (isinstance(last, dict) and last.get("role") == "assistant"):
                yield _sse("error", {"message": "no pending action to resolve."})
                return
            tool_uses = [b for b in last.get("content", [])
                         if isinstance(b, dict) and b.get("type") == "tool_use"]
            result_blocks = []
            for b in tool_uses:
                if b["id"] == pending.get("tool_use_id"):
                    if pending.get("approved"):
                        content, is_err, events = _execute_tool(b["name"], b["input"], symbol, timeframe)
                    else:
                        content, is_err, events = (
                            "The user declined this action. Ask what they'd like to change or try instead.",
                            False, [])
                else:
                    # A safe tool that rode along in the same turn — run it now.
                    content, is_err, events = _execute_tool(b["name"], b["input"], symbol, timeframe)
                for ev in events:
                    yield _sse(*ev)
                result_blocks.append(_result_block(b["id"], content, is_err))
            messages.append({"role": "user", "content": result_blocks})

        # Agentic model loop.
        for _ in range(_MAX_TURNS):
            assistant_blocks, stop_reason = yield from _stream_turn(client, messages, symbol, timeframe)
            messages.append({"role": "assistant", "content": assistant_blocks})
            tool_uses = [b for b in assistant_blocks if b["type"] == "tool_use"]

            if not tool_uses:
                yield _sse("state", {"messages": messages})
                yield _sse("done", {})
                return

            # A mutating tool needs approval → emit proposal and stop here.
            mut = next((b for b in tool_uses if b["name"] in MUTATING_TOOLS), None)
            if mut:
                yield _sse("proposal", {"tool_use_id": mut["id"], "name": mut["name"], "input": mut["input"]})
                yield _sse("state", {"messages": messages})
                yield _sse("done", {"awaiting_approval": True})
                return

            # All safe → run them, feed results back, continue the loop.
            result_blocks = []
            for b in tool_uses:
                content, is_err, events = _execute_tool(b["name"], b["input"], symbol, timeframe)
                for ev in events:
                    yield _sse(*ev)
                result_blocks.append(_result_block(b["id"], content, is_err))
            messages.append({"role": "user", "content": result_blocks})

        # Hit the turn cap.
        yield _sse("state", {"messages": messages})
        yield _sse("done", {"capped": True})
    except Exception as e:
        log.exception("strategy_builder stream failed")
        yield _sse("error", {"message": _friendly_error(e)})
