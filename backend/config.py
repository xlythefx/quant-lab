"""
Quantlab — global configuration constants.

Keep this file dependency-free so any module can import it without side effects.
"""
import os

SUPPORTED_SYMBOLS = ["BTCUSDT", "FETUSDT"]
# Standard timeframes plus the bespoke minutes the imported MultiCharts futures
# strategies use (6/10/12/23/46m — see docs/txt-strategies/). Sources that can't
# fetch an odd interval natively (Binance/CCXT) resample it from 1m; Databento
# and Dukascopy resample it in their adapters.
TIMEFRAMES = ["1m", "3m", "5m", "6m", "10m", "12m", "15m", "23m", "30m", "46m", "1h", "2h", "4h", "1d"]
MODES = ["backtest", "live"]
DEFAULT_MODE = "backtest"

HISTORY_LIMIT = 500
MAX_HISTORY_LIMIT = 1500

BINANCE_WS_BASE = "wss://stream.binance.com:9443/ws"

# Local Parquet cache for backtest replay.
_BACKEND_DIR = os.path.dirname(os.path.abspath(__file__))
_REPO_ROOT = os.path.dirname(_BACKEND_DIR)
DATA_DIR = os.path.join(_BACKEND_DIR, "data")

# Skills catalog (backend/skills/*.md — one runnable AI "skill" per file) and the
# AI-generated research output it produces (docs/research/*.md). Research output is
# kept separate from the human-authored EasyLanguage corpus in docs/txt-strategies/.
SKILLS_DIR = os.path.join(_BACKEND_DIR, "skills")
RESEARCH_DIR = os.path.join(_REPO_ROOT, "docs", "research")
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
    "3m": 180,
    "5m": 300,
    "6m": 360,
    "10m": 600,
    "12m": 720,
    "15m": 900,
    "23m": 1380,
    "30m": 1800,
    "46m": 2760,
    "1h": 3600,
    "2h": 7200,
    "4h": 14400,
    "1d": 86400,
}
