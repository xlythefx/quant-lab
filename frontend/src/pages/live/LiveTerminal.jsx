import { useEffect, useRef, useState } from "react";
import "../../components/live/terminal.css";
import LeftRail from "../../components/live/LeftRail.jsx";
import TopBar from "../../components/live/TopBar.jsx";
import WorkspaceTabs from "../../components/live/WorkspaceTabs.jsx";
import StatusFooter from "../../components/live/StatusFooter.jsx";
import CommandPalette from "../../components/live/CommandPalette.jsx";
import TradingWorkspace from "../../components/live/TradingWorkspace.jsx";
import StrategiesWorkspace from "../../components/live/StrategiesWorkspace.jsx";
import AnalyticsWorkspace from "../../components/live/AnalyticsWorkspace.jsx";
import BlotterWorkspace from "../../components/live/BlotterWorkspace.jsx";
import MarketsWorkspace from "../../components/live/MarketsWorkspace.jsx";
import RiskWorkspace from "../../components/live/RiskWorkspace.jsx";
import AlertsView from "../../components/live/AlertsView.jsx";
import { setKillSwitch } from "../../components/live/liveApi.js";
import { DataModeProvider, useDataMode } from "../../components/live/dataMode.jsx";
import { useEnterStagger } from "../../components/live/animations.js";
import { useGateway, useInstruments, useDeployments, usePositionsRisk } from "../../components/live/hooks.js";
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

function WorkspaceHost({ ws, symbol, timeframe, onSymbol, onTimeframe, onGoTrading, deploy, account, prefill, onPrefillConsumed }) {
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
  if (ws === "analytics") return <AnalyticsWorkspace deployments={deploy.deployments} account={account} />;
  if (ws === "blotter") return <BlotterWorkspace orderEntry={{ symbol }} />;
  if (ws === "markets") return <MarketsWorkspace onSymbol={(s) => { onSymbol(s); onGoTrading?.(); }} />;
  if (ws === "risk") return <RiskWorkspace account={account} />;
  return null;
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
  const [account, setAccount] = useState(() => {
    try { return localStorage.getItem("ql.live_account") === "live" ? "live" : "demo"; } catch { return "demo"; }
  });
  useEffect(() => { try { localStorage.setItem("ql.live_account", account); } catch { /* ignore */ } }, [account]);

  // Top-bar equity / day P&L: only shown when REAL (WAMP reachable) — a
  // simulated number in the headline would be misleading.
  const { risk, simulated: riskSim } = usePositionsRisk(account);
  const headline = !riskSim && risk?.cards ? risk.cards : null;

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
        equity={headline?.equity ?? null}
        dayPnl={headline?.dayPnl ?? null}
        bellCount={runningCount}
        alertsActive={view === "alerts"}
        onBell={() => setView(view === "alerts" ? "workspaces" : "alerts")}
        onExitLive={() => exitLive()}
        dataMode={dataMode}
        onToggleDataMode={toggleDataMode}
        killed={deploy.killswitch}
        onToggleKill={toggleKill}
        account={account}
        onAccount={setAccount}
      />
      <WorkspaceTabs active={view === "workspaces" ? ws : null} onSelect={selectWs} onCommand={() => setPaletteOpen(true)} />
      <div className="lt-content">
        {view === "alerts"
          ? <AlertsView account={account} />
          : (
            <WorkspaceHost
              ws={ws}
              symbol={symbol}
              timeframe={timeframe}
              onSymbol={setSymbol}
              onTimeframe={setTimeframe}
              onGoTrading={() => selectWs("trading")}
              deploy={deploy}
              account={account}
              prefill={prefill}
              onPrefillConsumed={() => setPrefill(null)}
            />
          )}
      </div>
      <StatusFooter gateway={gateway} dayPnl={headline?.dayPnl ?? null} />
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
