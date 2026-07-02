import { useEffect, useState } from "react";
import { fmtUsd } from "../../services/format.js";

/** UTC clock string HH:MM:SS. */
export function useUtcClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  const p = (n) => String(n).padStart(2, "0");
  return `${p(now.getUTCHours())}:${p(now.getUTCMinutes())}:${p(now.getUTCSeconds())}`;
}

/**
 * Top bar (54px): wordmark + venue chip | equity + day P&L | data-mode toggle,
 * kill switch, LIVE dot, clock, bell (alerts), Exit Live.
 */
export default function TopBar({
  equity, dayPnl, bellCount, alertsActive, onBell, onExitLive,
  dataMode, onToggleDataMode, killed, onToggleKill,
}) {
  const clock = useUtcClock();
  const pnlCls = dayPnl == null ? "lt-muted" : dayPnl >= 0 ? "lt-green" : "lt-red";
  return (
    <div className="lt-topbar">
      <div style={{ display: "flex", alignItems: "center", gap: 12, minWidth: 0 }}>
        <div className="lt-wordmark"><b>XlytheAI</b> <span>Terminal</span></div>
        <div className="lt-venue-chip">● BINANCE</div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
        <div className="lt-stat-block">
          <div className="lbl">Account Equity</div>
          <div className="val">{equity == null ? "—" : fmtUsd(equity)}</div>
        </div>
        <div className="lt-stat-block">
          <div className="lbl">Day P&L</div>
          <div className={`val ${pnlCls}`}>
            {dayPnl == null ? "—" : `${dayPnl >= 0 ? "+" : ""}${fmtUsd(dayPnl)}`}
          </div>
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <button
          className={`lt-topbtn ${dataMode === "mock" ? "mock-on" : ""}`}
          title="Flip every panel between the seeded mock feed and the real feed"
          onClick={onToggleDataMode}
        >
          DATA: {dataMode === "mock" ? "MOCK" : "LIVE"}
        </button>
        <button
          className={`lt-topbtn danger ${killed ? "engaged" : ""}`}
          title={killed ? "Webhooks blocked — click to re-arm" : "Pause every deployment and block all webhook POSTs immediately"}
          onClick={onToggleKill}
        >
          {killed ? "DISARMED — RE-ARM" : "DISARM ALL"}
        </button>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span className="lt-live-dot" />
          <span className="lt-live-label">LIVE</span>
        </div>
        <span className="lt-clock">{clock} UTC</span>
        <button className={`lt-bell ${alertsActive ? "active" : ""}`} title="Alerts" onClick={onBell}>
          <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" />
            <path d="M13.7 21a2 2 0 0 1-3.4 0" />
          </svg>
          {bellCount > 0 && <span className="lt-bell-badge">{bellCount}</span>}
        </button>
        <button className="lt-topbtn" onClick={onExitLive} title="Back to Research / Backtest">
          EXIT LIVE
        </button>
      </div>
    </div>
  );
}
