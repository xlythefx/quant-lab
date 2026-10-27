"""
Auto-detect + parallel downloader (services/market_data.py), fully offline.

What matters is that the saved file never ends up with duplicates or a hidden
hole — whether a download finishes, is cancelled half-way, or is resumed.
"""
from __future__ import annotations

import threading
import time

import numpy as np
import pandas as pd
import pytest

from services import market_data as md

MIN = 60_000  # 1m in ms
DAY_S = 86_400


# ---------------------------------------------------------------------------
# missing_segments
# ---------------------------------------------------------------------------

def _times(start_s, n, step=60):
    return np.arange(start_s, start_s + n * step, step, dtype="int64")


def test_no_file_is_one_segment():
    assert md.missing_segments(0, 10 * MIN, None, 60) == [{"kind": "all", "start_ms": 0, "end_ms": 10 * MIN}]


def test_head_and_tail_around_saved_file():
    saved = _times(1_000_000, 100)  # seconds
    first_ms, last_ms = int(saved[0]) * 1000, int(saved[-1]) * 1000
    segs = md.missing_segments(first_ms - 50 * MIN, last_ms + 50 * MIN, saved, 60)
    assert [s["kind"] for s in segs] == ["head", "tail"]
    assert segs[0] == {"kind": "head", "start_ms": first_ms - 50 * MIN, "end_ms": first_ms - 1}
    # The tail re-fetches the last saved bar: it may have been unfinished.
    assert segs[1]["start_ms"] == last_ms


def test_only_holes_longer_than_a_day_count():
    a = _times(1_000_000, 10)
    b = _times(int(a[-1]) + 2 * 3600, 10)          # 2h jump: normal maintenance
    c = _times(int(b[-1]) + 2 * DAY_S, 10)         # 2-day jump: a hole
    saved = np.concatenate([a, b, c])
    segs = md.missing_segments(int(saved[0]) * 1000, int(saved[-1]) * 1000, saved, 60)
    assert [s["kind"] for s in segs] == ["hole"]
    assert segs[0]["start_ms"] == (int(b[-1]) + 60) * 1000
    assert segs[0]["end_ms"] == int(c[0]) * 1000 - 1


def test_range_inside_the_file_needs_nothing():
    saved = _times(1_000_000, 100)
    assert md.missing_segments(int(saved[10]) * 1000, int(saved[50]) * 1000, saved, 60) == []


# ---------------------------------------------------------------------------
# _plan_pages / _kept_rows
# ---------------------------------------------------------------------------

def _windows_cover(pages, start, end_incl):
    """Windows tile [start, end_incl] exactly — no gaps, no overlaps."""
    w = sorted((p["since"], p["until"]) for p in pages)
    assert w[0][0] == start and w[-1][1] == end_incl + 1
    assert all(a[1] == b[0] for a, b in zip(w, w[1:]))


def test_pages_tile_each_segment():
    segs = [{"kind": "all", "start_ms": 0, "end_ms": 2_500 * MIN - 1}]
    pages = md._plan_pages(segs, MIN, 1000)
    assert len(pages) == 3
    _windows_cover(pages, 0, 2_500 * MIN - 1)
    assert pages[0]["since"] == 0  # oldest first


def test_head_pages_run_backwards_from_the_saved_file():
    segs = [{"kind": "head", "start_ms": 0, "end_ms": 2_500 * MIN - 1}]
    pages = md._plan_pages(segs, MIN, 1000)
    _windows_cover(pages, 0, 2_500 * MIN - 1)
    assert pages[0]["until"] == 2_500 * MIN  # newest first: touches the file


def test_kept_rows_after_an_early_stop():
    segs = [
        {"kind": "all", "start_ms": 0, "end_ms": 3_000 * MIN - 1},
        {"kind": "hole", "start_ms": 5_000 * MIN, "end_ms": 7_000 * MIN - 1},
    ]
    pages = md._plan_pages(segs, MIN, 1000)  # 3 "all" pages, then 2 hole pages
    results = {0: [["p0"]], 2: [["p2"]], 3: [["h0"]]}  # page 1 and the 2nd hole page missing
    # "all": only the unbroken run from the start (page 2 would leave a hole).
    # hole: partly filled -> dropped entirely.
    assert md._kept_rows(segs, pages, results) == [["p0"]]


def test_kept_rows_when_everything_finished():
    segs = [{"kind": "hole", "start_ms": 0, "end_ms": 2_000 * MIN - 1}]
    pages = md._plan_pages(segs, MIN, 1000)
    assert md._kept_rows(segs, pages, {0: [["a"]], 1: [["b"]]}) == [["a"], ["b"]]


# ---------------------------------------------------------------------------
# _RateGate / _fetch_pages_parallel
# ---------------------------------------------------------------------------

def test_gate_spacing_matches_half_the_binance_budget():
    spot = md._RateGate(6000, 2, 0.5)
    perp = md._RateGate(2400, 2, 0.5)
    assert spot.interval == pytest.approx(0.04)  # 25 pages/s = 3,000 weight/min
    assert perp.interval == pytest.approx(0.1)   # 10 pages/s = 1,200 weight/min


def test_gate_pauses_when_the_ip_is_near_the_limit():
    gate = md._RateGate(6000, 2, 0.5)
    gate.observe(1000)
    assert gate._next == 0.0
    gate.observe(5000)  # > 80% of 6000 for the whole IP
    assert gate._next > time.monotonic()


def test_parallel_fetch_stops_on_first_error():
    pages = [{"seg": 0, "since": i, "until": i + 1} for i in range(50)]

    def fetch(page, stopped):
        if stopped():
            return None
        if page["since"] == 5:
            raise RuntimeError("boom")
        time.sleep(0.01)
        return [[page["since"]]]

    results, error = md._fetch_pages_parallel(pages, fetch, 4, lambda: False, lambda rows: None)
    assert str(error) == "boom"
    assert 5 not in results and len(results) < 50


# ---------------------------------------------------------------------------
# download_range end to end (fake Binance, temp data dir)
# ---------------------------------------------------------------------------

class _FakeClient:
    name = "Binance"
    timeframes = {"1m": "1m"}

    def market(self, pair):
        return {"id": "LTCUSDT", "contractSize": None}


@pytest.fixture
def fake_binance(tmp_path, monkeypatch):
    """1m bars from 20 days ago until now (~29 pages), with a real 2h outage."""
    now = int(time.time() * 1000) // MIN * MIN
    first = now - 20 * 1440 * MIN
    outage = (first + 1000 * MIN, first + 1120 * MIN)
    bars = [t for t in range(first, now + MIN, MIN) if not outage[0] <= t < outage[1]]

    monkeypatch.setattr(md, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(md, "_client_for", lambda symbol: _FakeClient())
    monkeypatch.setattr(md, "_require_market", lambda *a: None)
    monkeypatch.setattr(md, "_first_bar_ms", lambda *a: first)
    monkeypatch.setattr(md, "_last_bar_ms", lambda *a: now)
    monkeypatch.setattr(md, "_invalidate_datasets_cache", lambda: None)

    calls = {"n": 0}
    lock = threading.Lock()

    def fake_page(url, market_id, interval, page, page_bars, gate, stopped, mult=1.0):
        if stopped():
            return None
        with lock:
            calls["n"] += 1
        time.sleep(0.005)
        got = [t for t in bars if t >= page["since"]][:page_bars]
        return [[t, 1.0, 2.0, 0.5, 1.5, 3.0] for t in got if t < page["until"]]

    monkeypatch.setattr(md, "_binance_page", fake_page)
    return {"first": first, "now": now, "bars": bars, "calls": calls}


def _saved(tmp_path):
    return pd.read_parquet(tmp_path / "binance" / "LTCUSDT_1m.parquet")["time"].to_numpy() * 1000


def test_full_download_matches_the_exchange(fake_binance, tmp_path):
    out = md.download_range("LTCUSDT", "1m", 0, fake_binance["now"] + MIN)  # 0 clamps to the first bar
    t = _saved(tmp_path)
    assert list(t) == fake_binance["bars"]  # every bar, in order, no duplicates
    assert out["rows_added"] == len(fake_binance["bars"])


def test_cancel_then_resume_leaves_no_hole(fake_binance, tmp_path):
    def cancel_after_two_pages():
        return fake_binance["calls"]["n"] >= 2

    md.download_range("LTCUSDT", "1m", 0, fake_binance["now"] + MIN, cancel_check=cancel_after_two_pages)
    partial = _saved(tmp_path)
    # What was kept is an unbroken run from the first bar.
    assert len(partial) < len(fake_binance["bars"])
    assert partial[0] == fake_binance["first"]
    assert list(partial) == fake_binance["bars"][: len(partial)]

    # Resume: only the missing tail is planned, and the result is complete.
    plan = md.plan_download("LTCUSDT", "1m")
    assert [s["kind"] for s in plan["segments"]] == ["tail"]
    md.download_range("LTCUSDT", "1m", 0, fake_binance["now"] + MIN)
    assert list(_saved(tmp_path)) == fake_binance["bars"]

    # Up to date now: the next plan only re-checks the newest bar.
    plan = md.plan_download("LTCUSDT", "1m")
    assert plan["pages"] <= 1


# ---------------------------------------------------------------------------
# Overwrite: the old file only goes once the fresh copy is complete
# ---------------------------------------------------------------------------

def _path(tmp_path):
    return tmp_path / "binance" / "LTCUSDT_1m.parquet"


def _write_junk(tmp_path, times_ms):
    """A saved file whose prices are obviously wrong (close 999)."""
    _path(tmp_path).parent.mkdir(exist_ok=True)
    pd.DataFrame({
        "time": np.array(times_ms, dtype="int64") // 1000,
        "open": 9.0, "high": 9.0, "low": 9.0, "close": 999.0, "volume": 1.0,
    }).to_parquet(_path(tmp_path), index=False)


def test_overwrite_replaces_the_file(fake_binance, tmp_path):
    _write_junk(tmp_path, fake_binance["bars"][:20_000])
    plan = md.plan_download("LTCUSDT", "1m")
    assert plan["overwrite"]["pages"] > plan["pages"]  # a fresh copy costs more than filling gaps

    out = md.download_range("LTCUSDT", "1m", 0, fake_binance["now"] + MIN, overwrite=True)
    df = pd.read_parquet(_path(tmp_path))
    assert list(df["time"] * 1000) == fake_binance["bars"]
    assert (df["close"] == 1.5).all()  # every junk bar was replaced
    assert out["replaced"] and out["rows_before"] == 20_000
    assert not (tmp_path / "binance" / "LTCUSDT_1m.parquet.tmp").exists()


def test_cancelled_overwrite_keeps_the_old_file(fake_binance, tmp_path):
    _write_junk(tmp_path, fake_binance["bars"][:20_000])
    before = pd.read_parquet(_path(tmp_path))
    md.download_range("LTCUSDT", "1m", 0, fake_binance["now"] + MIN, overwrite=True,
                      cancel_check=lambda: fake_binance["calls"]["n"] >= 2)
    pd.testing.assert_frame_equal(pd.read_parquet(_path(tmp_path)), before)


def test_failed_overwrite_keeps_the_old_file(fake_binance, tmp_path, monkeypatch):
    _write_junk(tmp_path, fake_binance["bars"][:20_000])
    before = pd.read_parquet(_path(tmp_path))
    fake_page = md._binance_page

    def ban_halfway(url, market_id, interval, page, *a, **k):
        if page["since"] > fake_binance["first"] + 5_000 * MIN:
            raise RuntimeError("Binance banned this IP (HTTP 418)")
        return fake_page(url, market_id, interval, page, *a, **k)

    monkeypatch.setattr(md, "_binance_page", ban_halfway)
    with pytest.raises(RuntimeError, match="not changed"):
        md.download_range("LTCUSDT", "1m", 0, fake_binance["now"] + MIN, overwrite=True)
    pd.testing.assert_frame_equal(pd.read_parquet(_path(tmp_path)), before)


def test_delisted_pair_plans_nothing_past_its_last_bar(fake_binance, monkeypatch):
    # e.g. OCEANUSDT: Binance stopped it on Jul 01, 2024, but "now" is later.
    last = fake_binance["first"] + 999 * MIN
    monkeypatch.setattr(md, "_last_bar_ms", lambda *a: last)
    plan = md.plan_download("LTCUSDT", "1m")
    assert plan["end_ms"] == last + MIN - 1
    assert plan["bars"] == 1000 and plan["pages"] == 1


# ---------------------------------------------------------------------------
# Batch jobs (services/download_jobs.py)
# ---------------------------------------------------------------------------

def _run_batch(monkeypatch, symbols, fail):
    from services import download_jobs
    events, calls = [], []
    monkeypatch.setattr(download_jobs.event_bus, "emit", lambda ev, payload, to=None: events.append((ev, payload)))

    def fake_download(symbol, timeframe, start_ms, end_ms, progress_cb=None, cancel_check=None, overwrite=False):
        calls.append((symbol, timeframe))
        if symbol in fail:
            raise fail[symbol]
        return {"rows_added": 1, "rows_total": 1, "first_time": 0, "last_time": 0}

    monkeypatch.setattr(md, "download_range", fake_download)
    job = download_jobs.DownloadJob({"broker": "binance", "symbols": symbols, "timeframes": ["1m", "15m"],
                                     "start_ms": 0, "end_ms": 1, "job_id": "t"})
    job._run()  # synchronously
    return job, events, calls


def test_batch_skips_a_bad_symbol_and_finishes_the_rest(monkeypatch):
    job, events, calls = _run_batch(monkeypatch, ["ONEUSDT", "NOPEUSDT", "OGNUSDT"],
                                    {"NOPEUSDT": ValueError("Binance has no market NOPE/USDT")})
    assert job.state == "done"
    assert calls == [(s, tf) for s in ("ONEUSDT", "NOPEUSDT", "OGNUSDT") for tf in ("1m", "15m")]
    results = [p for ev, p in events if ev == "download_complete"][0]["results"]
    assert [r["symbol"] for r in results if "error" in r] == ["NOPEUSDT", "NOPEUSDT"]
    assert len([r for r in results if "error" not in r]) == 4


def test_a_binance_ban_stops_the_whole_batch(monkeypatch):
    job, events, calls = _run_batch(monkeypatch, ["ONEUSDT", "OGNUSDT"],
                                    {"ONEUSDT": md.BinanceBanned("banned (HTTP 418)")})
    assert job.state == "error"
    assert calls == [("ONEUSDT", "1m")]  # nothing after the ban


def test_auto_detect_retries_a_network_blip(monkeypatch):
    # ZECUSDT 15m was once skipped in a batch because one probe request timed out.
    import ccxt
    calls = {"n": 0}

    def flaky(client, pair, timeframe, since=None, limit=1000):
        calls["n"] += 1
        if calls["n"] == 1:
            raise ccxt.RequestTimeout("binance GET .../klines timed out")
        return [[1_600_000_000_000, 1, 1, 1, 1, 1]]

    monkeypatch.setattr(md, "_fetch_page", flaky)
    monkeypatch.setattr(md.time, "sleep", lambda s: None)
    assert md._first_bar_ms(object(), "ZEC/USDT", "15m", 0) == 1_600_000_000_000
    assert calls["n"] == 2


def test_auto_detect_does_not_retry_an_exchange_error(monkeypatch):
    import ccxt

    def bad_symbol(*a, **k):
        raise ccxt.BadSymbol("binance does not have market symbol NOPE/USDT")

    monkeypatch.setattr(md, "_fetch_page", bad_symbol)
    with pytest.raises(ccxt.BadSymbol):
        md._last_bar_ms(object(), "NOPE/USDT", "1m")
