"""is_live_eligible: the single gate for anything that may fire real webhooks."""
from services.live import live_symbols
from services.live.live_symbols import deployable_usdt_symbols, is_live_eligible


def test_plain_binance_spot_pairs_are_eligible():
    assert is_live_eligible("SOLUSDT")[0]
    assert is_live_eligible("solusdt ")[0]          # normalised
    assert is_live_eligible("AVAXUSDT", "15m")[0]   # not in binance.json, but TRADING on Binance


def test_research_and_unknown_symbols_are_not_eligible():
    for sym in ("MEXC.SOLUSDT", "BYBIT.LTCUSDT", "SOLUSDT.P", "MEXC.LTCUSDT.P"):
        ok, reason = is_live_eligible(sym)
        assert not ok and "research symbol" in reason, sym
    for sym in ("ES", "NQ", "CL", "GC", "FOOUSDT"):
        ok, reason = is_live_eligible(sym, "1h")
        assert not ok and "not a trading Binance spot pair" in reason, sym
    assert is_live_eligible("") == (False, "symbol is required")


def test_futures_only_eligible_when_their_tradestation_csv_exists(isolated):
    assert not is_live_eligible("ES", "1h")[0]
    csv = isolated / "tradestation" / "ES" / "ES_1H_live.csv"
    csv.parent.mkdir(parents=True)
    csv.write_text("")
    assert is_live_eligible("ES", "1h")[0]
    assert not is_live_eligible("ES", "5m")[0]      # only the timeframe whose file exists
    assert is_live_eligible("ES")[0]                # any feed for the symbol


def test_exchange_info_is_cached(monkeypatch):
    calls = []

    def fetch():
        calls.append(1)
        return {"SOLUSDT": "USDT"}

    monkeypatch.setattr(live_symbols, "_fetch_exchange_info", fetch)
    for _ in range(5):
        is_live_eligible("SOLUSDT")
    assert len(calls) == 1


def test_falls_back_to_catalog_when_binance_unreachable(monkeypatch):
    def down():
        raise ConnectionError("no route to host")

    monkeypatch.setattr(live_symbols, "_fetch_exchange_info", down)
    assert is_live_eligible("BTCUSDT")[0]           # in data/assets/binance.json
    assert not is_live_eligible("AVAXUSDT")[0]      # not in the curated catalog


def test_deployable_symbols_are_sorted_usdt_pairs():
    syms = deployable_usdt_symbols()
    assert syms == sorted(syms)
    assert "SOLUSDT" in syms and "AVAXUSDT" in syms
    assert "ETHBTC" not in syms and "BTCUSDC" not in syms
