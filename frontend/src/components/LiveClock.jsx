import { useEffect, useState } from "react";

/**
 * Live UTC + PHT (Asia/Manila, UTC+8) clock. Updates every second.
 * 24-hour display so it lines up with how sessions are configured.
 */
export default function LiveClock() {
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const utc = now.toISOString().slice(11, 19);                  // HH:MM:SS in UTC
  const pht = new Date(now.getTime() + 8 * 3600 * 1000)
    .toISOString().slice(11, 19);                                // UTC+8 = Asia/Manila

  return (
    <div className="flex items-center gap-3 text-[11px] font-mono text-muted">
      <span title="Coordinated Universal Time">
        UTC <span className="text-text">{utc}</span>
      </span>
      <span className="text-line">·</span>
      <span title="Philippine Time (UTC+8)">
        PHT <span className="text-text">{pht}</span>
      </span>
    </div>
  );
}
