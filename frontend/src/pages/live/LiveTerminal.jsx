import { useEffect, useRef, useState } from "react";
import "../../components/live/terminal.css";
import LeftRail from "../../components/live/LeftRail.jsx";
import TopBar from "../../components/live/TopBar.jsx";
import WorkspaceTabs from "../../components/live/WorkspaceTabs.jsx";
import StatusFooter from "../../components/live/StatusFooter.jsx";
import Panel from "../../components/live/Panel.jsx";
import CommandPalette from "../../components/live/CommandPalette.jsx";
import TradingWorkspace from "../../components/live/TradingWorkspace.jsx";
import StrategiesWorkspace from "../../components/live/StrategiesWorkspace.jsx";
import AlertsView from "../../components/live/AlertsView.jsx";
import { setKillSwitch } from "../../components/live/liveApi.js";
import { DataModeProvider, useDataMode } from "../../components/live/dataMode.jsx";
import { useEnterStagger } from "../../components/live/animations.js";
import { useGateway, useInstruments, useDeployments } from "../../components/live/hooks.js";
import { exitLive } from "../../services/appMode.js";

/** Backtest → live handoff: read + clear the deploy prefill left by the
 * research dashboard's "Go Live with this strategy" action. */
function takeDeployPrefill() {
  try {
    const raw = localStorage.getItem("ql.live_deploy_prefill");
    if (!raw) return null;
    localStorage.removeItem("ql.live_deploy_prefill");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

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

function WorkspaceHost({ ws, symbol, timeframe, onSymbol, onTimeframe, deploy, account, prefill, onPrefillConsumed }) {
  const ref = useRef(null);
  useEnterStagger(ws, ref);
  if (ws === "trading") {
    return (
      <TradingWorkspace
        symbol={symbol}
        timeframe={timeframe}
        onSymbol={onSymbol}
        onTimeframe={onTimeframe}
        deployments={deploy.deployments}
        account={account}
      />
    );
  }
  if (ws === "strategies") {
    return (
      <StrategiesWorkspace
        deployments={deploy.deployments}
        killswitch={deploy.killswitch}
        refresh={deploy.refresh}
        prefill={prefill}
        onPrefillConsumed={onPrefillConsumed}
      />
    );
  }
  const stub = {
    markets:    ["Markets", "08"],
    risk:       ["Risk", "08 / 09"],
    blotter:    ["Blotter", "07 / 08"],
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
  const gateway = useGateway();
  const { instruments } = useInstruments();
  const [symbol, setSymbol] = useState(() => {
    try { return localStorage.getItem("ql.live_symbol") || "BTCUSDT"; } catch { return "BTCUSDT"; }
  });
  const [timeframe, setTimeframe] = useState(() => {
    try { return localStorage.getItem("ql.live_tf") || "1m"; } catch { return "1m"; }
  });

  useEffect(() => { try { localStorage.setItem("ql.live_symbol", symbol); } catch { /* ignore */ } }, [symbol]);
  useEffect(() => { try { localStorage.setItem("ql.live_tf", timeframe); } catch { /* ignore */ } }, [timeframe]);

  const deploy = useDeployments();
  const runningCount = deploy.deployments.filter((d) => d.status === "RUNNING").length;
  const [prefill, setPrefill] = useState(() => takeDeployPrefill());

  // Backtest handoff: if the research side left a prefill, open Strategies.
  useEffect(() => {
    if (prefill) setWs("strategies");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleKill = async () => {
    const next = !deploy.killswitch;
    if (next && !window.confirm("DISARM ALL — pause every webhook immediately?\nNo POSTs will be sent until re-armed.")) return;
    try {
      await setKillSwitch(next);
      deploy.refresh();
    } catch { /* refresh will reflect the true state */ }
  };

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
        bellCount={runningCount}
        alertsActive={view === "alerts"}
        onBell={() => setView(view === "alerts" ? "workspaces" : "alerts")}
        onExitLive={() => exitLive()}
        dataMode={dataMode}
        onToggleDataMode={toggleDataMode}
        killed={deploy.killswitch}
        onToggleKill={toggleKill}
      />
      <WorkspaceTabs active={view === "workspaces" ? ws : null} onSelect={selectWs} onCommand={() => setPaletteOpen(true)} />
      <div className="lt-content">
        {view === "alerts"
          ? <AlertsView />
          : (
            <WorkspaceHost
              ws={ws}
              symbol={symbol}
              timeframe={timeframe}
              onSymbol={setSymbol}
              onTimeframe={setTimeframe}
              deploy={deploy}
              account="demo"
              prefill={prefill}
              onPrefillConsumed={() => setPrefill(null)}
            />
          )}
      </div>
      <StatusFooter gateway={gateway} dayPnl={null} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onWorkspace={selectWs}
        onAlerts={() => setView("alerts")}
        symbols={instruments.map((i) => i.symbol)}
        onSymbol={(s) => { setSymbol(s); selectWs("trading"); }}
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
