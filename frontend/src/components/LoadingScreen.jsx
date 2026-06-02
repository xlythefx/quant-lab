import { useEffect, useState } from "react";

const PHRASES = [
  "Initializing platform…",
  "Loading market data…",
  "Ready",
];

export default function LoadingScreen({ onDone }) {
  const [phraseIdx, setPhraseIdx] = useState(0);
  const [exiting,   setExiting]   = useState(false);

  useEffect(() => {
    const t = [
      setTimeout(() => setPhraseIdx(1), 700),
      setTimeout(() => setPhraseIdx(2), 1380),
      setTimeout(() => setExiting(true), 1820),
      setTimeout(onDone,                 2380),
    ];
    return () => t.forEach(clearTimeout);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className={`ls-root${exiting ? " ls-exit" : ""}`}>

      {/* background orbs — reuse existing float-a / float-b keyframes */}
      <div className="ls-orb-1" />
      <div className="ls-orb-2" />

      {/* grid overlay */}
      <div className="pointer-events-none absolute inset-0" style={{
        backgroundImage: `
          linear-gradient(rgba(255,255,255,0.018) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.018) 1px, transparent 1px)
        `,
        backgroundSize: "64px 64px",
      }} />

      {/* radar rings (centered on logo) */}
      <div className="ls-rings" aria-hidden="true">
        <div className="ls-ring" style={{ animationDelay: "0s" }} />
        <div className="ls-ring" style={{ animationDelay: "0.65s" }} />
        <div className="ls-ring" style={{ animationDelay: "1.3s" }} />
      </div>

      {/* logo + wordmark */}
      <div className="ls-logo-wrap">
        <svg width="58" height="58" viewBox="0 0 64 64" fill="none" className="ls-logo-svg">
          <ellipse cx="32" cy="32" rx="28" ry="11"
            stroke="url(#lsg1)" strokeWidth="1.5" fill="none" opacity="0.8" />
          <ellipse cx="32" cy="32" rx="28" ry="11"
            stroke="url(#lsg2)" strokeWidth="1.5" fill="none" opacity="0.6"
            transform="rotate(60 32 32)" />
          <ellipse cx="32" cy="32" rx="28" ry="11"
            stroke="url(#lsg3)" strokeWidth="1.5" fill="none" opacity="0.6"
            transform="rotate(120 32 32)" />
          <circle cx="32" cy="32" r="4.5" fill="url(#lsg1)" />
          <circle cx="60" cy="32" r="2.5" fill="#22d3ee" opacity="0.95" />
          <defs>
            <linearGradient id="lsg1" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
              <stop stopColor="#3b82f6" /><stop offset="1" stopColor="#8b5cf6" />
            </linearGradient>
            <linearGradient id="lsg2" x1="64" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
              <stop stopColor="#8b5cf6" /><stop offset="1" stopColor="#22d3ee" />
            </linearGradient>
            <linearGradient id="lsg3" x1="0" y1="64" x2="64" y2="0" gradientUnits="userSpaceOnUse">
              <stop stopColor="#22d3ee" /><stop offset="1" stopColor="#3b82f6" />
            </linearGradient>
          </defs>
        </svg>

        <div className="ls-wordmark">QuantLab</div>
      </div>

      {/* cycling status phrase — key forces re-mount for fade-in replay */}
      <p className="ls-phrase" key={phraseIdx}>{PHRASES[phraseIdx]}</p>

      {/* progress bar */}
      <div className="ls-bar-track" aria-hidden="true">
        <div className="ls-bar-fill" />
      </div>

    </div>
  );
}
