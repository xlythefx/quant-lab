import { useEffect, useState } from "react";
import { socket } from "../services/socket.js";
import LiveClock from "./LiveClock.jsx";

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
          <div className="w-8 h-8 rounded-lg bg-accent-grad" />
          <div className="text-lg font-semibold tracking-tight">
            Quant<span className="text-accent-blue">lab</span>
          </div>
        </div>

        <div className="flex items-center gap-1 ml-4">
          <NavLink href="#dashboard"  active={view === "dashboard"}>Dashboard</NavLink>
          <NavLink href="#analytics"   active={view === "analytics"}>Analytics</NavLink>
          <NavLink href="#walkforward" active={view === "walkforward"}>Walk-Forward</NavLink>
          <NavLink href="#strategies"  active={view === "strategies"}>Strategies</NavLink>
          <NavLink href="#settings"   active={view === "settings"}>Risk</NavLink>
        </div>
      </div>

      <div className="flex items-center gap-4">
        {onModeChange && (
          <ModeToggleInline mode={mode} onChange={onModeChange} />
        )}
        <LiveClock />
        <div className="flex items-center gap-2 text-xs text-muted">
          <span
            className={`w-2 h-2 rounded-full ${
              connected ? "bg-accent-cyan shadow-[0_0_8px_#22d3ee]" : "bg-loss"
            }`}
          />
          {connected ? "live socket" : "disconnected"}
        </div>
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
