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

import json
import logging
import math
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd

from services import event_bus, market_data, risk_config, backtest_engine
from services.strategies.base import Signal

_LIVE_STATE_DIR = Path(__file__).parent.parent / "data" / "live_state"

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


def _emit_signal(strategy_id: str, sid: str, sig: Signal, *,
                 symbol: str | None = None, mode: str | None = None):
    event_bus.emit("signal_update", {
        "strategy_id": strategy_id,
        "time": int(sig.time),
        "side": sig.side,
        "kind": sig.kind,
        "price": float(sig.price),
        "reason": sig.reason,
    }, to=sid)
    if mode == "live" and symbol:
        # Local import — avoids a hard dependency cycle and keeps backtest
        # imports clean if the alerter ever pulls in something heavier.
        from services import live_alerter
        live_alerter.dispatch(strategy_id, symbol, sig)


# ---------------------------------------------------------------------------
# VectorizedRunner — backtest
# ---------------------------------------------------------------------------

class VectorizedRunner:
    def __init__(self, sid: str, strategy_id: str, strategy, symbol: str,
                 timeframe: str, socket_manager, broker: str | None = None):
        self.sid = sid
        self.strategy_id = strategy_id
        self.strategy = strategy
        self.symbol = symbol
        self.timeframe = timeframe
        self.broker = broker
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
        df = market_data.load_parquet(self.symbol, self.timeframe, broker=self.broker)
        # Backtest replay starts mid-file (~70%). Trim the simulation to
        # match so equity starts at 100% at the replay cursor — otherwise
        # the curve would start at whatever value the precompute reached
        # over the unseen history, which is confusing.
        _, start_idx = market_data.replay_start_index(self.symbol, self.timeframe, broker=self.broker)
        start_ts = int(df.iloc[start_idx]["time"])

        # Delegate the backtest math to backtest_engine.run() — pyramiding,
        # tranche accounting, fees, slippage, and ATR stops live there. The
        # runner is now a thin adapter that streams those precomputed
        # results in lockstep with the candle replay, so dashboard numbers
        # match Walk-Forward / Grid / Monte Carlo / Cost Sweep exactly.
        result = backtest_engine.run(
            self.strategy_id, self.symbol, self.timeframe, dict(self.strategy.p),
            start_time=start_ts, broker=self.broker,
        )
        equity_curve = result.get("equity") or []
        trades = result.get("trades") or []

        n = len(equity_curve)
        self._equity = [100.0] * n
        self._dd = [0.0] * n
        self._trades_running = [0] * n
        self._wins_running = [0] * n
        self._time_to_idx = {}
        for i, pt in enumerate(equity_curve):
            ts = int(pt["time"])
            self._time_to_idx[ts] = i
            # `value` is normalized to 100 = starting capital (par).
            self._equity[i] = float(pt.get("value", 100.0))
            self._dd[i] = float(pt.get("drawdown", 0.0))

        # Bucket trades by exit timestamp; with pyramiding, multiple
        # tranches can close on the same bar.
        exits_at: dict[int, list[dict]] = {}
        for tr in trades:
            exits_at.setdefault(int(tr["exit_time"]), []).append(tr)

        cum_trades = 0
        cum_wins = 0
        for i, pt in enumerate(equity_curve):
            ts = int(pt["time"])
            for tr in exits_at.get(ts, ()):
                cum_trades += 1
                if float(tr.get("pnl_dollars", 0.0)) > 0.0:
                    cum_wins += 1
            self._trades_running[i] = cum_trades
            self._wins_running[i] = cum_wins

        # Per-bar signals and the streaming trade payload. Multiple trades
        # per bar are stored in a list and streamed sequentially in
        # _on_candle so each gets its entry/exit markers + win/loss coloring.
        self._signals_at = {}
        self._trade_at = {}
        for tr in trades:
            et = int(tr["entry_time"])
            xt = int(tr["exit_time"])
            side = tr["side"]
            self._signals_at.setdefault(et, []).append(
                Signal(side=side, kind="entry", price=float(tr["entry_price"]),
                       time=et, reason="")
            )
            self._signals_at.setdefault(xt, []).append(
                Signal(side=side, kind="exit", price=float(tr["exit_price"]),
                       time=xt, reason="")
            )
            self._trade_at.setdefault(xt, []).append({
                "side": side,
                "entry_price": float(tr["entry_price"]),
                "exit_price": float(tr["exit_price"]),
                "entry_time": et,
                "exit_time": xt,
                "pnl_pct": float(tr.get("pnl_pct_equity", tr.get("pnl_pct", 0.0))),
                "pnl_dollars": float(tr.get("pnl_dollars", 0.0)),
            })

        # Overlay arrays for streaming. Spec metadata is sent ONCE; values
        # stream per replayed candle. Re-extract from a vectorized pass over
        # the trimmed df — cheap, and avoids leaking sig_df from the engine.
        sig_df = self.strategy.vectorized(df.iloc[start_idx:].reset_index(drop=True))
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

        # Subscribe to the backtest stream so we can emit equity in lockstep.
        def listener(candle):
            self._on_candle(candle)
        self._listener = listener
        self._sm.add_listener("backtest", self.symbol, self.timeframe, listener, broker=self.broker)

        rc = result.get("risk_config") or {}
        log.info("[%s] vectorized precompute done (%d bars, %d trades, "
                 "pyramiding=%s, %d overlay series)",
                 self.strategy_id, n, len(trades),
                 self.strategy.p.get("pyramiding", rc.get("pyramiding", 1)),
                 len(overlay_specs))

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

        # With pyramiding, multiple trades can close on the same bar. Emit
        # one equity_update per closed trade so the frontend's marker
        # handler sees each one. The equity/dd/cum-count values are the
        # bar's terminal state and identical across emits — the chart
        # point at this ts is idempotent.
        trades_here = self._trade_at.get(ts) or []
        if not trades_here:
            _emit_equity(
                self.strategy_id, self.sid, ts,
                self._equity[idx], self._dd[idx],
                self._trades_running[idx], self._wins_running[idx],
                trade=None,
            )
        else:
            for tr in trades_here:
                _emit_equity(
                    self.strategy_id, self.sid, ts,
                    self._equity[idx], self._dd[idx],
                    self._trades_running[idx], self._wins_running[idx],
                    trade=tr,
                )

    def stop(self):
        if self._listener:
            self._sm.remove_listener("backtest", self.symbol, self.timeframe, self._listener, broker=self.broker)
            self._listener = None


# ---------------------------------------------------------------------------
# LiveRunner — live mode
# ---------------------------------------------------------------------------

class LiveRunner:
    def __init__(self, sid: str, strategy_id: str, strategy, symbol: str,
                 timeframe: str, socket_manager, broker: str | None = None):
        self.sid = sid
        self.strategy_id = strategy_id
        self.broker = broker
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
        self._state_path = (
            _LIVE_STATE_DIR / f"{strategy_id}_{symbol}_{timeframe}.json"
        )
        self._load_state()

    def _load_state(self):
        try:
            if self._state_path.exists():
                with open(self._state_path) as f:
                    saved = json.load(f)
                self._state  = saved.get("strategy_state", {})
                self._equity = float(saved.get("equity", 100.0))
                self._peak   = float(saved.get("peak",   100.0))
                self._trades = int(saved.get("trades", 0))
                self._wins   = int(saved.get("wins",   0))
                self._open   = saved.get("open")
                log.info("[%s] live state loaded from %s", self.strategy_id, self._state_path)
        except Exception as e:
            log.warning("[%s] failed to load live state: %s", self.strategy_id, e)

    def _save_state(self):
        try:
            _LIVE_STATE_DIR.mkdir(parents=True, exist_ok=True)
            with open(self._state_path, "w") as f:
                json.dump({
                    "strategy_state": self._state,
                    "equity": self._equity,
                    "peak":   self._peak,
                    "trades": self._trades,
                    "wins":   self._wins,
                    "open":   self._open,
                }, f)
        except Exception as e:
            log.warning("[%s] failed to save live state: %s", self.strategy_id, e)

    def start(self):
        def listener(candle):
            self._on_candle(candle)
        self._listener = listener
        self._sm.add_listener("live", self.symbol, self.timeframe, listener, broker=self.broker)

    def _on_candle(self, candle):
        sig = self.strategy.on_candle(candle, self._state)
        if sig is None:
            return
        _emit_signal(self.strategy_id, self.sid, sig, symbol=self.symbol, mode="live")

        # risk_pct is per-strategy (lives on each strategy's PARAM_SCHEMA).
        risk_pct = float(self.strategy.p.get("risk_pct", 3.0)) / 100.0
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
        self._save_state()

    def stop(self):
        if self._listener:
            self._sm.remove_listener("live", self.symbol, self.timeframe, self._listener, broker=self.broker)
            self._listener = None
