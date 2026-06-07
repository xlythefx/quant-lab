# Databento integration

Context docs for connecting **Databento** as quantlab's CME futures data feed —
historical first, live later. These are reference/design notes; **no code has been
written yet**. They exist so the actual build can proceed with full context.

## Why Databento

The existing feeds each cover a niche but none gives clean, reliable CME futures:

| Feed | Covers | Gap for futures |
|---|---|---|
| Binance / CCXT | crypto | no futures |
| Dukascopy | forex ticks | no CME |
| Yahoo | equities (delayed/daily) | poor intraday futures |
| TradeStation CSV | ES/NQ via manual export | brittle, manual, no clean continuous series |

Databento gives **survivorship-bias-free, continuous-contract CME data** (ES, NQ,
CL, GC and the rest of CME/CBOT/NYMEX/COMEX) through one Python client, for both
historical pulls and live streaming — and its OHLCV output maps cleanly onto the
parquet bar schema every quantlab strategy already consumes.

## Prerequisites

- A Databento account and API key. Keys are 32-char strings starting with `db-`,
  found on the API Keys page of the user portal. New teams get **$125 in free
  historical credits**.
- Env var **`DATABENTO_API_KEY`** — already present in `backend/.env` and loaded
  by `python-dotenv` at app boot. The client reads it from the environment
  automatically; read it in code via `os.environ.get("DATABENTO_API_KEY")`.
- Install the client:

  ```bash
  pip install -U databento
  ```

  Requires Python ≥ 3.10 (quantlab's backend already satisfies this). The package
  will be added to [backend/requirements.txt](../../backend/requirements.txt) when
  the adapter lands.

## Documents

1. **[reference.md](reference.md)** — Databento SDK/API reference: clients,
   `timeseries.get_range`, schemas, data encoding, symbology, the `GLBX.MDP3`
   dataset, and cost control. Read this first.
2. **[historical-integration.md](historical-integration.md)** — the quantlab
   wiring map: the new broker adapter, where it plugs into `download_jobs.py` /
   `market_data.py`, the asset catalog, timeframe/symbol mapping, and a first-pull
   walkthrough. **This is the current milestone.**
3. **[live-integration.md](live-integration.md)** — live-feed design using the
   `Live` client and quantlab's streaming layer. **Future phase.**

## Status

| Phase | State |
|---|---|
| Historical feed | **built** — adapter + download job + `futures` asset class + Downloads UI tab. Run `pip install databento`. |
| Live feed | designed (later phase) — not yet implemented |
