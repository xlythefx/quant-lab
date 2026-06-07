import { useState, useRef } from "react";
import { login } from "../services/auth.js";
import LoadingScreen from "../components/LoadingScreen.jsx";

const CRED_USER = "administrator";
const CRED_PASS = "qweqwe";

export default function Login() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPass, setShowPass] = useState(false);
  const [error, setError]       = useState("");
  const [shaking, setShaking]   = useState(false);
  const [loading, setLoading]   = useState(false);
  const cardRef = useRef(null);

  function handleSubmit(e) {
    e.preventDefault();
    if (username.trim() === CRED_USER && password === CRED_PASS) {
      login();
      setLoading(true);   // show loading screen; it navigates on completion
    } else {
      setError("Invalid username or password.");
      setShaking(true);
      setTimeout(() => setShaking(false), 500);
    }
  }

  return (
    <div className="relative h-screen w-screen overflow-hidden bg-bg flex items-center justify-center">

      {loading && (
        <LoadingScreen onDone={() => { window.location.hash = "#dashboard"; }} />
      )}

      {/* Animated orbs — same as landing */}
      <div className="orb-a pointer-events-none absolute" style={{
        width: 680, height: 680, borderRadius: "50%",
        top: "-15%", right: "-8%",
        background: "radial-gradient(circle, rgba(139,92,246,0.30) 0%, transparent 70%)",
        filter: "blur(80px)",
      }} />
      <div className="orb-b pointer-events-none absolute" style={{
        width: 600, height: 600, borderRadius: "50%",
        bottom: "-12%", left: "-6%",
        background: "radial-gradient(circle, rgba(59,130,246,0.28) 0%, transparent 70%)",
        filter: "blur(80px)",
      }} />
      <div className="orb-c pointer-events-none absolute" style={{
        width: 420, height: 420, borderRadius: "50%",
        top: "40%", left: "42%",
        background: "radial-gradient(circle, rgba(34,211,238,0.14) 0%, transparent 70%)",
        filter: "blur(100px)",
      }} />

      {/* Grid overlay */}
      <div className="pointer-events-none absolute inset-0" style={{
        backgroundImage: `
          linear-gradient(rgba(255,255,255,0.025) 1px, transparent 1px),
          linear-gradient(90deg, rgba(255,255,255,0.025) 1px, transparent 1px)
        `,
        backgroundSize: "64px 64px",
      }} />

      {/* Card */}
      <div
        ref={cardRef}
        className={`relative z-10 w-full max-w-md mx-4 rounded-2xl border border-line bg-bg-panel/80 backdrop-blur-xl p-10 fade-up ${shaking ? "shake" : ""}`}
        style={{ boxShadow: "0 8px 64px rgba(0,0,0,0.55)" }}
      >
        {/* Logo */}
        <div className="flex flex-col items-center gap-3 mb-8">
          <svg width="40" height="40" viewBox="0 0 64 64" fill="none">
            <ellipse cx="32" cy="32" rx="28" ry="11" stroke="url(#lg1)" strokeWidth="1.5" fill="none" opacity="0.75" />
            <ellipse cx="32" cy="32" rx="28" ry="11" stroke="url(#lg2)" strokeWidth="1.5" fill="none" opacity="0.55"
              transform="rotate(60 32 32)" />
            <ellipse cx="32" cy="32" rx="28" ry="11" stroke="url(#lg3)" strokeWidth="1.5" fill="none" opacity="0.55"
              transform="rotate(120 32 32)" />
            <circle cx="32" cy="32" r="4.5" fill="url(#lg1)" />
            <circle cx="60" cy="32" r="2.5" fill="#22d3ee" opacity="0.9" />
            <defs>
              <linearGradient id="lg1" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
                <stop stopColor="#3b82f6" /><stop offset="1" stopColor="#8b5cf6" />
              </linearGradient>
              <linearGradient id="lg2" x1="64" y1="0" x2="0" y2="64" gradientUnits="userSpaceOnUse">
                <stop stopColor="#8b5cf6" /><stop offset="1" stopColor="#22d3ee" />
              </linearGradient>
              <linearGradient id="lg3" x1="0" y1="64" x2="64" y2="0" gradientUnits="userSpaceOnUse">
                <stop stopColor="#22d3ee" /><stop offset="1" stopColor="#3b82f6" />
              </linearGradient>
            </defs>
          </svg>
          <div>
            <div className="text-xl font-bold uppercase tracking-[0.18em] bg-clip-text text-transparent text-center"
                 style={{ backgroundImage: "linear-gradient(90deg, #3b82f6, #8b5cf6)" }}>
              Quantlab
            </div>
            <div className="text-[11px] text-muted text-center mt-0.5 tracking-wider">Sign in to continue</div>
          </div>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">

          {/* Username */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted">Username</label>
            <input
              type="text"
              value={username}
              onChange={e => { setUsername(e.target.value); setError(""); }}
              autoComplete="username"
              autoFocus
              className="w-full rounded-lg border border-line bg-bg-deep px-4 py-2.5 text-sm text-text outline-none
                         placeholder:text-muted/50 focus:border-accent-blue transition"
              placeholder="administrator"
            />
          </div>

          {/* Password */}
          <div className="flex flex-col gap-1.5">
            <label className="text-[10px] uppercase tracking-wider text-muted">Password</label>
            <div className="relative">
              <input
                type={showPass ? "text" : "password"}
                value={password}
                onChange={e => { setPassword(e.target.value); setError(""); }}
                autoComplete="current-password"
                className="w-full rounded-lg border border-line bg-bg-deep px-4 py-2.5 pr-11 text-sm text-text outline-none
                           placeholder:text-muted/50 focus:border-accent-blue transition"
                placeholder="••••••••••••••••"
              />
              <button
                type="button"
                onClick={() => setShowPass(v => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted hover:text-text transition"
                tabIndex={-1}
              >
                {showPass ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* Error */}
          {error && (
            <div className="rounded-lg border border-loss/40 bg-loss/10 px-4 py-2.5 text-xs text-loss">
              {error}
            </div>
          )}

          {/* Submit */}
          <button
            type="submit"
            className="w-full py-2.5 rounded-lg text-sm font-semibold uppercase tracking-widest text-white transition-all duration-200 mt-1"
            style={{ backgroundImage: "linear-gradient(90deg, #3b82f6, #8b5cf6)" }}
          >
            Sign In
          </button>
        </form>

        {/* Back link */}
        <div className="mt-6 text-center">
          <a href="#landing" className="text-[11px] text-muted hover:text-text transition">
            ← Back to home
          </a>
        </div>
      </div>
    </div>
  );
}
