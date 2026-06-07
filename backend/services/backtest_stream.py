"""
Backtest replay stream.

Reads cached Parquet for (symbol, timeframe) and emits candles on a timer
to mimic the cadence of a live feed. Strategies/UI consume the SAME shape
as live streams.

Speed: real-seconds-per-candle = TIMEFRAME_SECONDS[tf] / speed.
  speed=60 + tf=1m -> one new candle every 1 real second.
  speed=300 + tf=1m -> 5 candles/sec.

For UI symmetry with live we emit two events per candle:
  1. forming tick (isClosed=False) immediately
  2. closed tick (isClosed=True) after the sleep
We don't have intra-candle data, so OHLC values are identical between the
two events for the same bar.

Loops back to the start when the file is exhausted (so the demo never
goes silent).
"""
import time
import logging
from typing import Callable, Dict

from config import TIMEFRAME_SECONDS, BACKTEST_DEFAULT_SPEED, BACKTEST_MAX_SPEED
from services.market_data import load_parquet, replay_start_index, time_to_index
from services.stream_base import CandleStream

log = logging.getLogger(__name__)


class BacktestStream(CandleStream):
    def __init__(
        self,
        symbol: str,
        timeframe: str,
        on_update: Callable[[Dict], None],
        speed: int = BACKTEST_DEFAULT_SPEED,
        start_index: int | None = None,
        start_time: int | None = None,
        end_time: int | None = None,
        loop: bool = True,
        broker: str | None = None,
    ):
        super().__init__(symbol, timeframe, on_update)
        self._speed = max(1, min(int(speed), BACKTEST_MAX_SPEED))
        self._start_index = start_index
        self._start_time = start_time
        self._end_time = end_time
        self._loop = bool(loop)
        self.broker = broker

    def set_speed(self, speed: int):
        self._speed = max(1, min(int(speed), BACKTEST_MAX_SPEED))
        log.info("[%s] speed -> %dx", self._name(), self._speed)

    def _sleep_per_candle(self) -> float:
        return TIMEFRAME_SECONDS[self.timeframe] / self._speed

    def _run(self):
        try:
            df = load_parquet(self.symbol, self.timeframe, broker=self.broker)
        except Exception as e:
            log.exception("[%s] failed to load parquet: %s", self._name(), e)
            self.on_update({"__stream_error": True, "message": str(e)})
            return

        if df.empty:
            log.warning("[%s] empty parquet, nothing to replay", self._name())
            self.on_update({"__stream_error": True, "message": f"No data for {self.symbol}/{self.timeframe}"})
            return

        rows = df.to_dict(orient="records")
        n = len(rows)

        # Resolve start: explicit index → start_time → default replay pct.
        if self._start_index is not None:
            start_idx = self._start_index
        elif self._start_time is not None:
            start_idx = time_to_index(self.symbol, self.timeframe, self._start_time, side="left", broker=self.broker)
        else:
            _, start_idx = replay_start_index(self.symbol, self.timeframe, broker=self.broker)
        start_idx = max(0, min(start_idx, n - 1))

        # Resolve end (inclusive).
        if self._end_time is not None:
            end_idx = time_to_index(self.symbol, self.timeframe, self._end_time, side="right", broker=self.broker)
            end_idx = max(start_idx, min(end_idx, n - 1))
        else:
            end_idx = n - 1

        idx = start_idx
        log.info("[%s] starting replay [%d..%d]/%d speed=%dx loop=%s",
                 self._name(), start_idx, end_idx, n, self._speed, self._loop)

        while not self._stop.is_set():
            row = rows[idx]
            base = {
                "time": int(row["time"]),
                "open": float(row["open"]),
                "high": float(row["high"]),
                "low": float(row["low"]),
                "close": float(row["close"]),
                "volume": float(row["volume"]),
                "mode": "backtest",
                "symbol": self.symbol,
                "timeframe": self.timeframe,
            }

            # Forming tick.
            self.on_update({**base, "isClosed": False})

            # Sleep for the simulated bar duration, then emit the closed tick.
            self._stop.wait(self._sleep_per_candle())
            if self._stop.is_set():
                break
            self.on_update({**base, "isClosed": True})

            idx += 1
            if idx > end_idx:
                if self._loop:
                    log.info("[%s] reached end of window, looping", self._name())
                    idx = start_idx
                else:
                    log.info("[%s] reached end of window, stopping", self._name())
                    return
