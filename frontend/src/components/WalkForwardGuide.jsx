import { useEffect } from "react";
import { GATE_ORDER, VERDICTS } from "../services/wfVerdict.js";

/**
 * Plain-English guide for the Walk-Forward setup form.
 *
 * Triggered by the "?" button next to the page title. Pure UI — no state,
 * no API calls. Content lives here so it lives next to the feature it documents.
 *
 * The verdict section is NOT written here: it iterates the same VERDICTS catalog
 * the Verdict tab reads, so the guide can never describe an outcome the page
 * doesn't produce, or miss one it does.
 */
export default function WalkForwardGuide({ open, onClose }) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/70 backdrop-blur-sm" onClick={onClose} />
      <div className="relative w-[640px] max-w-[94vw] max-h-[88vh] flex flex-col rounded-xl border border-line bg-bg-panel shadow-2xl">

        <div className="px-5 py-4 border-b border-line flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-full bg-accent-blue/15 text-accent-blue flex items-center justify-center text-base font-bold">?</span>
            <h3 className="text-base font-semibold">Walk-Forward Guide</h3>
          </div>
          <button onClick={onClose} className="text-muted hover:text-text text-xl leading-none">×</button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5 text-sm">

          <section>
            <h4 className="text-text font-semibold mb-1">What problem this solves</h4>
            <p className="text-muted leading-relaxed">
              A normal backtest tunes parameters on the same data it scores on,
              which guarantees great-looking results that don&apos;t survive live trading.
              Walk-forward fixes that by always testing on data the optimizer
              <em> hasn&apos;t seen</em>. The number you trust is the stitched OOS curve.
            </p>
          </section>

          <section>
            <h4 className="text-text font-semibold mb-1">How the windows roll</h4>
            <pre className="text-[11px] font-mono bg-bg-elev/40 border border-line/40 rounded-md p-3 leading-relaxed overflow-x-auto">{`
time ─────────────────────────────────────────────►
     [   IS bars   ][ OOS ]
                    [   IS bars   ][ OOS ]
                                   [   IS bars   ][ OOS ]
                                                  ...
     └─ optimize ──┘└ score ┘
            (tune params)   (honest test, params frozen)
`.trim()}</pre>
            <p className="text-muted leading-relaxed mt-2">
              The window slides forward by <span className="font-mono">OOS bars</span> each step.
              At every step Optuna tunes parameters on the IS slice, then those
              <em> frozen</em> parameters are evaluated on the next OOS slice.
              All OOS slices are concatenated into the final equity curve.
            </p>
          </section>

          <section>
            <h4 className="text-text font-semibold mb-2">Each field</h4>
            <dl className="space-y-3">
              <FieldRow term="IS bars (in-sample)">
                The training window the optimizer can see. Bigger = more signal
                but slower to adapt to regime change.
                Rule of thumb: enough bars to contain hundreds of trades for the strategy.
                Common: 1,000–5,000 bars on 15m data.
              </FieldRow>
              <FieldRow term="OOS bars (out-of-sample)">
                The forward test window. Bigger = fewer windows but each scored on
                more trades (more reliable). Smaller = more re-optimizations but each
                OOS reading is noisier. Common ratio: <span className="font-mono">IS ≈ 4–10×</span> OOS.
              </FieldRow>
              <FieldRow term="Trials / window">
                How many parameter combinations Optuna tries inside each IS window.
                More trials = better tuning but slower. 50–100 is usually enough for
                a small search space; 200+ if you have many params or want to be thorough.
              </FieldRow>
              <FieldRow term="Workers (CPU parallelism)">
                Run that many Optuna trials in parallel inside one window. Higher =
                faster, but each trial uses RAM and Python threads compete for the GIL
                during pandas/numpy work. Start at half your cores; raise if CPU isn&apos;t
                pinned. Set to 1 if results look unstable.
              </FieldRow>
              <FieldRow term="Metric">
                What Optuna maximizes when picking the &quot;best&quot; params on each IS window.
                <br/><span className="font-mono">Sharpe</span> — risk-adjusted (recommended). Stable, penalizes drawdown.
                <br/><span className="font-mono">Profit Factor</span> — gross profit ÷ gross loss. Sensitive to a few big winners.
                <br/><span className="font-mono">Total Return</span> — raw $. Will pick the most aggressive params; often overfits.
              </FieldRow>
              <FieldRow term="Search space">
                The parameters you want Optuna to tune (with low/high bounds). Anything
                not in the search space stays at its base value. Fewer dimensions = faster
                + less overfitting. Search 2–4 things at a time, not 10.
              </FieldRow>
            </dl>
          </section>

          <section>
            <h4 className="text-text font-semibold mb-1">How to read the result</h4>
            <ul className="list-disc pl-5 space-y-1 text-muted leading-relaxed">
              <li>The <span className="text-text">stitched OOS equity curve</span> is the honest one — that&apos;s what live trading would have looked like.</li>
              <li>If OOS is much worse than IS, the strategy is overfitting — shrink the search space, increase IS bars, or raise trials.</li>
              <li>If OOS params jump wildly window-to-window, the edge isn&apos;t stable — different bounds, different metric, or a different strategy.</li>
              <li>If OOS Sharpe &gt; 1.0 across many windows on different symbols, you&apos;ve probably found something real.</li>
            </ul>
          </section>

          <section>
            <h4 className="text-text font-semibold mb-1">The verdict — how it&apos;s decided</h4>
            <p className="text-muted leading-relaxed">
              The Verdict tab runs {GATE_ORDER.length} gates over the result and boils them down to one
              headline. The first two are <span className="text-text">decisive</span> — they can veto
              everything else, because if the search found nothing, a green plateau or a green OOS rate is
              describing noise:
            </p>
            <ul className="list-disc pl-5 mt-2 space-y-1 text-muted leading-relaxed">
              <li>
                <span className="text-text">Tuning beat not-tuning</span> — the control arm. Every window is run a
                second time with the untuned base params. If leaving them alone did better, the optimizer is
                costing you money and nothing below can rescue it.
              </li>
              <li>
                <span className="text-text">Windows agree on the params</span> — how far apart the windows&apos;
                picks landed, as a fraction of the search range. 28.9% is what random guessing produces. This
                reports the <em>worst</em> parameter, so one knob the strategy ignores can turn it red alone.
              </li>
            </ul>
            <p className="text-muted leading-relaxed mt-2">
              The other {GATE_ORDER.length - 2} — trade floor, plateau, OOS consistency, trade count, significance,
              buy-and-hold, deflated Sharpe, concentration, decay — each vote. The headline is then chosen in
              strict priority order: a failed decisive gate wins outright, then the mixed case, then &ldquo;too
              little measured&rdquo;, and only after all of that does the pass ratio decide between green, amber
              and red.
            </p>
          </section>

          <section>
            <h4 className="text-text font-semibold mb-2">Every verdict, and what to do about it</h4>
            <div className="space-y-3">
              {VERDICTS.map((v) => <VerdictEntry key={v.id} v={v} />)}
            </div>
            <p className="text-[11px] text-muted/70 mt-3 leading-relaxed">
              Two more gates — the locked holdout and cross-strategy honesty — can&apos;t be judged from a single run
              and are shown as grey reminders. No verdict here ever says you&apos;ve passed them.
            </p>
          </section>

          <section>
            <h4 className="text-text font-semibold mb-1">Speed knobs</h4>
            <p className="text-muted leading-relaxed">
              Cost scales like <span className="font-mono">windows × trials × IS-bar work</span>.
              To cut runtime: raise <span className="font-mono">Workers</span> first (cheap),
              then trim the <span className="font-mono">Search space</span> (biggest impact on quality-per-second),
              then drop <span className="font-mono">Trials</span> (last resort — affects tuning quality).
              Resizing IS/OOS bars trades total runtime against statistical confidence,
              not throughput.
            </p>
          </section>

        </div>

        <div className="px-5 py-3 border-t border-line flex justify-end">
          <button onClick={onClose}
                  className="px-4 py-2 text-sm rounded-md bg-accent-grad text-white font-semibold">
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}

const TONE = {
  profit: { badge: "🟢", cls: "border-profit/40 bg-profit/5" },
  amber:  { badge: "🟡", cls: "border-amber-400/40 bg-amber-400/5" },
  loss:   { badge: "🔴", cls: "border-loss/40 bg-loss/5" },
};

// One catalog entry. Steps are called with no context, so a verdict that names
// a specific parameter on the Verdict tab reads generically here.
function VerdictEntry({ v }) {
  const t = TONE[v.tone] || TONE.amber;
  const steps = v.steps({});
  return (
    <div className={`rounded-lg border p-3 space-y-2 ${t.cls}`}>
      <div className="text-sm font-semibold text-text">{t.badge} {v.label}</div>
      <div className="text-xs leading-relaxed">
        <span className="text-text">When: </span>
        <span className="text-muted">{v.when}</span>
      </div>
      <div className="text-xs leading-relaxed">
        <span className="text-text">Why: </span>
        <span className="text-muted">{v.why}</span>
      </div>
      <div className="text-xs">
        <div className="text-text mb-1">What to do:</div>
        <ol className="list-decimal pl-5 space-y-1 text-muted leading-relaxed">
          {steps.map((s, i) => <li key={i}>{s}</li>)}
        </ol>
      </div>
    </div>
  );
}

function FieldRow({ term, children }) {
  return (
    <div className="grid grid-cols-[170px_1fr] gap-3 items-baseline">
      <dt className="text-text font-mono text-xs">{term}</dt>
      <dd className="text-muted leading-relaxed">{children}</dd>
    </div>
  );
}
