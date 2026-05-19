"""
Quantlab backend entrypoint.

  Flask         REST  (history, prepare, health)
  Flask-SocketIO  WS  (subscribe / unsubscribe / candle_update)

Architecture (one paragraph):
  Each (mode, symbol, timeframe) maps to a single backend stream — either
  a Binance kline WS consumer (live) or a Parquet replay (backtest).
  Browsers join a Socket.IO room "{mode}_{symbol}_{tf}" and receive
  fan-out updates. The first subscriber starts the stream; the last
  subscriber to leave stops it. Same payload shape in both modes so the
  UI (and future strategy code) is mode-agnostic.
"""
import logging

from flask import Flask
from flask_cors import CORS
from flask_socketio import SocketIO

from config import CORS_ORIGINS, HOST, PORT, BACKTEST_DEFAULT_SPEED
from routes.market_routes import market_bp
from routes.strategy_routes import strategy_bp
from routes.settings_routes import settings_bp
from routes.walkforward_routes import walkforward_bp
from routes.grid_search_routes import grid_search_bp
from routes.monte_carlo_routes import monte_carlo_bp
from routes.ai_routes import ai_bp
from services.socket_manager import SocketManager
from services.strategy_manager import StrategyManager
from services import event_bus
from utils.validators import (
    validate_symbol,
    validate_timeframe,
    validate_mode,
    ValidationError,
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s :: %(message)s",
)
log = logging.getLogger("quantlab")


def create_app():
    app = Flask(__name__)
    CORS(app, resources={r"/api/*": {"origins": CORS_ORIGINS}})
    app.register_blueprint(market_bp)
    app.register_blueprint(strategy_bp)
    app.register_blueprint(settings_bp)
    app.register_blueprint(walkforward_bp)
    app.register_blueprint(grid_search_bp)
    app.register_blueprint(monte_carlo_bp)
    app.register_blueprint(ai_bp)

    socketio = SocketIO(
        app,
        cors_allowed_origins=CORS_ORIGINS,
        async_mode="threading",   # plays nicely with websocket-client threads on Windows
        logger=False,
        engineio_logger=False,
    )

    manager = SocketManager(socketio)
    event_bus.set_socketio(socketio)
    strategy_mgr = StrategyManager(manager)

    # ---- Socket.IO events --------------------------------------------
    @socketio.on("connect")
    def on_connect():
        from flask import request
        log.info("client connected sid=%s", request.sid)
        socketio.emit("connected", {"ok": True}, to=request.sid)

    @socketio.on("disconnect")
    def on_disconnect():
        from flask import request
        log.info("client disconnected sid=%s", request.sid)
        strategy_mgr.cleanup_sid(request.sid)
        manager.cleanup_sid(request.sid)

    @socketio.on("subscribe")
    def on_subscribe(payload):
        from flask import request
        payload = payload or {}
        try:
            mode = validate_mode(payload.get("mode"))
            symbol = validate_symbol(payload.get("symbol"))
            tf = validate_timeframe(payload.get("timeframe"))
            speed = int(payload.get("speed") or BACKTEST_DEFAULT_SPEED)
            start_time = payload.get("start_time")
            end_time = payload.get("end_time")
            loop = bool(payload.get("loop", True))
            if start_time is not None: start_time = int(start_time)
            if end_time is not None: end_time = int(end_time)
        except (ValidationError, TypeError, ValueError) as e:
            socketio.emit("error", {"event": "subscribe", "message": str(e)}, to=request.sid)
            return

        manager.subscribe(request.sid, mode, symbol, tf, speed=speed,
                          start_time=start_time, end_time=end_time, loop=loop)
        socketio.emit(
            "subscribed",
            {"mode": mode, "symbol": symbol, "timeframe": tf, "speed": speed,
             "start_time": start_time, "end_time": end_time, "loop": loop},
            to=request.sid,
        )

    @socketio.on("unsubscribe")
    def on_unsubscribe(payload):
        from flask import request
        try:
            mode = validate_mode((payload or {}).get("mode"))
            symbol = validate_symbol((payload or {}).get("symbol"))
            tf = validate_timeframe((payload or {}).get("timeframe"))
        except ValidationError as e:
            socketio.emit("error", {"event": "unsubscribe", "message": str(e)}, to=request.sid)
            return
        manager.unsubscribe(request.sid, mode, symbol, tf)

    @socketio.on("set_speed")
    def on_set_speed(payload):
        from flask import request
        try:
            symbol = validate_symbol((payload or {}).get("symbol"))
            tf = validate_timeframe((payload or {}).get("timeframe"))
            speed = int((payload or {}).get("speed"))
        except (ValidationError, TypeError, ValueError) as e:
            socketio.emit("error", {"event": "set_speed", "message": str(e)}, to=request.sid)
            return
        ok = manager.set_speed(symbol, tf, speed)
        socketio.emit("speed_changed", {"symbol": symbol, "timeframe": tf, "speed": speed, "ok": ok}, to=request.sid)

    # ---- Strategy events ---------------------------------------------
    def _parse_strategy_payload(payload):
        payload = payload or {}
        strategy_id = (payload.get("strategy_id") or "").strip()
        if not strategy_id:
            raise ValidationError("strategy_id is required")
        symbol = validate_symbol(payload.get("symbol"))
        tf = validate_timeframe(payload.get("timeframe"))
        mode = validate_mode(payload.get("mode"))
        params = payload.get("params") or {}
        return strategy_id, symbol, tf, mode, params

    @socketio.on("strategy_start")
    def on_strategy_start(payload):
        from flask import request
        try:
            strategy_id, symbol, tf, mode, params = _parse_strategy_payload(payload)
        except (ValidationError, TypeError, ValueError) as e:
            socketio.emit("strategy_error", {"event": "strategy_start", "message": str(e)}, to=request.sid)
            return
        try:
            strategy_mgr.start(request.sid, strategy_id, symbol, tf, mode, params)
        except FileNotFoundError as e:
            socketio.emit("strategy_error", {"event": "strategy_start", "strategy_id": strategy_id, "message": str(e)}, to=request.sid)
        except Exception as e:
            log.exception("strategy_start failed")
            socketio.emit("strategy_error", {"event": "strategy_start", "strategy_id": strategy_id, "message": str(e)}, to=request.sid)

    @socketio.on("strategy_stop")
    def on_strategy_stop(payload):
        from flask import request
        try:
            strategy_id, symbol, tf, mode, _ = _parse_strategy_payload(payload)
        except (ValidationError, TypeError, ValueError) as e:
            socketio.emit("strategy_error", {"event": "strategy_stop", "message": str(e)}, to=request.sid)
            return
        strategy_mgr.stop(request.sid, strategy_id, symbol, tf, mode)

    @socketio.on("strategy_apply")
    def on_strategy_apply(payload):
        from flask import request
        try:
            strategy_id, symbol, tf, mode, params = _parse_strategy_payload(payload)
        except (ValidationError, TypeError, ValueError) as e:
            socketio.emit("strategy_error", {"event": "strategy_apply", "message": str(e)}, to=request.sid)
            return
        try:
            strategy_mgr.apply(request.sid, strategy_id, symbol, tf, mode, params)
        except Exception as e:
            log.exception("strategy_apply failed")
            socketio.emit("strategy_error", {"event": "strategy_apply", "strategy_id": strategy_id, "message": str(e)}, to=request.sid)

    return app, socketio


if __name__ == "__main__":
    app, socketio = create_app()
    log.info("Quantlab backend listening on http://%s:%d", HOST, PORT)
    socketio.run(app, host=HOST, port=PORT, debug=False, allow_unsafe_werkzeug=True)
