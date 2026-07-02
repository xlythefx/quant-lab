import { useUtcClock } from "./TopBar.jsx";
import { fmtUsd } from "../../services/format.js";

/**
 * Status footer (24px). Left: gateway/latency/feed/session from the real
 * heartbeat (phase 03). Right: day P&L, clock, version.
 */
export default function StatusFooter({ gateway, dayPnl }) {
  const clock = useUtcClock();
  const feedOk = gateway?.feed === "OK";
  const stale = gateway == null;
  return (
    <div className="lt-footer">
      <div style={{ display: "flex", alignItems: "center", gap: 14, minWidth: 0 }}>
        <span>
          <span className={`dot ${stale || !feedOk ? "bad" : "ok"}`} />
          GATEWAY {stale ? "…" : "QL-LOCAL"}
        </span>
        <span>LATENCY {stale || gateway.latencyMs == null ? "…" : `${Math.round(gateway.latencyMs)}ms`}</span>
        <span className={feedOk ? "" : "lt-red"}>FEED {stale ? "…" : gateway.feed}</span>
        <span>SESSION {stale ? "…" : gateway.session}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        {dayPnl != null && (
          <span className={dayPnl >= 0 ? "lt-green" : "lt-red"}>
            DAY P&L {dayPnl >= 0 ? "+" : ""}{fmtUsd(dayPnl)}
          </span>
        )}
        <span>{clock} UTC</span>
        <span>QL-LIVE v1.0</span>
      </div>
    </div>
  );
}
