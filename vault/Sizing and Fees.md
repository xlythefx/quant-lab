---
tags: [concept]
type: concept
---

# Sizing and Fees

The single branch point is in [[Backtest Engine]] (~L200): `contract_sizing = asset_class == "futures" and contract_size > 1.0`. `contract_size` from `data/assets/{broker}.json` (ES 50, NQ 20, GC 100, CL 1000; crypto = 1.0).

- **Futures** → *fixed* `units = contracts × contract_size` (P&L = move × units → TS-style dollars). Driven by `contracts`; `risk_pct` inert.
- **Crypto/spot** → `units = equity × risk_pct / price` — **compounds** with MTM equity. Driven by `risk_pct`; `contracts` inert.
- **Fees** (`_fee()`, charged entry AND exit): futures `fee_flat + futures_commission × contracts`; crypto `fee_flat + |notional| × fee_pct`.
- **Slippage** (`slippage_bps`, default 1bp) both sides.
- Global (Risk Settings): `starting_capital`, `fee_flat`, `fee_pct`, `futures_commission`, `slippage_bps`. Per-strategy: `risk_pct`, `contracts`, `pyramiding`.

[[Dashboard V2]]'s settings hide the inert sizing slider per asset class.

Related: [[Data]] · [[Portfolio Runner]]
