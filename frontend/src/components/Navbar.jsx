import { useEffect, useRef, useState } from "react";
import { socket } from "../services/socket.js";
import LiveClock from "./LiveClock.jsx";
import { logout } from "../services/auth.js";
import { goLive } from "../services/appMode.js";
import BrandAtom from "./BrandAtom.jsx";

// Grouped under the "Validation" dropdown to keep the top bar uncluttered.
const VALIDATION_ITEMS = [
  { href: "#walkforward", view: "walkforward", label: "Walk-Forward" },
  { href: "#gridsearch",  view: "gridsearch",  label: "Grid Search" },
  { href: "#overnight",   view: "overnight",   label: "Overnight" },
  { href: "#montecarlo",  view: "montecarlo",  label: "Monte Carlo" },
  { href: "#costsweep",   view: "costsweep",   label: "Cost Sweep" },
  { href: "#reportimport", view: "reportimport", label: "Report Import" },
];

export default function Navbar({ view = "dashboard", mode, onModeChange }) {
  const [connected, setConnected] = useState(socket.connected);

  useEffect(() => {
    const onC = () => setConnected(true);
    const onD = () => setConnected(false);
    socket.on("connect", onC);
    socket.on("disconnect", onD);
    return () => {
      socket.off("connect", onC);
      socket.off("disconnect", onD);
    };
  }, []);

  return (
    <nav className="flex items-center justify-between px-6 py-4 border-b border-line bg-bg-panel/60 backdrop-blur">
      <div className="flex items-center gap-6">
        <div className="flex items-center gap-3">
          <BrandAtom size={30} />
          <div className="text-lg font-semibold tracking-tight">
            Quant<span className="text-accent-blue">lab</span>
          </div>
        </div>

        <div className="flex items-center gap-1 ml-4">
          <NavLink href="#dashboardv2" active={view === "dashboardv2"}>Dashboard V2</NavLink>
          <NavDropdown label="Validation" items={VALIDATION_ITEMS} view={view} />
          <NavLink href="#marketlab"   active={view === "marketlab"}>Market Lab</NavLink>
          <NavLink href="#downloads"   active={view === "downloads"}>Downloads</NavLink>
          <NavLink href="#skills"      active={view === "skills"}>Skills</NavLink>
          <NavLink href="#strategies"  active={view === "strategies"}>Strategies</NavLink>
          <NavLink href="#livealerts"  active={view === "livealerts"}>Live Alerts</NavLink>
          <NavLink href="#settings"   active={view === "settings"}>Risk</NavLink>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {onModeChange && (
          <ModeToggleInline mode={mode} onChange={onModeChange} />
        )}
        <button
          onClick={goLive}
          title="Switch to the Live Terminal"
          className="px-3 py-1 rounded-md border border-[#00d4a1]/50 text-[#00d4a1] hover:bg-[#00d4a1]/10 text-xs font-semibold tracking-wider transition flex items-center gap-1.5"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-[#00d4a1] animate-pulse" />
          GO LIVE
        </button>
        <LiveClock />
        <div className="flex items-center gap-2 text-xs text-muted">
          <span
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-accent-cyan shadow-[0_0_8px_#22d3ee]" : "bg-loss"
            }`}
          />
          {connected ? "live socket" : "disconnected"}
        </div>
        <button
          onClick={() => { logout(); window.location.hash = "#landing"; }}
          className="px-3 py-1 rounded-md border border-line text-muted hover:text-loss hover:border-loss/50 text-xs transition"
        >
          Sign Out
        </button>
      </div>
    </nav>
  );
}

function NavLink({ href, active, children }) {
  return (
    <a
      href={href}
      className={`px-3 py-1.5 text-sm rounded-md transition ${
        active ? "text-text bg-bg-elev" : "text-muted hover:text-text"
      }`}
    >
      {children}
    </a>
  );
}

// Click-to-open nav group. Highlights when any child view is active; closes on
// outside click or after picking an item.
function NavDropdown({ label, items, view }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active = items.some((it) => it.view === view);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`flex items-center gap-1 px-3 py-1.5 text-sm rounded-md transition ${
          active || open ? "text-text bg-bg-elev" : "text-muted hover:text-text"
        }`}
      >
        {label}
        <svg className={`w-3 h-3 transition-transform ${open ? "rotate-180" : ""}`}
             viewBox="0 0 12 12" fill="none" aria-hidden="true">
          <path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" strokeWidth="1.5"
                strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="absolute left-0 top-full mt-1 min-w-[160px] rounded-lg border border-line bg-bg-panel shadow-xl shadow-black/40 py-1 z-50">
          {items.map((it) => (
            <a
              key={it.view}
              href={it.href}
              onClick={() => setOpen(false)}
              className={`block px-3 py-1.5 text-sm transition ${
                it.view === view
                  ? "text-text bg-bg-elev"
                  : "text-muted hover:text-text hover:bg-bg-elev/50"
              }`}
            >
              {it.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

function ModeToggleInline({ mode, onChange }) {
  const opts = ["backtest", "live"];
  return (
    <div className="flex items-center gap-1 p-1 rounded-lg border border-line bg-bg-elev">
      {opts.map((m) => (
        <button
          key={m}
          onClick={() => onChange(m)}
          className={`px-3 py-1 text-xs font-medium uppercase tracking-wider rounded-md transition ${
            mode === m
              ? "bg-accent-grad text-white shadow"
              : "text-muted hover:text-text"
          }`}
        >
          {m}
        </button>
      ))}
    </div>
  );
}
