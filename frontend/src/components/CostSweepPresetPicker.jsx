import { useState } from "react";

/**
 * Cost Sweep scenario presets — pre-built sweep configurations for common
 * real-world questions. Each card has:
 *   - a "Use this" button that applies the preset (sweep_dim + values) to the form
 *   - a "?" info icon that opens a modal explaining when to use it
 *
 * Props:
 *   onApply: ({sweepDim, sweepText}) => void
 *   disabled: bool — true while a job is running
 */
export default function CostSweepPresetPicker({ onApply, disabled }) {
  const [openId, setOpenId] = useState(null);
  const active = PRESETS.find((p) => p.id === openId) || null;

  const handleApply = (preset) => {
    onApply({ sweepDim: preset.sweepDim, sweepText: preset.sweepText });
    setOpenId(null);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted">Scenario Presets · click to try</div>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
        {PRESETS.map((p) => (
          <PresetCard
            key={p.id}
            preset={p}
            disabled={disabled}
            onOpenModal={() => setOpenId(p.id)}
            onQuickApply={() => handleApply(p)}
          />
        ))}
      </div>

      {active && (
        <PresetModal
          preset={active}
          onClose={() => setOpenId(null)}
          onApply={() => handleApply(active)}
          disabled={disabled}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function PresetCard({ preset, disabled, onOpenModal, onQuickApply }) {
  const dim = DIM_LABELS[preset.sweepDim];
  return (
    <div className="rounded-md border border-line/60 bg-bg-elev/30 p-3 space-y-1.5">
      <div className="flex items-start justify-between gap-2">
        <div className="text-sm font-semibold text-text leading-tight">{preset.name}</div>
        <button
          onClick={onOpenModal}
          className="shrink-0 w-5 h-5 rounded-full bg-accent-blue/15 text-accent-blue text-[10px] font-bold flex items-center justify-center hover:bg-accent-blue/25"
          title="What does this do?"
        >
          ?
        </button>
      </div>
      <div className="text-[11px] text-muted leading-snug min-h-[2.5em]">{preset.tagline}</div>
      <div className="text-[10px] font-mono text-muted/80 pt-1 border-t border-line/30 space-y-0.5">
        <div>{dim}</div>
        <div className="truncate" title={preset.sweepText}>{preset.sweepText}</div>
      </div>
      <button
        onClick={onQuickApply}
        disabled={disabled}
        className="w-full mt-1 px-2 py-1 rounded text-[11px] font-semibold bg-accent-grad text-white disabled:opacity-40"
      >
        Use this
      </button>
    </div>
  );
}

function PresetModal({ preset, onClose, onApply, disabled }) {
  const dim = DIM_LABELS[preset.sweepDim];
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[560px] max-w-[92vw] max-h-[88vh] overflow-y-auto rounded-xl border border-line bg-bg-panel shadow-2xl">
        <div className="px-5 py-4 border-b border-line flex items-center justify-between gap-3">
          <div>
            <div className="text-[10px] uppercase tracking-wider text-accent-blue">Scenario Preset</div>
            <h3 className="text-base font-semibold mt-0.5">{preset.name}</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text text-xl leading-none">&times;</button>
        </div>

        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-text leading-relaxed">{preset.description}</p>

          <Section title="When to use">
            <ul className="text-xs text-muted leading-relaxed list-disc pl-4 space-y-0.5">
              {preset.whenToUse.map((it, i) => <li key={i}>{it}</li>)}
            </ul>
          </Section>

          <Section title="How to read the result">
            <p className="text-xs text-muted leading-relaxed">{preset.howToRead}</p>
          </Section>

          <Section title="What this preset applies">
            <div className="space-y-1 text-[11px] font-mono">
              <KV k="Sweep dimension" v={dim} />
              <KV k="Sweep values"    v={preset.sweepText} />
              <div className="text-[10px] text-muted/70 pt-1">
                Will run {preset.sweepText.split(/[,\s]+/).filter(Boolean).length} backtests
                — one per value. Strategy params + symbol + date range come from the form above.
              </div>
            </div>
          </Section>
        </div>

        <div className="px-5 py-4 border-t border-line flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm rounded-md text-muted hover:text-text">
            Cancel
          </button>
          <button
            onClick={onApply}
            disabled={disabled}
            className="px-4 py-2 text-sm rounded-md font-semibold bg-accent-grad text-white disabled:opacity-40"
          >
            Use this preset
          </button>
        </div>
      </div>
    </div>
  );
}

function Section({ title, children }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-muted mb-1">{title}</div>
      {children}
    </div>
  );
}

function KV({ k, v }) {
  return (
    <div className="flex items-center justify-between gap-2 rounded border border-line/40 bg-bg-elev/30 px-2 py-1">
      <span className="text-muted text-[10px] uppercase">{k}</span>
      <span className="text-text break-all">{v}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------

const DIM_LABELS = {
  slippage_bps: "Slippage (bps)",
  fee_pct:      "Fee % per side",
  fee_flat:     "Fee flat ($/trade)",
};

const PRESETS = [
  {
    id: "binance_realistic",
    name: "Binance Realistic",
    tagline: "Standard Binance spot slippage tiers, 0–30 bps. Your edge should survive this.",
    description:
      "Tests slippage levels you'd actually encounter on Binance spot with normal market orders on a major pair. 0 bps is the unrealistic backtest assumption; 5–10 bps is typical retail-size on a major pair; 20–30 bps is during a fast move or on a thinner pair.",
    whenToUse: [
      "First-pass cost check after every new strategy.",
      "Comparing two strategies — pick the one that holds up better across the tier.",
      "Quick gut-check before going live.",
    ],
    howToRead:
      "Look at where Sharpe / Return % drops below your acceptance threshold. If the curve goes negative anywhere in the 5–15 bps range, your edge is fragile and probably won't survive live trading.",
    sweepDim:  "slippage_bps",
    sweepText: "0, 2, 5, 10, 15, 20, 30",
  },
  {
    id: "thin_liquidity",
    name: "Thin Liquidity Stress",
    tagline: "0–100 bps slippage. Are you safe trading smaller altcoins or larger size?",
    description:
      "Stress test for trading low-cap pairs (wider bid-ask) or scaling up size (eating through more book). 50 bps = 0.5% slippage per side ≈ 1% round-trip on every trade. If your strategy still makes money at 50+ bps, execution quality isn't your bottleneck.",
    whenToUse: [
      "Considering trading a low-volume altcoin.",
      "Planning to scale account size 10x and worried about book depth.",
      "Pre-deploy stress test before sizing up.",
    ],
    howToRead:
      "Find the slippage level where Sharpe crosses 1.0 — that's your 'rough deployment ceiling'. If the strategy still makes money at 100 bps, you have a remarkably robust edge; if it dies at 25 bps, treat it as a major-pair-only strategy.",
    sweepDim:  "slippage_bps",
    sweepText: "0, 10, 25, 50, 75, 100",
  },
  {
    id: "fee_tiers",
    name: "Fee Tier Exploration",
    tagline: "0–0.1% per side. Maps to maker → taker on major exchanges.",
    description:
      "Sweep across the realistic spectrum of trading fees. 0.02–0.04% covers VIP maker rates; 0.05–0.075% is standard taker; 0.1% is full-retail taker on a smaller exchange. Tells you whether limit-order (maker) discipline matters or if you can take the easy market-order path.",
    whenToUse: [
      "Deciding between maker-only and market-order execution.",
      "Comparing exchanges with different fee schedules.",
      "Negotiating VIP tiers — quantify the dollar value.",
    ],
    howToRead:
      "If Sharpe is roughly flat from 0% → 0.1%, fees aren't your problem and you can take the simpler market-order path. If it slopes sharply down, you need maker fills (limit orders) to keep the edge — adds operational complexity.",
    sweepDim:  "fee_pct",
    sweepText: "0, 0.02, 0.04, 0.05, 0.075, 0.1",
  },
  {
    id: "cliff_finder",
    name: "Edge Cliff Finder",
    tagline: "Fine 0–30 bps slippage sweep. Pinpoints exactly where your edge breaks.",
    description:
      "Dense slippage grid (1 bps steps near zero, wider further out) so you can read directly off the chart where Sharpe drops below your threshold. Use after the Realistic preset confirms the strategy works at all — this preset finds the exact cliff.",
    whenToUse: [
      "Already passed the Realistic preset, want to know the safety margin.",
      "Sizing risk: 'I'm OK as long as live slippage stays under X bps.'",
      "Fine-grained sensitivity analysis for a paper to your future self.",
    ],
    howToRead:
      "Find the value where Sharpe crosses your acceptance threshold (often Sharpe = 1.0). That's your slippage ceiling. Measure live execution against it — if real fills come in within 2–3 bps below the ceiling, you're operating with thin margin and need a plan.",
    sweepDim:  "slippage_bps",
    sweepText: "0, 1, 2, 3, 5, 7, 10, 15, 20, 30",
  },
];
