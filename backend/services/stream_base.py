"""
Common interface for any candle stream (live or backtest).

A stream owns one background thread and pushes candle dicts to a callback.
Keeping the interface symmetrical lets socket_manager treat both modes
identically.
"""
from threading import Event, Thread
from typing import Callable, Dict


class CandleStream:
    def __init__(self, symbol: str, timeframe: str, on_update: Callable[[Dict], None]):
        self.symbol = symbol
        self.timeframe = timeframe
        self.on_update = on_update
        self._stop = Event()
        self._thread: Thread | None = None

    # ---- lifecycle -----------------------------------------------------
    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._stop.clear()
        self._thread = Thread(target=self._run, name=self._name(), daemon=True)
        self._thread.start()

    def stop(self):
        self._stop.set()

    def is_running(self) -> bool:
        return self._thread is not None and self._thread.is_alive()

    # ---- subclass hooks ------------------------------------------------
    def _run(self):
        raise NotImplementedError

    def _name(self) -> str:
        return f"{self.__class__.__name__}({self.symbol}/{self.timeframe})"
