"""
Drift Check (services/drift_check.py) on synthetic coins, fully offline:

  - coins whose gap with the anchor drifts in streaks read "keeps going", coins whose
    gap is pulled back read "snaps back", and unrelated noise reads neither;
  - the sealed months cannot leak: research results are identical with or without them;
  - the holdout opens once, with the settings frozen in the log.
"""
from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest

from services import drift_check as dc
from services import pair_check as pc

T0 = 1704067200                   # Jan 01, 2024; the seal (Nov 06, 2025) falls inside
N = 24 * 730                      # two years of 1h bars
COINS = [f"C{k}USDT" for k in range(8)]
P = {"coins": COINS, "window_days": 30, "entry_z": 2, "cooldown_hours": 24, "min_events": 5}


def _frame(t, logp):
    c = np.exp(logp)
    return pd.DataFrame({"time": t, "open": np.r_[c[0], c[:-1]], "high": c, "low": c, "close": c})


def _market(kind: str, seed: int = 0) -> dict:
    rng = np.random.default_rng(seed)
    t = T0 + np.arange(N) * 3600
    lx = 10 + np.cumsum(rng.normal(0, 0.006, N))
    out = {"BTCUSDT": _frame(t, lx)}
    for sym in COINS:
        if kind == "streaks":       # the coin's own drift switches every 5 days
            mu = np.repeat(rng.normal(0, 0.0015, N // 120 + 1), 120)[:N]
            idio = np.cumsum(mu + rng.normal(0, 0.004, N))
        elif kind == "pulled_back":  # the gap is pulled back (half-life ~ 1 day)
            idio = np.zeros(N)
            for i in range(1, N):
                idio[i] = 0.97 * idio[i - 1] + rng.normal(0, 0.004)
        else:                        # unrelated noise
            idio = np.cumsum(rng.normal(0, 0.004, N))
        out[sym] = _frame(t, 2 + 1.1 * lx + idio)
    return out


@pytest.fixture
def market(monkeypatch, tmp_path):
    """Install a fake market; returns a setter so a test can swap the frames."""
    monkeypatch.setattr(dc, "LOG_PATH", str(tmp_path / "holdout_log.json"))
    frames = {}
    monkeypatch.setattr(pc, "_load", lambda sym, tf: (frames[sym], tf))

    def use(new):
        frames.clear()
        frames.update(new)
    return use


def test_seal_date_is_fixed_and_logged(market):
    market(_market("noise"))
    assert dc.sealed_from_ts() == 1762387200          # Nov 06, 2025 00:00 UTC
    assert json.load(open(dc.LOG_PATH))["drift_check"]["sealed_from"] == "2025-11-06"


def test_streaks_read_keeps_going(market):
    market(_market("streaks"))
    r = dc.drift_check("BTCUSDT", "1h", P)["research"]
    head = r["cells"]["1d"]["hedged"]["both"]
    assert r["verdict"]["label"] == "Drift keeps going (research data)"
    assert head["breadth_pct"] == 100 and head["t_coins"] > 3 and head["t_weeks"] > 3
    # Each coin's streaks are its own, so the anchor leg adds ~nothing.
    assert abs(r["cells"]["1d"]["anchor"]["both"]["avg_event_edge_pct"]) < 0.25 * head["avg_event_edge_pct"]


def test_pulled_back_reads_snaps_back(market):
    market(_market("pulled_back"))
    r = dc.drift_check("BTCUSDT", "1h", P)["research"]
    assert r["verdict"]["label"] == "Drift snaps back (research data)"
    assert r["cells"]["1d"]["hedged"]["both"]["avg_coin_edge_pct"] < 0


def test_noise_reads_neither(market):
    market(_market("noise", seed=4))
    r = dc.drift_check("BTCUSDT", "1h", P)["research"]
    assert r["verdict"]["label"] in ("No clear effect", "Not enough to judge")


def test_sealed_months_cannot_leak(market):
    full = _market("streaks", seed=2)
    market(full)
    a = dc.drift_check("BTCUSDT", "1h", P)["research"]
    cut = dc.sealed_from_ts()
    market({s: f[f["time"] < cut] for s, f in full.items()})
    b = dc.drift_check("BTCUSDT", "1h", P)["research"]
    assert json.dumps(a, sort_keys=True) == json.dumps(b, sort_keys=True)
    assert a["last_time"] < cut


def test_holdout_opens_once_with_frozen_settings(market):
    market(_market("streaks", seed=3))
    assert dc.holdout_status("BTCUSDT", "1h")["opened"] is None
    rec = dc.open_holdout("BTCUSDT", "1h", P)
    assert rec["settings"]["coins"] == COINS and rec["settings"]["entry_z"] == 2
    assert rec["result"]["period"] == "holdout"
    assert rec["result"]["first_time"] >= dc.sealed_from_ts()
    assert dc.drift_check("BTCUSDT", "1h", P)["holdout"]["opened"]["opened_at"] == rec["opened_at"]
    with pytest.raises(ValueError, match="only opens once"):
        dc.open_holdout("BTCUSDT", "1h", {**P, "entry_z": 3})
    # The other timeframe is a separate seal.
    assert dc.holdout_status("BTCUSDT", "5m")["opened"] is None
