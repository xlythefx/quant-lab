import { useEffect, useMemo, useRef, useState } from "react";
import IconNavRail from "../components/dashboardv2/IconNavRail.jsx";
import { usePersistentState } from "../services/usePersistentState.js";
import { MODULES, SMOOTHING, PLAN, TUTORIALS } from "../content/modules.js";

/**
 * Modules — study material for a starting quant, one section per page.
 *
 * The left rail is the pager: concept modules, the equity-smoothing levers,
 * the in-app tutorials, and the phased plan with persisted checkboxes.
 * Search (top-left) cuts across every page and shows a flat result list.
 *
 * Content lives in content/modules.js; this file only renders it.
 */

// Page order. Numbering is derived from position so content can be reordered freely.
const PAGES = [
  ...MODULES.map((m) => ({ kind: "concepts", ...m })),
  { kind: "levers", id: "smoothing", title: "Smoother curve, higher Sharpe",
    blurb: "Sharpe is an outcome, not a dial. These are the levers that actually move it — ordered from 'always helps' to 'helps but can fool you' — each with the catch.",
    items: SMOOTHING },
  ...TUTORIALS.map((t) => ({ kind: "tutorial", ...t })),
  { kind: "plan", id: "plan", title: "Starting-quant plan & checklist",
    blurb: "Phases in order. Tick a step only when you can point at the number that proves it. Boxes are saved in this browser.",
    items: PLAN },
];
const GROUPS = [
  { label: "Concepts", kinds: ["concepts"] },
  { label: "Practice", kinds: ["levers", "tutorial"] },
  { label: "Plan", kinds: ["plan"] },
];

const norm = (s) => (s || "").toLowerCase();
const hit = (q, ...fields) => fields.some((f) => norm(f).includes(q));

export default function Modules() {
  const [query, setQuery] = useState("");
  const [pageId, setPageId] = usePersistentState("ql.modules.page", PAGES[0].id);
  const [checks, setChecks] = usePersistentState("ql.modules.checks", {});
  const mainRef = useRef(null);
  const q = query.trim().toLowerCase();

  const pageIdx = Math.max(0, PAGES.findIndex((p) => p.id === pageId));
  const page = PAGES[pageIdx];
  // Turn direction drives the slide animation (next → from the right, prev → from the left).
  const [dir, setDir] = useState("next");
  const goTo = (id) => {
    const to = PAGES.findIndex((p) => p.id === id);
    setDir(to >= pageIdx ? "next" : "prev");
    setPageId(id);
    setQuery("");
    mainRef.current?.scrollTo({ top: 0 });
  };

  // Keyboard paging: ← / → when not typing in the search box.
  useEffect(() => {
    const onKey = (e) => {
      if (e.target.tagName === "INPUT") return;
      if (e.key === "ArrowRight" && pageIdx < PAGES.length - 1) goTo(PAGES[pageIdx + 1].id);
      if (e.key === "ArrowLeft" && pageIdx > 0) goTo(PAGES[pageIdx - 1].id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pageIdx]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flat search across every page: [{page, label, body}]
  const results = useMemo(() => {
    if (!q) return [];
    const out = [];
    for (const p of PAGES) {
      if (p.kind === "concepts") for (const it of p.items) {
        if (hit(q, it.term, it.plain, it.why, it.inApp, it.caution, it.formula)) out.push({ page: p, label: it.term, body: it.plain });
      }
      if (p.kind === "levers") for (const s of p.items) {
        if (hit(q, s.title, s.how, s.why, s.catch)) out.push({ page: p, label: s.title, body: s.how });
      }
      if (p.kind === "tutorial") p.steps.forEach((s, i) => {
        if (hit(q, s.title, s.do, s.look, s.good, s.bad)) out.push({ page: p, label: `Step ${i + 1} · ${s.title}`, body: s.do });
      });
      if (p.kind === "plan") for (const ph of p.items) for (const s of ph.steps) {
        if (hit(q, s.text, ph.title)) out.push({ page: p, label: ph.title, body: s.text });
      }
    }
    return out;
  }, [q]);

  const totalSteps = PLAN.reduce((a, p) => a + p.steps.length, 0);
  const doneSteps = PLAN.reduce((a, p) => a + p.steps.filter((s) => checks[s.id]).length, 0);
  const toggle = (id) => setChecks((c) => ({ ...c, [id]: !c[id] }));
  const resetChecks = () => { if (window.confirm("Clear every checkbox?")) setChecks({}); };

  const prev = pageIdx > 0 ? PAGES[pageIdx - 1] : null;
  const next = pageIdx < PAGES.length - 1 ? PAGES[pageIdx + 1] : null;

  return (
    <div className="flex h-screen">
      <IconNavRail view="modules" />

      <div className="flex flex-1 min-h-0">
        {/* pager */}
        <aside className="w-72 shrink-0 border-r border-line bg-bg-panel/40 flex flex-col h-full">
          <div className="px-4 py-3 border-b border-line">
            <div className="text-[10px] uppercase tracking-widest text-muted">Modules</div>
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search everything… (alpha, ATR, embargo)"
              className="mt-2 w-full px-3 h-9 text-sm rounded-lg bg-bg-panel border border-line text-text placeholder:text-muted/60 focus:outline-none focus:border-accent-blue"
            />
          </div>
          <nav className="flex-1 overflow-y-auto p-3 space-y-3">
            {GROUPS.map((g) => (
              <div key={g.label}>
                <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-muted/70">{g.label}</div>
                {PAGES.map((p, i) => g.kinds.includes(p.kind) && (
                  <button
                    key={p.id}
                    onClick={() => goTo(p.id)}
                    className={`w-full text-left flex items-baseline gap-2 px-3 py-1.5 rounded-lg text-sm transition ${
                      !q && p.id === page.id ? "bg-bg-elev text-text" : "text-muted hover:text-text hover:bg-bg-elev/50"
                    }`}
                  >
                    <span className="text-[10px] font-mono text-muted/70 w-5 shrink-0">{String(i + 1).padStart(2, "0")}</span>
                    <span className="truncate">{p.title}</span>
                  </button>
                ))}
              </div>
            ))}
          </nav>
          <div className="p-3 border-t border-line">
            <div className="flex items-center justify-between text-[11px] font-mono mb-1.5">
              <span className="text-muted">Plan progress</span>
              <span className="text-text">{doneSteps} / {totalSteps}</span>
            </div>
            <div className="h-1.5 rounded bg-bg-elev overflow-hidden">
              <div className="h-full bg-accent-grad transition-all" style={{ width: `${totalSteps ? (doneSteps / totalSteps) * 100 : 0}%` }} />
            </div>
          </div>
        </aside>

        <main ref={mainRef} className="flex-1 min-w-0 overflow-y-auto">
          {q ? (
            <SearchResults query={query} results={results} onOpen={goTo} />
          ) : (
            // key={page.id} remounts the block on every turn so the animation replays.
            <div key={page.id} className={dir === "next" ? "mod-turn-next" : "mod-turn-prev"}>
              <div className="px-6 pt-5 pb-4 border-b border-line relative">
                <div className="text-[10px] uppercase tracking-widest text-muted">
                  Module {pageIdx + 1} of {PAGES.length}
                  {page.link && <> · <a href={page.link} className="text-accent-blue hover:underline normal-case tracking-normal">open the page →</a></>}
                </div>
                <h1 className="text-2xl font-semibold tracking-tight text-text mt-1">{page.title}</h1>
                {(page.blurb || page.intro) && <div className="text-sm text-muted mt-1.5 max-w-3xl leading-relaxed">{page.blurb || page.intro}</div>}
                <div className="mod-sweep absolute left-0 bottom-0 h-px bg-accent-grad" style={{ width: `${((pageIdx + 1) / PAGES.length) * 100}%` }} />
              </div>

              <div className="px-6 py-6 max-w-5xl">
                {page.kind === "concepts" && (
                  <div className="grid grid-cols-1 xl:grid-cols-2 gap-3">
                    {page.items.map((it, i) => <Reveal key={it.term} i={i}><TermCard it={it} /></Reveal>)}
                  </div>
                )}
                {page.kind === "levers" && (
                  <div className="space-y-3">
                    {page.items.map((s, i) => <Reveal key={s.title} i={i}><LeverCard s={s} n={i + 1} /></Reveal>)}
                  </div>
                )}
                {page.kind === "tutorial" && (
                  <div className="space-y-3">
                    {page.steps.map((s, i) => <Reveal key={s.title} i={i}><StepCard s={s} n={i + 1} /></Reveal>)}
                  </div>
                )}
                {page.kind === "plan" && (
                  <div className="space-y-4">
                    <div className="flex justify-end">
                      <button onClick={resetChecks} className="text-[11px] text-muted hover:text-loss transition">reset all</button>
                    </div>
                    {page.items.map((p, i) => <Reveal key={p.id} i={i}><PhaseCard p={p} checks={checks} onToggle={toggle} /></Reveal>)}
                  </div>
                )}

                {/* pager footer */}
                <div className="flex items-center justify-between gap-4 mt-10 pt-5 border-t border-line">
                  <PagerButton page={prev} dir="prev" onClick={goTo} />
                  <span className="text-[11px] font-mono text-muted/70">← → to page</span>
                  <PagerButton page={next} dir="next" onClick={goTo} />
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

// Staggered card reveal: --i feeds the CSS animation-delay (see .mod-card).
function Reveal({ i, children }) {
  return <div className="mod-card" style={{ "--i": Math.min(i, 14) }}>{children}</div>;
}

function PagerButton({ page, dir, onClick }) {
  if (!page) return <span className="w-40" />;
  return (
    <button
      onClick={() => onClick(page.id)}
      className={`max-w-[45%] px-4 py-2.5 rounded-xl border border-line hover:border-accent-blue/60 text-left transition ${dir === "next" ? "ml-auto text-right" : ""}`}
    >
      <div className="text-[10px] uppercase tracking-wider text-muted">{dir === "next" ? "Next →" : "← Previous"}</div>
      <div className="text-sm text-text truncate">{page.title}</div>
    </button>
  );
}

function SearchResults({ query, results, onOpen }) {
  return (
    <div className="px-6 py-6 max-w-4xl">
      <div className="text-xs text-muted mb-4">
        {results.length} match{results.length === 1 ? "" : "es"} for “{query}” — click one to open its module.
      </div>
      {results.length === 0 && <div className="text-sm text-muted">Nothing matches. Try a shorter word.</div>}
      <div className="space-y-2">
        {results.map((r, i) => (
          <button
            key={i}
            onClick={() => onOpen(r.page.id)}
            className="w-full text-left rounded-xl border border-line bg-bg-panel/40 hover:border-accent-blue/60 px-4 py-3 transition"
          >
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-text">{r.label}</div>
              <div className="text-[10px] uppercase tracking-wider text-muted shrink-0">{r.page.title}</div>
            </div>
            <div className="text-xs text-muted mt-1 line-clamp-2">{r.body}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

function TermCard({ it }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
      <div className="text-sm font-semibold text-text">{it.term}</div>
      <p className="text-sm text-text/90 mt-1.5 leading-relaxed">{it.plain}</p>
      <div className="mt-2.5 text-xs leading-relaxed">
        <span className="text-[10px] uppercase tracking-wider text-accent-cyan mr-1.5">Why it matters</span>
        <span className="text-muted">{it.why}</span>
      </div>
      {it.formula && (
        <pre className="mt-2.5 px-3 py-2 rounded-lg bg-bg-elev/60 border border-line/60 text-[11px] font-mono text-text/90 leading-relaxed whitespace-pre-wrap overflow-x-auto">
          {it.formula}
        </pre>
      )}
      {it.caution && (
        <div className="mt-2 text-xs leading-relaxed">
          <span className="text-[10px] uppercase tracking-wider text-loss/90 mr-1.5">Watch out</span>
          <span className="text-muted">{it.caution}</span>
        </div>
      )}
      {it.inApp && (
        <div className="mt-2.5 text-[11px] font-mono text-muted/80">
          <span className="text-[10px] uppercase tracking-wider text-muted mr-1.5">In QuantLab</span>
          {it.link ? <a href={it.link} className="text-accent-blue hover:underline">{it.inApp}</a> : it.inApp}
        </div>
      )}
    </div>
  );
}

function LeverCard({ s, n }) {
  const negative = s.title.startsWith("What NOT");
  return (
    <div className={`rounded-xl border p-4 ${negative ? "border-loss/40 bg-loss/5" : "border-line bg-bg-panel/40"}`}>
      <div className="flex items-center gap-2">
        <span className={`text-[11px] font-mono ${negative ? "text-loss" : "text-muted"}`}>{String(n).padStart(2, "0")}</span>
        <div className="text-sm font-semibold text-text">{s.title}</div>
        {s.inApp && <a href={s.inApp} className="ml-auto text-[11px] font-mono text-accent-blue hover:underline">{s.inApp}</a>}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-2.5 text-xs leading-relaxed">
        <div><div className="text-[10px] uppercase tracking-wider text-muted mb-0.5">How</div><div className="text-text/90">{s.how}</div></div>
        <div><div className="text-[10px] uppercase tracking-wider text-accent-cyan mb-0.5">Why it works</div><div className="text-muted">{s.why}</div></div>
        <div><div className="text-[10px] uppercase tracking-wider text-loss/90 mb-0.5">The catch</div><div className="text-muted">{s.catch}</div></div>
      </div>
    </div>
  );
}

// One tutorial step: do → look at → good / bad reading.
function StepCard({ s, n }) {
  return (
    <div className="rounded-xl border border-line bg-bg-panel/40 p-4">
      <div className="flex items-center gap-3">
        <span className="w-7 h-7 rounded-full bg-accent-blue/15 text-accent-blue text-xs font-mono font-semibold flex items-center justify-center shrink-0">{n}</span>
        <div className="text-sm font-semibold text-text">{s.title}</div>
      </div>
      <p className="text-sm text-text/90 mt-2.5 leading-relaxed">{s.do}</p>
      <div className="mt-2.5 text-xs leading-relaxed">
        <span className="text-[10px] uppercase tracking-wider text-muted mr-1.5">Look at</span>
        <span className="text-muted">{s.look}</span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-2.5 text-xs leading-relaxed">
        <div className="rounded-lg border border-profit/30 bg-profit/5 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-profit mb-0.5">Good sign</div>
          <div className="text-text/90">{s.good}</div>
        </div>
        <div className="rounded-lg border border-loss/30 bg-loss/5 p-2.5">
          <div className="text-[10px] uppercase tracking-wider text-loss mb-0.5">Bad sign</div>
          <div className="text-text/90">{s.bad}</div>
        </div>
      </div>
    </div>
  );
}

function PhaseCard({ p, checks, onToggle }) {
  const done = p.steps.filter((s) => checks[s.id]).length;
  const complete = done === p.steps.length;
  return (
    <div className={`rounded-xl border p-4 ${complete ? "border-profit/40 bg-profit/5" : "border-line bg-bg-panel/40"}`}>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-sm font-semibold text-text">{p.title}</div>
          <div className="text-xs text-muted mt-0.5">{p.goal}</div>
        </div>
        <span className={`text-[11px] font-mono shrink-0 ${complete ? "text-profit" : "text-muted"}`}>{done} / {p.steps.length}</span>
      </div>
      <ul className="mt-3 space-y-1.5">
        {p.steps.map((s) => (
          <li key={s.id}>
            <label className="flex items-start gap-2.5 cursor-pointer group">
              <input type="checkbox" checked={!!checks[s.id]} onChange={() => onToggle(s.id)} className="mt-0.5 accent-[#3b82f6]" />
              <span className={`text-sm leading-relaxed transition ${checks[s.id] ? "text-muted line-through" : "text-text/90 group-hover:text-text"}`}>{s.text}</span>
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
}
