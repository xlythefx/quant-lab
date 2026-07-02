---
tags: [hub]
type: home
---

# Quantlab

A multi-asset quantitative trading **research** platform — Flask + SocketIO backend (Python), React frontend. Backtesting, walk-forward optimization, a read-only "Market Lab" of market-structure analyses, and live/paper running across brokers. Built for *self-use validation* — "works and I understand it," not production scale.

> Open this `vault/` folder as an Obsidian vault. Notes link with `[[wikilinks]]`; the graph view shows how the project fits together.

## Map of content

- [[Architecture]] — how the pieces connect (backend :6173 + frontend :5173)
- [[Backend]] · [[Frontend]] · [[Data]]
- [[Strategies]] → [[VWMA Reversion]]
- [[Regime Detection]] → [[HMM Regime]] · [[5-Mood Regime]] · [[ADX Regime]]
- [[Backtest Engine]] · [[Portfolio Runner]] · [[Sizing and Fees]]
- Validation: [[Walk-Forward]] · [[Grid Search]] · [[Monte Carlo]] · [[Cost Sweep]]
- Pages: [[Dashboard V2]] · [[Dashboard V1]] · [[Analytics]] · [[Market Lab]] · [[Report Import]]
- Ideas: [[Validation and Overfitting]] · [[Filters and Sessions]] · [[Parameter Sensitivity]]

## Repo facts

- Python 3.14 only (no venv); `hmmlearn` won't install → the HMM is pure numpy/scipy. See [[HMM Regime]].
- Project guide lives at `CLAUDE.md` (repo root) — display rules, layout, sizing/fees.
- Two simulation engines exist; keep them in sync → [[Backtest Engine]] vs [[Portfolio Runner]].
