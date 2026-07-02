"""
AI Strategy Builder — SSE chat endpoint behind the Strategy Sandbox page.

POST /api/strategy-builder/chat
  body: {messages, symbol, timeframe, user_input?, pending_action?}
  -> text/event-stream of builder events (see services/strategy_builder.py).

The Anthropic key lives in backend/.env and is never exposed to the frontend;
all model calls happen server-side in services/strategy_builder.py.
"""
import json
import logging

from flask import Blueprint, Response, request, stream_with_context

from services import strategy_builder

log = logging.getLogger(__name__)

strategy_builder_bp = Blueprint("strategy_builder", __name__, url_prefix="/api/strategy-builder")


@strategy_builder_bp.post("/chat")
def chat():
    body = request.get_json(silent=True) or {}

    def gen():
        try:
            yield from strategy_builder.stream_chat(body)
        except Exception as e:  # last-ditch — surface as an SSE error frame
            log.exception("builder chat stream crashed")
            yield f"event: error\ndata: {json.dumps({'message': str(e)})}\n\n"

    resp = Response(stream_with_context(gen()), mimetype="text/event-stream")
    resp.headers["Cache-Control"] = "no-cache"
    resp.headers["X-Accel-Buffering"] = "no"   # don't let nginx buffer the stream
    resp.headers["Connection"] = "keep-alive"
    return resp
