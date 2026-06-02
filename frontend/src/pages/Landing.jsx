const FEATURES = [
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
      </svg>
    ),
    label: "Strategy Backtesting",
    desc: "Replay years of market data at high speed with precise fill simulation.",
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <rect x="3" y="3" width="7" height="7" rx="1" />
        <rect x="14" y="3" width="7" height="7" rx="1" />
        <rect x="3" y="14" width="7" height="7" rx="1" />
        <rect x="14" y="14" width="7" height="7" rx="1" />
      </svg>
    ),
    label: "Walk-Forward & Grid",
    desc: "Automated parameter optimization across time windows and grids.",
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M18 20V10" /><path d="M12 20V4" /><path d="M6 20v-6" />
      </svg>
    ),
    label: "Portfolio Analytics",
    desc: "Sharpe, drawdown curves, Monte Carlo, and multi-strategy attribution.",
  },
  {
    icon: (
      <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6">
        <path d="M22 17H2a3 3 0 0 0 3-3V9a7 7 0 0 1 14 0v5a3 3 0 0 0 3 3zm-8.27 4a2 2 0 0 1-3.46 0" />
      </svg>
    ),
    label: "Live Alerts",
    desc: "Real-time strategy signals dispatched via webhook to any platform.",
  },
];

export default function Landing() {
  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg flex flex-col items-center justify-center select-none">

      {/* Animated orbs */}
      <div className="orb-a pointer-events-none absolute" style={{
        width: 700, height: 700, borderRadius: "50%",
        top: "-18%", right: "-6%",
        background: "radial-gradient(circle, rgba(139,92,246,0.32) 0%, transparent 70%)",
        filter: "blur(90px)",
      }} />
      <div className="orb-b pointer-events-none absolute" style={{
        width: 620, height: 620, borderRadius: "50%",
        bottom: "-14%", left: "-8%",
        background: "radial-gradient(circle, rgba(59,130,246,0.28) 0%, transparent 70%)",
        filter: "blur(90px)",
      }} />
      <div className="orb-c pointer-events-none absolute" style={{
        width: 440, height: 440, borderRadius: "50%",
        top: "38%", left: "40%",
        background: "radial-gradient(circle, rgba(34,211,238,0.14) 0%, transparent 70%)",
        filter: "blur(110px)",
      }} />

      {/* Grid overlay */}
      <div className="pointer-events-none absolute inset-0" style={{
        backgroundImage: `
          linear-gradient(rgba(255,255,255,0.022) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.022) 1px, transparent 1px)
        `,
        backgroundSize: "64px 64px",
      }} />

      {/* Top-left brand badge */}
      <div className="absolute top-6 left-7 flex items-center gap-2.5 fade-up" style={{ animationDelay: "0.05s" }}>
        <div className="w-px h-5 bg-line" />
        <span className="text-[10px] uppercase tracking-[0.28em] text-muted/70 font-light">
          Sinegal Family &nbsp;·&nbsp; Quant Research
        </span>
      </div>

      {/* Top-right subtle link */}
      <div className="absolute top-6 right-7 fade-up" style={{ animationDelay: "0.05s" }}>
        <span className="text-[10px] text-muted/40 font-mono tracking-wider">sinegalfamily.com</span>
      </div>

      {/* ── Center hero ── */}
      <div className="relative z-10 flex flex-col items-center gap-5 text-center px-6" style={{ marginTop: "-4vh" }}>

        {/* Logo mark */}
        <div className="fade-up">
          <svg width="68" height="68" viewBox="0 0 64 64" fill="none">
            <ellipse cx="32" cy="32" rx="28" ry="11" stroke="url(#g1)" strokeWidth="1.5" fill="none" opacity="0.75" />
            <ellipse cx="32" cy="32" rx="28" ry="11" stroke="url(#g2)" strokeWidth="1.5" fill="none" opacity="0.55"
              transform="rotate(60 32 32)" />
            <ellipse cx="32" cy="32" rx="28" ry="11" stroke="url(#g3)" strokeWidth="1.5" fill="none" opacity="0.55"
              transform="rotate(120 32 32)" />
            <circle cx="32" cy="32" r="4.5" fill="url(#g1)" />
            <circle cx="60" cy="32" r="2.5" fill="#22d3ee" opacity="0.9" />
            <defs>
              <linearGradient id="g1" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                <stop stopColor="#3b82f6" /><stop offset="1" stopColor="#8b5cf6" />
              </linearGradient>
              <linearGradient id="g2" x1="64" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
                <stop stopColor="#8b5cf6" /><stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
              <linearGradient id="g3" x1="0" y1="64" x2="64" y2="0" gradientUnits="userSpaceOnUse">
                <stop stopColor="#22d3ee" /><stop offset="1" stopColor="#3b82f6" />
              </linearGradient>
            </defs>
          </svg>
        </div>

        {/* Title + tagline */}
        <div className="fade-up-delay flex flex-col items-center gap-2">
          <div className="text-[10px] uppercase tracking-[0.4em] text-muted/60 font-light mb-1">
            Quantitative Research Platform
          </div>
          <h1 className="text-[64px] leading-none font-bold uppercase tracking-[0.16em] bg-clip-text text-transparent"
              style={{ backgroundImage: "linear-gradient(100deg, #3b82f6 20%, #8b5cf6 60%, #22d3ee 100%)" }}>
            Quantlab
          </h1>
          <p className="text-[12px] uppercase tracking-[0.38em] text-muted/75 font-light mt-1">
            Backtest &nbsp;·&nbsp; Analyze &nbsp;·&nbsp; Trade
          </p>
        </div>

        {/* CTA */}
        <div className="fade-up-delay2 flex items-center gap-4 mt-1">
          <a
            href="#login"
            className="px-9 py-2.5 rounded-lg text-sm font-semibold uppercase tracking-widest text-white transition-all duration-200"
            style={{
              backgroundImage: "linear-gradient(90deg, #3b82f6, #8b5cf6)",
              boxShadow: "0 0 0 0 rgba(139,92,246,0)",
            }}
            onMouseEnter={e => e.currentTarget.style.boxShadow = "0 0 30px 4px rgba(139,92,246,0.42)"}
            onMouseLeave={e => e.currentTarget.style.boxShadow = "0 0 0 0 rgba(139,92,246,0)"}
          >
            Enter Platform
          </a>
        </div>

        {/* Feature pill strip */}
        <div className="fade-up-delay2 flex flex-wrap justify-center gap-2 mt-2" style={{ animationDelay: "0.42s" }}>
          {["Walk-Forward", "Grid Search", "Monte Carlo", "Cost Sweep", "Live Alerts", "Multi-Strategy Portfolio"].map(f => (
            <span key={f}
              className="px-3 py-1 rounded-full border border-line/60 text-[10px] uppercase tracking-widest text-muted/60 font-light"
              style={{ background: "rgba(255,255,255,0.02)" }}
            >
              {f}
            </span>
          ))}
        </div>
      </div>

      {/* ── Bottom feature cards ── */}
      <div className="absolute bottom-8 left-0 right-0 flex justify-center gap-4 px-8 fade-up-delay2"
           style={{ animationDelay: "0.55s" }}>
        {FEATURES.map(f => (
          <div key={f.label}
            className="flex items-start gap-3 rounded-xl border border-line/50 px-4 py-3 max-w-[210px]"
            style={{ background: "rgba(19,20,31,0.55)", backdropFilter: "blur(12px)" }}
          >
            <div className="mt-0.5 shrink-0" style={{ color: "rgba(139,92,246,0.8)" }}>{f.icon}</div>
            <div>
              <div className="text-[10px] uppercase tracking-wider text-text/80 font-medium">{f.label}</div>
              <div className="text-[10px] text-muted/70 mt-0.5 leading-relaxed">{f.desc}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Bottom-right tag */}
      <div className="absolute bottom-3 right-6 text-[10px] text-muted/35 font-mono tracking-wider">
        v1.0 · Internal
      </div>
    </div>
  );
}
