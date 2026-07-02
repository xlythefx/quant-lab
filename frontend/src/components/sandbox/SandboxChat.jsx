import { useEffect, useRef, useState } from "react";
import { streamStrategyBuilder } from "../../services/api.js";

/**
 * Claude-style chat for the Strategy Sandbox. Streams the builder turn over SSE,
 * renders user/assistant bubbles, small tool chips, and Approve/Reject cards for
 * any file change the AI proposes. The opaque Anthropic message array is the
 * source of truth for the next turn and is kept in a ref (re-sent each request).
 */
const WELCOME =
  "Hi! I'm your strategy builder. Tell me a trading idea in plain English — " +
  "for example: \"buy Bitcoin when it dips well below its recent average and sell " +
  "when it climbs back.\" I'll ask a few questions, then build, test, and tweak it " +
  "with you. Right now I can work with BTCUSDT (Bitcoin) and ES (S&P 500 futures).";

export default function SandboxChat({ symbol, timeframe, onBacktest, onStrategiesChanged }) {
  const [items, setItems] = useState([{ id: 0, role: "assistant", text: WELCOME }]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(null);   // {tool_use_id, name, input}

  const apiMessages = useRef([]);   // opaque message array for the API
  const idc = useRef(1);
  const scrollRef = useRef(null);
  const assistantId = useRef(null);

  const nextId = () => idc.current++;
  const push = (item) => setItems((xs) => [...xs, { id: nextId(), ...item }]);
  const patch = (id, fields) =>
    setItems((xs) => xs.map((x) => (x.id === id ? { ...x, ...fields } : x)));

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [items, busy]);

  function runTurn(payload) {
    setBusy(true);
    assistantId.current = null;
    let text = "";
    streamStrategyBuilder(
      { ...payload, symbol, timeframe },
      {
        onToken: ({ text: t }) => {
          text += t;
          if (assistantId.current == null) {
            const id = nextId();
            assistantId.current = id;
            setItems((xs) => [...xs, { id, role: "assistant", text }]);
          } else {
            patch(assistantId.current, { text });
          }
        },
        onToolRan: ({ summary }) => push({ role: "tool", text: summary }),
        onBacktest: ({ result }) => onBacktest?.(result),
        onStrategiesChanged: () => onStrategiesChanged?.(),
        onProposal: (p) => {
          setPending(p);
          push({ role: "proposal", proposal: p, resolved: null });
        },
        onState: ({ messages }) => { apiMessages.current = messages; },
        onError: ({ message }) => push({ role: "error", text: message }),
        onDone: () => setBusy(false),
        onClose: () => setBusy(false),
      }
    );
  }

  function send() {
    const text = input.trim();
    if (!text || busy || pending) return;
    setInput("");
    push({ role: "user", text });
    runTurn({ messages: apiMessages.current, user_input: text });
  }

  function resolve(approved) {
    if (!pending) return;
    const p = pending;
    setPending(null);
    setItems((xs) =>
      xs.map((x) =>
        x.role === "proposal" && x.proposal?.tool_use_id === p.tool_use_id
          ? { ...x, resolved: approved ? "approved" : "rejected" }
          : x
      )
    );
    runTurn({
      messages: apiMessages.current,
      pending_action: { tool_use_id: p.tool_use_id, name: p.name, input: p.input, approved },
    });
  }

  return (
    <div className="flex flex-col h-full bg-bg-panel/40">
      <div className="px-4 py-3 border-b border-line flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-accent-cyan shadow-[0_0_8px_#22d3ee]" />
        <span className="text-sm font-medium">Strategy Builder</span>
        <span className="text-xs text-muted ml-auto">Sonnet 4.6</span>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
        {items.map((it) => (
          <ChatItem key={it.id} item={it} onResolve={resolve} busy={busy} />
        ))}
        {busy && assistantId.current == null && !pending && (
          <div className="text-xs text-muted animate-pulse">thinking…</div>
        )}
      </div>

      <div className="border-t border-line p-3">
        {pending && (
          <div className="text-xs text-accent-cyan mb-2">
            Review the proposed change above — Approve or Reject to continue.
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
            }}
            placeholder={pending ? "Approve or reject the change first…" : "Describe a strategy idea…"}
            disabled={busy || !!pending}
            rows={2}
            className="flex-1 resize-none bg-bg border border-line rounded-lg px-3 py-2 text-sm text-text
                       placeholder:text-muted/60 focus:outline-none focus:border-accent-blue
                       disabled:opacity-50"
          />
          <button
            onClick={send}
            disabled={busy || !!pending || !input.trim()}
            className="px-4 py-2 rounded-lg text-sm font-medium bg-accent-grad text-white
                       disabled:opacity-30 disabled:cursor-not-allowed"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}

function ChatItem({ item, onResolve, busy }) {
  if (item.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-accent-blue/15 border border-accent-blue/30
                        px-3.5 py-2 text-sm text-text whitespace-pre-wrap">
          {item.text}
        </div>
      </div>
    );
  }
  if (item.role === "assistant") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[90%] rounded-2xl rounded-bl-sm bg-bg-elev/70 border border-line
                        px-3.5 py-2 text-sm text-text whitespace-pre-wrap leading-relaxed">
          {item.text || "…"}
        </div>
      </div>
    );
  }
  if (item.role === "tool") {
    return (
      <div className="text-xs text-muted flex items-center gap-1.5 pl-1">
        <span>🛠</span><span>{item.text}</span>
      </div>
    );
  }
  if (item.role === "error") {
    return (
      <div className="rounded-lg border border-loss/40 bg-loss/10 px-3 py-2 text-xs text-loss">
        {item.text}
      </div>
    );
  }
  if (item.role === "proposal") {
    return <ProposalCard item={item} onResolve={onResolve} busy={busy} />;
  }
  return null;
}

const ACTION_LABELS = {
  create_strategy: "Create strategy",
  edit_strategy: "Edit strategy",
  delete_strategy: "Delete strategy",
  archive_strategy: "Archive strategy",
};

function ProposalCard({ item, onResolve, busy }) {
  const { proposal, resolved } = item;
  const inp = proposal.input || {};
  const label = ACTION_LABELS[proposal.name] || proposal.name;
  const accent = proposal.name === "delete_strategy" ? "border-loss/50" : "border-accent-violet/50";

  return (
    <div className={`rounded-xl border ${accent} bg-bg-panel/80 p-3 space-y-2`}>
      <div className="flex items-center gap-2">
        <span className="text-xs uppercase tracking-wider font-semibold text-accent-violet">
          {label}
        </span>
        {inp.strategy_id && (
          <span className="text-xs font-mono text-muted">{inp.strategy_id}</span>
        )}
      </div>
      {inp.summary && <div className="text-sm text-text">{inp.summary}</div>}
      {inp.code && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted hover:text-text">View code</summary>
          <pre className="mt-2 max-h-72 overflow-auto rounded-lg bg-bg p-2 text-[11px] leading-snug
                          text-text/90 font-mono whitespace-pre">{inp.code}</pre>
        </details>
      )}
      {resolved ? (
        <div className={`text-xs font-medium ${resolved === "approved" ? "text-accent-cyan" : "text-muted"}`}>
          {resolved === "approved" ? "✓ Approved" : "✕ Rejected"}
        </div>
      ) : (
        <div className="flex gap-2 pt-1">
          <button
            onClick={() => onResolve(true)}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent-grad text-white disabled:opacity-40"
          >
            Approve
          </button>
          <button
            onClick={() => onResolve(false)}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-xs font-medium border border-line text-muted
                       hover:text-text disabled:opacity-40"
          >
            Reject
          </button>
        </div>
      )}
    </div>
  );
}
