"""
Quantlab — global configuration constants.

Keep this file dependency-free so any module can import it without side effects.
"""
import os

SUPPORTED_SYMBOLS = ["BTCUSDT", "FETUSDT"]
TIMEFRAMES = ["1m", "5m", "15m", "1h"]
MODES = ["backtest", "live"]
DEFAULT_MODE = "backtest"

HISTORY_LIMIT = 500
MAX_HISTORY_LIMIT = 1500

BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws"

# Local Parquet cache for backtest replay.
DATA_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
BACKTEST_LOOKBACK_DAYS = 730            # ~2 years
BACKTEST_DEFAULT_SPEED = 60             # 60x realtime
BACKTEST_MAX_SPEED = 3000
BACKTEST_REPLAY_START_PCT = 0.7         # start replay at 70% of the file
BACKTEST_SEED_LIMIT = 1500              # painted history ending at the cursor

# CORS / server
STARTING_CAPITAL = 100_000.0   # USD; same baseline for every strategy/backtest

_cors_env = os.environ.get("CORS_ORIGINS", "")
CORS_ORIGINS = _cors_env.split(",") if _cors_env else "*"
HOST = "0.0.0.0"
PORT = 6173

# Timeframe -> seconds (for backtest sleep math + cache freshness checks).
TIMEFRAME_SECONDS = {
    "1m": 60,
    "5m": 300,
    "15m": 900,
    "1h": 3600,
}
