# Level 8 — Adaptive / Meta (parked future ideas)

The top of the algo ladder: strategies that **change themselves** based on market
conditions, or that use machine learning to blend/select signals. This is where
large quant teams with dedicated researchers spend their careers.

**Status: deliberately parked.** This doc exists so the ideas aren't lost, not so
they get built soon. Read "Why not now" before touching any of it.

---

## Why not now (read this first)

1. **It's the flattest part of the value curve.** Levels 0–4 each multiply your
   trustworthiness. Level 8 adds — at best — single-digit-% improvements to an
   *already-confirmed* edge, while complexity and fragility climb steeply.
2. **It's where big teams' edge over a solo is largest.** Regime models, ML
   pipelines and factor models need scale, data infrastructure, and constant
   babysitting. Competing here as one person is the worst risk/reward on the board.
3. **It's the easiest place to overfit.** Every adaptive knob is another degree of
   freedom — another way to fit noise and fool yourself. The more "intelligent" the
   layer, the harder it is to tell skill from luck.
4. **Prerequisites aren't met yet.** The honest next work is **Level 5** (execution
   realism + live-vs-backtest tracking) and **Level 6–7** (vol targeting →
   risk parity, see [portfolio-plan.md](portfolio-plan.md)). Do those first.

**Do not start any Level 8 item until:** you have a live-vs-backtest tracking
report proving your edges survive real execution, *and* at least two separately-
validated uncorrelated strategies running. Adaptive layers built on unproven
edges just overfit faster.

---

## The idea bucket (someday, maybe)

Each of these must, if ever built, go through the **exact same gauntlet** as any
strategy: walk-forward, Monte Carlo, parameter-plateau, deflated Sharpe, and a
locked holdout. An adaptive layer is not exempt from validation — it needs *more*
of it, because it has more ways to cheat.

### Regime-conditional allocation
Shift capital between strategies based on the detected market regime (e.g. more to
mean-reversion in ranging markets, more to trend-following in trending ones). You
already have causal regime labels (deterministic ADX/5-mood, plus a causal HMM).
*Caveat:* this only helps if regime is predictive **out-of-sample** — test the
allocation switch through walk-forward, exactly like the single-strategy regime
gate. If the on/off comparison is a wash, this adds nothing but risk.

### Meta-labeling
Keep your existing strategy as the "primary" signal (decides *direction*), and
train a small secondary model to decide *whether to take the trade* (a yes/no
filter on the primary's signals). López de Prado's pattern. Lower-risk than a
full ML signal because the ML never picks direction — it only sizes/vetoes. Still
needs heavy validation and enough trades to train on without overfitting.

### ML signal blending
Combine several weak signals into one via a model (logistic regression first —
*not* a deep net). *Danger:* trivially overfits with limited financial data.
If ever attempted: tiny feature set, heavy regularization, and it must beat a
simple equal-weight blend on a locked holdout, or it's rejected.

### Dynamic parameter adaptation
Let a strategy's parameters drift with conditions (e.g. widen stops when realized
vol rises). *Note:* volatility targeting (Level 6, Phase 1 in the portfolio plan)
is the safe, bounded version of this idea — do that first. Free-floating parameter
adaptation is the fragile version; prefer rule-based, monotonic adjustments over
learned ones.

### Factor models
Decompose returns into common factors (momentum, carry, vol, etc.) to understand
*why* a strategy makes money and whether its edge is just a known factor in
disguise. More useful as a **diagnostic** ("is my 'edge' just momentum beta?")
than as a live allocator for a book this size.

---

## The one honest rule for all of it

If an adaptive layer can't beat the **simple, static version of the same idea** on
data it has never seen, it is complexity for its own sake — reject it. Sophistication
that doesn't survive a locked holdout is just a more expensive way to lose.
