import { useEffect, useState } from "react";

/**
 * Animation hooks, per plans/design-handoff/ANIMATIONS.md.
 * Both keep the safety fallback so content can never be stuck hidden.
 */

const ANIMS = ["wsRise", "wsDealL", "wsZoom", "wsTilt", "wsDealR", "wsSweep"];

const reducedMotion = () =>
  typeof window !== "undefined" &&
  window.matchMedia &&
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

/**
 * Staggered per-panel entrance when a workspace becomes active.
 * `ref` points at the workspace container; its direct children animate.
 * `token` changes each time the workspace is (re)entered.
 */
export function useEnterStagger(token, ref) {
  useEffect(() => {
    if (!ref.current || reducedMotion()) return;
    const targets = Array.from(ref.current.children);
    targets.forEach((el, i) => {
      el.style.animation = "none";
      void el.offsetWidth; // restart
      el.style.animation = `${ANIMS[i % ANIMS.length]} .52s cubic-bezier(.22,.9,.32,1) ${i * 60}ms both`;
      const clear = () => { el.style.animation = ""; el.removeEventListener("animationend", clear); };
      el.addEventListener("animationend", clear);
    });
    // Safety fallback: force-clear even if animationend never fires.
    const t = setTimeout(() => targets.forEach((el) => { el.style.animation = ""; }), 60 * targets.length + 700);
    return () => {
      clearTimeout(t);
      targets.forEach((el) => { el.style.animation = ""; });
    };
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps
}

/**
 * Progressive chart draw-in: returns p ramping 0→1 (ease-out cubic, ~1.2s)
 * whenever `trigger` changes. Live ticks after the intro draw at p=1 —
 * only replay on navigation/symbol switch, never on data re-render.
 */
export function useDrawProgress(trigger, durMs = 1200) {
  const [p, setP] = useState(1);
  useEffect(() => {
    if (reducedMotion()) { setP(1); return; }
    let raf = 0;
    const t0 = performance.now();
    const step = (t) => {
      const x = Math.min(1, (t - t0) / durMs);
      setP(1 - Math.pow(1 - x, 3));
      if (x < 1) raf = requestAnimationFrame(step);
      else setP(1);
    };
    setP(0);
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [trigger]); // eslint-disable-line react-hooks/exhaustive-deps
  return p;
}
