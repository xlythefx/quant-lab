import { useEffect, useRef, useState } from "react";
import Panel from "./Panel.jsx";
import * as sim from "./simFeed.js";

/**
 * News feed — auto-scrolling headlines + sentiment tags. SIMULATED headlines
 * (no wire yet); marquee pauses on hover, per the handoff motion spec.
 */
export default function NewsPanel() {
  const [items] = useState(() => sim.mockNews());
  const scrollRef = useRef(null);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let y = 0;
    const t = setInterval(() => {
      if (paused || !el) return;
      y += 0.4;
      if (y >= el.scrollHeight / 2) y = 0;
      el.style.transform = `translateY(${-y}px)`;
    }, 50);
    return () => clearInterval(t);
  }, [paused]);

  const tagColor = { BULLISH: "lt-green", BEARISH: "lt-red", NEUTRAL: "lt-muted" };
  const doubled = [...items, ...items]; // seamless loop

  return (
    <Panel title="News Feed" simulated>
      <div
        style={{ overflow: "hidden", height: "100%" }}
        onMouseEnter={() => setPaused(true)}
        onMouseLeave={() => setPaused(false)}
      >
        <div ref={scrollRef}>
          {doubled.map((n, i) => {
            const d = new Date(n.t);
            const hh = `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
            return (
              <div key={i} style={{ padding: "5px 10px", borderBottom: "1px solid var(--lt-row)" }}>
                <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
                  <span className="lt-mono lt-dim" style={{ fontSize: 8.5 }}>{hh}</span>
                  <span className={`lt-mono ${tagColor[n.sentiment] || "lt-muted"}`} style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.08em" }}>
                    {n.sentiment}
                  </span>
                </div>
                <div style={{ fontSize: 10, color: "var(--lt-text)", marginTop: 1 }}>{n.headline}</div>
              </div>
            );
          })}
        </div>
      </div>
    </Panel>
  );
}
