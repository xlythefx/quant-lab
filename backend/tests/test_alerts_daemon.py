"""The headless runner: warm-up + force flat, restore, the stale rule, refresh, status."""
import json
import time

import numpy as np
import pytest

from conftest import make_rule
from services import alerts_daemon, live_alerter, live_alerts_config
from services.live import live_store
from services.strategies.base import Signal, Strategy
from services.strategy_registry import get_strategy_class, list_strategies

H = 3600


def _bars(n: int, period: int = H, seed: int = 7, end_fresh: bool = True) -> list[dict]:
    """n closed bars; the last one closed within one period of now (fresh).
    Choppy random walk so the strategies actually open/close trades."""
    rng = np.random.default_rng(seed)
    last_open = (int(time.time()) // period) * period - period
    first = last_open - (n - 1) * period
    if not end_fresh:
        first -= 5 * period
    price, out = 100.0, []
    for i in range(n):
        drift = -0.004 * (price - 100.0)                    # pulls back to 100 -> mean reversion trades
        price = max(1.0, price * (1 + drift + rng.normal(0, 0.012)))
        o = price * (1 + rng.normal(0, 0.002))
        hi, lo = max(o, price) * (1 + abs(rng.normal(0, 0.004))), min(o, price) * (1 - abs(rng.normal(0, 0.004)))
        out.append({"time": first + i * period, "open": o, "high": hi, "low": lo, "close": price,
                    "volume": float(rng.uniform(50, 150)), "isClosed": True})
    return out


@pytest.fixture
def dispatched(monkeypatch):
    sent = []
    monkeypatch.setattr(live_alerter, "dispatch_for_rule",
                        lambda rule, symbol, sig: sent.append((sig.side, sig.kind, sig.time)))
    return sent


# ---- 3b: every live strategy is FLAT after warm-up + reset ---------------------------

ACTIVE = [d["id"] for d in list_strategies() if not d["archived"]]

# Shorter lookbacks / wider windows where a strategy would otherwise never trade
# inside ~900 synthetic hourly bars (rule params are legit per-deployment input).
_TEST_PARAMS = {
    "rsi2_reversion": {"sma_period": 10, "rsi_oversold": 50},
    "donchian_breakout": {"sma_daily_length": 10},
    "donchian_breakout_eod": {"sma_daily_length": 10},
    "donchian_breakout_eod_insample": {"sma_daily_length": 10},
    "opening_range_breakout": {
        "or_session": {"open": {"enabled": True, "start": "13:00", "end": "14:00"}},
        "entry_session": {"entry": {"enabled": True, "start": "14:00", "end": "20:00"}},
    },
}
# rsi2 only buys pullbacks in an uptrend, so its series needs an upward drift.
_TEST_SERIES = {"rsi2_reversion": {"drift": 0.002}}


def _swing_bars(n: int = 900, seed: int = 3, drift: float = 0.0) -> list[dict]:
    """Hourly bars with trending swings + noise, and a 1h break each day so the
    session-based (futures-style) strategies see daily sessions too."""
    rng = np.random.default_rng(seed)
    t = 1_700_000_000 - 1_700_000_000 % 86400
    logp, out = np.log(100.0), []
    for i in range(n):
        trend = 0.010 * np.sin(2 * np.pi * i / 120) + 0.006 * np.sin(2 * np.pi * i / 31)
        logp += drift + trend * 0.15 + rng.normal(0, 0.009)
        c = float(np.exp(logp))
        o = c * float(np.exp(rng.normal(0, 0.003)))
        hi = max(o, c) * float(np.exp(abs(rng.normal(0, 0.005))))
        lo = min(o, c) * float(np.exp(-abs(rng.normal(0, 0.005))))
        vol = float(rng.uniform(50, 150) * (3 if rng.random() < 0.1 else 1))
        out.append({"time": t, "open": o, "high": hi, "low": lo, "close": c, "volume": vol, "isClosed": True})
        t += H if (i + 1) % 23 else 2 * H     # session break at 23:00 UTC
    return out


@pytest.mark.parametrize("strategy_id", ACTIVE)
def test_every_strategy_is_flat_after_warmup(strategy_id, fake_sm, dispatched):
    params = _TEST_PARAMS.get(strategy_id, {})
    cls = get_strategy_class(strategy_id)
    series = _swing_bars(**_TEST_SERIES.get(strategy_id, {}))

    # End the warm-up on a bar where the strategy HOLDS a position — the case that
    # matters: the replay leaves it inside a trade the broker never received.
    probe, probe_state, cut = cls(params), {}, None
    for i, bar in enumerate(series):
        probe.on_candle(bar, probe_state)
        if probe_state.get("pos"):
            cut = i
            break
    assert cut is not None, f"{strategy_id} never opened a position on the test data (test would prove nothing)"

    runner = alerts_daemon._HeadlessRunner(make_rule(strategy_id=strategy_id, params=params), fake_sm)
    runner.strategy = cls(params)
    runner._warm_up(series[:cut + 1])

    st = runner._state
    assert not st.get("pos"), f"{strategy_id} still thinks it holds pos={st.get('pos')}"
    for counter in ("count", "rungs", "n_filled"):
        assert not st.get(counter), f"{strategy_id}: {counter}={st.get(counter)} after reset"
    assert dispatched == []                       # warm-up never sends anything
    assert runner._last_bar == series[cut]["time"]

    # Starting flat means the first thing it can ever do is ENTER, never EXIT.
    for bar in series[cut + 1:cut + 400]:
        out = alerts_daemon._as_list(runner.strategy.on_candle(bar, runner._state))
        if out:
            assert out[0].kind == "entry", f"{strategy_id} exited a position it never opened"
            break


# ---- a scripted strategy for the deterministic tests ---------------------------------

class Scripted(Strategy):
    """Signals on chosen bar times; tracks the bars it saw. pos follows its signals."""
    script: dict = {}
    seen: list = []

    def on_candle(self, candle, state):
        Scripted.seen.append(candle["time"])
        state["n"] = state.get("n", 0) + 1
        sigs = Scripted.script.get(candle["time"], [])
        for s in sigs:
            state["pos"] = (1 if s.side == "long" else -1) if s.kind == "entry" else 0
        return list(sigs) or None

    def vectorized(self, df):
        return df


@pytest.fixture
def scripted(monkeypatch, fake_sm):
    Scripted.script, Scripted.seen = {}, []
    monkeypatch.setattr(alerts_daemon, "get_strategy_class", lambda sid: Scripted)
    monkeypatch.setattr(alerts_daemon, "validate_rule", lambda rule: [])
    runner = alerts_daemon._HeadlessRunner(make_rule(), fake_sm)
    runner.strategy = Scripted({})
    return runner


def _sig(side, kind, t):
    return Signal(side=side, kind=kind, price=100.0, time=t)


def test_fresh_start_warms_silently_then_forces_flat(scripted, dispatched):
    bars = _bars(50)
    Scripted.script = {bars[10]["time"]: [_sig("long", "entry", bars[10]["time"])]}
    scripted._warm_up(bars)
    assert dispatched == []
    assert scripted._state["pos"] == 0 and scripted._state["n"] == 50
    saved = json.load(open(scripted._path))
    assert saved["last_bar"] == bars[-1]["time"] and saved["key"] == alerts_daemon.state_key(scripted.rule)


def test_restore_feeds_only_newer_bars_and_keeps_the_position(scripted, dispatched):
    bars = _bars(30)
    cut = bars[24]["time"]                                   # last bar processed before the restart
    alerts_daemon.atomic_write_json(scripted._path, {
        "key": scripted._key, "rule_name": scripted.name, "last_bar": cut,
        "state": {"pos": 1, "n": 999},
    })
    exit_t = bars[-1]["time"]
    Scripted.script = {exit_t: [_sig("long", "exit", exit_t)]}
    scripted._warm_up(bars)
    assert Scripted.seen == [b["time"] for b in bars[25:]]   # only the 5 unseen bars
    assert scripted._state["n"] == 1004                       # restored, not rebuilt
    assert dispatched == [("long", "exit", exit_t)]           # the remembered position gets its exit


def test_params_change_discards_saved_state(scripted, dispatched):
    alerts_daemon.atomic_write_json(scripted._path, {
        "key": "something-else", "rule_name": scripted.name, "last_bar": 1, "state": {"pos": 1}})
    scripted._warm_up(_bars(10))
    assert scripted._state["pos"] == 0 and scripted._state["n"] == 10
    kinds = [a["detail"] for a in live_store.get_activity(20)]
    assert any("settings changed while the strategy held a LONG" in d for d in kinds)


def test_stale_rule_entry_dropped_exit_sent_fresh_entry_sent(scripted, dispatched):
    bars = _bars(12)
    t_old_entry, t_old_exit, t_fresh = bars[3]["time"], bars[6]["time"], bars[-1]["time"]
    Scripted.script = {
        t_old_entry: [_sig("long", "entry", t_old_entry)],   # stale entry -> dropped
        t_old_exit: [_sig("short", "exit", t_old_exit)],     # stale exit -> still sent
        t_fresh: [_sig("long", "entry", t_fresh)],           # fresh -> sent
    }
    scripted._last_bar = bars[0]["time"]
    for bar in bars[1:]:
        scripted._process(bar)

    assert dispatched == [("short", "exit", t_old_exit), ("long", "entry", t_fresh)]
    missed = [a for a in live_store.get_activity(50) if a["kind"] == "missed"]
    assert len(missed) == 1 and missed[0]["action"] == "BUY" and "missed (stale)" in missed[0]["detail"]
    assert scripted._state["pos"] == 1                        # the fresh entry, not the dropped one


def test_dropped_stale_entry_resets_strategy_to_flat(scripted, dispatched):
    bars = _bars(5)
    t = bars[1]["time"]
    Scripted.script = {t: [_sig("long", "entry", t)]}
    scripted._last_bar = bars[0]["time"]
    scripted._process(bars[1])
    assert dispatched == [] and scripted._state["pos"] == 0


def test_live_bar_gap_is_backfilled(monkeypatch, scripted, dispatched):
    bars = _bars(6)
    scripted._last_bar = bars[0]["time"]
    calls = []

    def fake_fetch(symbol, tf, limit=500, start_time=None):
        calls.append(start_time)
        return [b for b in bars if b["time"] >= start_time]

    monkeypatch.setattr(alerts_daemon, "fetch_closed_klines", fake_fetch)
    scripted._listener = scripted._on_feed
    scripted._on_feed(dict(bars[-1]))                        # 4 bars missing before this one
    assert calls[0] == bars[1]["time"]
    assert Scripted.seen == [b["time"] for b in bars[1:]]
    assert scripted._last_bar == bars[-1]["time"]


def test_reconnect_notice_triggers_backfill(monkeypatch, scripted):
    bars = _bars(4)
    scripted._last_bar = bars[0]["time"]
    monkeypatch.setattr(alerts_daemon, "fetch_closed_klines",
                        lambda s, tf, limit=500, start_time=None: [b for b in bars if b["time"] >= start_time])
    scripted._on_feed({"__event": "reconnected"})
    assert scripted._last_bar == bars[-1]["time"]


def test_duplicate_and_forming_frames_are_ignored(scripted):
    bars = _bars(3)
    scripted._last_bar = bars[1]["time"]
    scripted._on_feed(dict(bars[1]))                          # already processed
    scripted._on_feed(dict(bars[2], isClosed=False))          # still forming
    assert Scripted.seen == []


# ---- 4: any rule change restarts the runner -------------------------------------------

def test_refresh_restarts_on_any_rule_change(monkeypatch, fake_sm):
    started, stopped = [], []
    monkeypatch.setattr(alerts_daemon._HeadlessRunner, "start", lambda self: started.append(self.rule))
    monkeypatch.setattr(alerts_daemon._HeadlessRunner, "stop", lambda self: stopped.append(self.name))
    monkeypatch.setattr(alerts_daemon, "_socket_manager", fake_sm)

    live_alerts_config.save_rules([make_rule()])
    alerts_daemon.refresh()
    assert len(started) == 1

    alerts_daemon.refresh()                                   # nothing changed -> no restart
    assert len(started) == 1 and stopped == []

    rules = live_alerts_config.load_rules()
    rules[0]["webhook_url"] = "https://other.invalid/hook"   # NOT a param change
    live_alerts_config.save_rules(rules)
    alerts_daemon.refresh()
    assert stopped == ["test-rule"] and len(started) == 2
    assert started[-1]["webhook_url"] == "https://other.invalid/hook"

    rules[0]["leverage"] = 3
    live_alerts_config.save_rules(rules)
    alerts_daemon.refresh()
    assert len(started) == 3

    rules[0]["enabled"] = False
    live_alerts_config.save_rules(rules)
    alerts_daemon.refresh()
    assert stopped == ["test-rule"] * 3 and alerts_daemon._runners == {}


def test_start_failure_is_recorded_as_error(monkeypatch, fake_sm):
    monkeypatch.setattr(alerts_daemon, "validate_rule", lambda rule: ["symbol FOO is not a trading pair"])
    runner = alerts_daemon._HeadlessRunner(make_rule(), fake_sm)
    try:
        runner._start_once()
    except ValueError as e:
        runner._fail(f"start failed: {e}")
    alerts_daemon._runners[runner.name] = runner
    st = alerts_daemon.deployment_status(runner.rule)
    assert st["status"] == "ERROR" and "FOO" in st["detail"]


# ---- 5: honest status ------------------------------------------------------------------

def test_deployment_status_reflects_reality(fake_sm):
    rule = make_rule()
    assert alerts_daemon.deployment_status(dict(rule, enabled=False))["status"] == "PAUSED"
    assert alerts_daemon.deployment_status(rule)["status"] == "ERROR"      # no runner at all

    runner = alerts_daemon._HeadlessRunner(rule, fake_sm)
    alerts_daemon._runners[rule["name"]] = runner
    assert alerts_daemon.deployment_status(rule)["status"] == "STARTING"   # grace period

    runner._listener = runner._on_feed
    runner.health.update(phase="live", last_closed_bar_time=_bars(1)[0]["time"])
    st = alerts_daemon.deployment_status(rule)
    assert st["status"] == "RUNNING" and st["health"]["feed_connected"] is True

    runner.health["started_at"] -= 3600                                    # past the grace period
    fake_sm.stream.connected = False
    assert alerts_daemon.deployment_status(rule)["status"] == "STALE"

    fake_sm.stream.connected = True
    runner.health["last_closed_bar_time"] -= 5 * H                         # bars stopped arriving
    st = alerts_daemon.deployment_status(rule)
    assert st["status"] == "STALE" and "no closed bar since" in st["detail"]

    runner._fail("on_candle error: boom")
    assert alerts_daemon.deployment_status(rule)["status"] == "ERROR"
