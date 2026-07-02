import { useEffect, useRef, useState } from "react";
import "../../components/live/terminal.css";
import LeftRail from "../../components/live/LeftRail.jsx";
import TopBar from "../../components/live/TopBar.jsx";
import WorkspaceTabs from "../../components/live/WorkspaceTabs.jsx";
import StatusFooter from "../../components/live/StatusFooter.jsx";
import Panel from "../../components/live/Panel.jsx";
import CommandPalette from "../../components/live/CommandPalette.jsx";
import { DataModeProvider, useDataMode } from "../../components/live/dataMode.jsx";
import { useEnterStagger } from "../../components/live/animations.js";
import { exitLive } from "../../services/appMode.js";

/**
 * The Live Terminal shell — 52px rail | 54px top bar | 32px tabs | content |
 * 24px footer. Its OWN pristine UI (handoff design); shares only backend
 * connections with the backtest world. See plans/EXECUTION-NOTES.md.
 */

function ComingSoon({ title, phase }) {
  return (
    <Panel title={title}>
      <div className="lt-empty" style={{ paddingTop: 60 }}>
        {title} — coming in {phase}
      </div>
    </Panel>
  );
}

function WorkspaceHost({ ws }) {
  const ref = useRef(null);
  useEnterStagger(ws, ref);
  const stub = {
    trading:    ["Trading", "04"],
    markets:    ["Markets", "08"],
    risk:       ["Risk", "08 / 09"],
    blotter:    ["Blotter", "07 / 08"],
    strategies: ["Strategies", "05"],
    analytics:  ["Analytics", "07"],
  }[ws];
  return (
    <div ref={ref} className="lt-ws grid" style={{ gridTemplateRows: "1fr" }}>
      <ComingSoon title={stub[0]} phase={stub[1]} />
    </div>
  );
}

function TerminalInner() {
  const [ws, setWs] = useState(() => {
    try { return localStorage.getItem("ql.live_ws") || "trading"; } catch { return "trading"; }
  });
  const [view, setView] = useState("workspaces"); // "workspaces" | "alerts"
  const [paletteOpen, setPaletteOpen] = useState(false);
  const { dataMode, toggleDataMode } = useDataMode();

  // Stubs until later phases wire them: equity/dayPnl (09), bell count (05), kill switch (06).
  const [killed, setKilled] = useState(false);

  useEffect(() => {
    try { localStorage.setItem("ql.live_ws", ws); } catch { /* ignore */ }
  }, [ws]);

  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const selectWs = (id) => { setView("workspaces"); setWs(id); };

  return (
    <div className="live-terminal">
      <LeftRail active={view === "workspaces" ? ws : null} onSelect={selectWs} onCommand={() => setPaletteOpen(true)} />
      <TopBar
        equity={null}
        dayPnl={null}
        bellCount={0}
        alertsActive={view === "alerts"}
        onBell={() => setView(view === "alerts" ? "workspaces" : "alerts")}
        onExitLive={() => exitLive()}
        dataMode={dataMode}
        onToggleDataMode={toggleDataMode}
        killed={killed}
        onToggleKill={() => setKilled((k) => !k)}
      />
      <WorkspaceTabs active={view === "workspaces" ? ws : null} onSelect={selectWs} onCommand={() => setPaletteOpen(true)} />
      <div className="lt-content">
        {view === "alerts"
          ? (
            <div className="lt-ws grid" style={{ gridTemplateRows: "1fr" }}>
              <ComingSoon title="Alerts" phase="06" />
            </div>
          )
          : <WorkspaceHost ws={ws} />}
      </div>
      <StatusFooter gateway={null} dayPnl={null} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onWorkspace={selectWs}
        onAlerts={() => setView("alerts")}
        symbols={[]}
      />
    </div>
  );
}

export default function LiveTerminal() {
  return (
    <DataModeProvider>
      <TerminalInner />
    </DataModeProvider>
  );
}
