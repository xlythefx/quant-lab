"""
Strategy runners — one per (sid, strategy_id, symbol, tf, mode).

Two flavors:
  VectorizedRunner — backtest. Precomputes signals on the full parquet
    once, then emits equity/marker updates as the replay cursor advances.
  LiveRunner       — live. Calls strategy.on_candle() per closed bar,
    maintains state in memory, emits incrementally.

Both emit identical event shapes:
  equity_update {strategy_id, time, equity, drawdown, trades_count, win_rate}
  signal_update {strategy_id, time, side, kind, price, reason}
"""
from __future__ import annotations

import logging
import math
from typing import Optional

import numpy as np
import pandas as pd

from services import event_bus, market_data
from services.strategies.base import Signal

log = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _emit_equity(strategy_id: str, sid: str, ts: int, equity: float,
                 drawdown: float, trades: int, wins: int,
                 trade: Optional[dict] = None):
    payload = {
        "strategy_id": strategy_id,
        "time": int(ts),
        "equity": float(equity),
        "drawdown": float(drawdown),
        "trades": int(trades),
        "win_rate": (float(wins) / trades) if trades > 0 else 0.0,
    }
    if trade is not None:
        payload["trade"] = trade
    event_bus.emit("equity_update", payload, to=sid)


def _emit_signal(strategy_id: str, sid: str, sig: Signal):
    event_bus.emit("signal_update", {
        "strategy_id": strategy_id,
        "time": int(sig.time),
        "side": sig.side,
        "kind": sig.kind,
        "price": float(sig.price),
        "reason": sig.reason,
    }, to=sid)


# ---------------------------------------------------------------------------
# VectorizedRunner — backtest
# ---------------------------------------------------------------------------

class VectorizedRunner:
    def __init__(self, sid: str, strategy_id: str, strategy, symbol: str,
                 timeframe: str, socket_manager):
        self.sid = sid
        self.strategy_id = strategy_id
        self.strategy = strategy
        self.symbol = symbol
        self.timeframe = timeframe
        self._sm = socket_manager
        self._listener = None
        # Precomputed once at start():
        self._time_to_idx: dict[int, int] = {}
        self._equity: list[float] = []
        self._dd: list[float] = []
        self._trades_running: list[int] = []
        self._wins_running: list[int] = []
        self._signals_at: dict[int, list[Signal]] = {}
        self._trade_at: dict[int, dict] = {}
        self._max_idx_emitted = -1
        # overlay arrays: key -> list[float | None] aligned to time_to_idx
        self._overlays: dict[str, list] = {}

    def start(self):
        df = market_data.load_parquet(self.symbol, self.timeframe)
        # Backtest replay starts mid-file (~70%). Trim the simulation to
        # match so equity starts at 100% at the replay cursor — otherwise
        # the curve would start at whatever value the precompute reached
        # over the unseen history, which is confusing.
        _, start_idx = market_data.replay_start_index(self.symbol, self.timeframe)
        sig_df = self.strategy.vectorized(df.iloc[start_idx:].reset_index(drop=True))

        # Walk forward, simulate fills at close, % equity sizing, compound.
        n = len(sig_df)
        equity = 100.0           # equity in percent terms
        peak = equity
        trades_count = 0
        wins = 0

        equity_arr = np.full(n, np.nan)
        dd_arr = np.full(n, 0.0)
        trades_arr = np.zeros(n, dtype=int)
        wins_arr = np.zeros(n, dtype=int)

        # risk_pct in PARAM_SCHEMA is a percent (1.0 = 1%); convert to fraction.
        risk_pct = float(self.strategy.p.get("risk_pct", 1.0)) / 100.0

        pos = 0          # 1 long, -1 short, 0 flat
        entry_price = np.nan
        entry_size = 0.0      # in "equity %" terms
        entry_time = 0

        time_a = sig_df["time"].to_numpy()
        close_a = sig_df["close"].to_numpy(dtype=float)
        el = sig_df["entry_long"].to_numpy()
        es = sig_df["entry_short"].to_numpy()
        xl = sig_df["exit_long"].to_numpy()
        xs = sig_df["exit_short"].to_numpy()

        signals_at = self._signals_at
        trade_at = self._trade_at

        for t in range(n):
            ts = int(time_a[t])
            self._time_to_idx[ts] = t
            c = close_a[t]

            # Process exits before entries (the strategy guarantees they
            # don't fire on the same bar, but be safe).
            if pos == 1 and xl[t]:
                pnl_pct = (c - entry_price) / entry_price * entry_size * 100.0
                equity += pnl_pct
                trades_count += 1
                if pnl_pct > 0: wins += 1
                signals_at.setdefault(ts, []).append(
                    Signal(side="long", kind="exit", price=float(c), time=ts, reason="")
                )
                trade_at[ts] = {
                    "side": "long", "entry_price": float(entry_price),
                    "exit_price": float(c), "entry_time": int(entry_time),
                    "exit_time": int(ts), "pnl_pct": float(pnl_pct),
                }
                pos = 0
                entry_price = np.nan
                entry_size = 0.0

            elif pos == -1 and xs[t]:
                pnl_pct = (entry_price - c) / entry_price * entry_size * 100.0
                equity += pnl_pct
                trades_count += 1
                if pnl_pct > 0: wins += 1
                signals_at.setdefault(ts, []).append(
                    Signal(side="short", kind="exit", price=float(c), time=ts, reason="")
                )
                trade_at[ts] = {
                    "side": "short", "entry_price": float(entry_price),
                    "exit_price": float(c), "entry_time": int(entry_time),
                    "exit_time": int(ts), "pnl_pct": float(pnl_pct),
                }
                pos = 0
                entry_price = np.nan
                entry_size = 0.0

            if pos == 0:
                if el[t]:
                    pos = 1
                    entry_price = c
                    entry_size = risk_pct
                    entry_time = ts
                    signals_at.setdefault(ts, []).append(
                        Signal(side="long", kind="entry", price=float(c), time=ts, reason="")
                    )
                elif es[t]:
                    pos = -1
                    entry_price = c
                    entry_size = risk_pct
                    entry_time = ts
                    signals_at.setdefault(ts, []).append(
                        Signal(side="short", kind="entry", price=float(c), time=ts, reason="")
                    )

            peak = max(peak, equity)
            dd = (equity - peak) / peak * 100.0 if peak > 0 else 0.0
            equity_arr[t] = equity
            dd_arr[t] = dd
            trades_arr[t] = trades_count
            wins_arr[t] = wins

        self._equity = equity_arr.tolist()
        self._dd = dd_arr.tolist()
        self._trades_running = trades_arr.tolist()
        self._wins_running = wins_arr.tolist()

        # Build per-bar overlay arrays for streaming. Spec metadata is sent
        # ONCE; values are streamed per replayed candle so the chart's
        # overlay range stays in lockstep with the candle range (no auto-fit
        # zoom-out that crushes the candles).
        overlay_specs = []
        for ov in getattr(self.strategy, "OVERLAYS", []):
            if ov.from_column not in sig_df.columns:
                continue
            arr = sig_df[ov.from_column].astype(float).to_numpy()
            self._overlays[ov.key] = arr
            overlay_specs.append(ov.to_dict())
        if overlay_specs:
            event_bus.emit("indicator_init", {
                "strategy_id": self.strategy_id,
                "symbol": self.symbol,
                "timeframe": self.timeframe,
                "specs": overlay_specs,
            }, to=self.sid)

        # Diagnostic so missing trades is debuggable from the backend log.
        n_long = int(sig_df["entry_long"].sum())
        n_short = int(sig_df["entry_short"].sum())

        # Subscribe to the backtest stream so we can emit equity in lockstep.
        def listener(candle):
            self._on_candle(candle)
        self._listener = listener
        self._sm.add_listener("backtest", self.symbol, self.timeframe, listener)
        log.info("[%s] vectorized precompute done (%d bars, %d trades, "
                 "long=%d short=%d, %d overlay series)",
                 self.strategy_id, n, trades_count, n_long, n_short,
                 len(overlays_payload))

    def _on_candle(self, candle):
        if not bool(candle.get("isClosed", False)):
            return
        ts = int(candle["time"])
        idx = self._time_to_idx.get(ts)
        if idx is None or idx <= self._max_idx_emitted:
            return
        self._max_idx_emitted = idx

        # Emit overlay tick for this bar (skip NaN values).
        if self._overlays:
            values = {}
            for key, arr in self._overlays.items():
                v = arr[idx]
                if v is not None and math.isfinite(v):
                    values[key] = float(v)
            if values:
                event_bus.emit("indicator_tick", {
                    "strategy_id": self.strategy_id,
                    "time": ts,
                    "values": values,
                }, to=self.sid)

        # Emit any signals at this timestamp first.
        for sig in self._signals_at.get(ts, ()):
            _emit_signal(self.strategy_id, self.sid, sig)

        trade = self._trade_at.get(ts)
        _emit_equity(
            self.strategy_id, self.sid, ts,
            self._equity[idx], self._dd[idx],
            self._trades_running[idx], self._wins_running[idx],
            trade=trade,
        )

    def stop(self):
        if self._listener:
            self._sm.remove_listener("backtest", self.symbol, self.timeframe, self._listener)
            self._listener = None


# ---------------------------------------------------------------------------
# LiveRunner — live mode
# ---------------------------------------------------------------------------

class LiveRunner:
    def __init__(self, sid: str, strategy_id: str, strategy, symbol: str,
                 timeframe: str, socket_manager):
        self.sid = sid
        self.strategy_id = strategy_id
        self.strategy = strategy
        self.symbol = symbol
        self.timeframe = timeframe
        self._sm = socket_manager
        self._listener = None
        self._state: dict = {}
        self._equity = 100.0
        self._peak = 100.0
        self._trades = 0
        self._wins = 0
        self._open: Optional[dict] = None  # {side, entry_price, entry_time}

    def start(self):
        def listener(candle):
            self._on_candle(candle)
        self._listener = listener
        self._sm.add_listener("live", self.symbol, self.timeframe, listener)

    def _on_candle(self, candle):
        sig = self.strategy.on_candle(candle, self._state)
        if sig is None:
            return
        _emit_signal(self.strategy_id, self.sid, sig)

        # risk_pct in PARAM_SCHEMA is a percent (1.0 = 1%); convert to fraction.
        risk_pct = float(self.strategy.p.get("risk_pct", 1.0)) / 100.0
        ts = int(sig.time)
        trade_meta = None

        if sig.kind == "entry":
            self._open = {"side": sig.side, "entry_price": sig.price, "entry_time": ts}
        elif sig.kind == "exit" and self._open is not None:
            entry = self._open["entry_price"]
            exit_p = sig.price
            if self._open["side"] == "long":
                pnl_pct = (exit_p - entry) / entry * risk_pct * 100.0
            else:
                pnl_pct = (entry - exit_p) / entry * risk_pct * 100.0
            self._equity += pnl_pct
            self._trades += 1
            if pnl_pct > 0:
                self._wins += 1
            self._peak = max(self._peak, self._equity)
            trade_meta = {
                "side": self._open["side"], "entry_price": float(entry),
                "exit_price": float(exit_p), "entry_time": int(self._open["entry_time"]),
                "exit_time": ts, "pnl_pct": float(pnl_pct),
            }
            self._open = None

        dd = (self._equity - self._peak) / self._peak * 100.0 if self._peak > 0 else 0.0
        _emit_equity(
            self.strategy_id, self.sid, ts, self._equity, dd,
            self._trades, self._wins, trade=trade_meta,
        )

    def stop(self):
        if self._listener:
            self._sm.remove_listener("live", self.symbol, self.timeframe, self._listener)
            self._listener = None
