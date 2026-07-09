# Animations Spec

Two animation systems. Both must be preserved in the React port. Both include a **safety fallback** so content can never get stuck hidden if `requestAnimationFrame` is throttled (e.g. backgrounded tab) — keep that behavior.

---

## 1. Per-container staggered workspace entrance

When a workspace becomes active (tab/rail click, ⌘K nav, or initial load), its **panel-level containers** animate in one-by-one with a cycling set of motions — giving each panel a distinct entrance rather than a uniform fade.

### Keyframes
```css
@keyframes wsRise  { from{opacity:0; transform:translateY(22px) scale(.99); filter:blur(6px);} to{opacity:1; transform:translateY(0) scale(1); filter:blur(0);} }
@keyframes wsDealL { from{opacity:0; transform:translateX(-38px) scale(.985);}              to{opacity:1; transform:translateX(0) scale(1);} }
@keyframes wsDealR { from{opacity:0; transform:translateX(38px)  scale(.985);}              to{opacity:1; transform:translateX(0) scale(1);} }
@keyframes wsZoom  { from{opacity:0; transform:scale(.9); filter:blur(4px);}                to{opacity:1; transform:scale(1); filter:blur(0);} }
@keyframes wsTilt  { from{opacity:0; transform:perspective(1000px) rotateX(11deg) translateY(18px);} to{opacity:1; transform:perspective(1000px) rotateX(0) translateY(0);} }
@keyframes wsSweep { from{opacity:0; transform:translateY(14px); clip-path:inset(0 100% 0 0);}       to{opacity:1; transform:translateY(0); clip-path:inset(0 0 0 0);} }
```

### Application
- **Targets** = the panel cards of the active workspace. In the prototype: for Trading, the 7 grid panels (`#ws-trading > div > div`); for the other workspaces, the top-level sections of the rendered page. In React: the direct child panels/cards of the workspace.
- For each target `i`: assign animation from the cycle
  `['wsRise','wsDealL','wsZoom','wsTilt','wsDealR','wsSweep'][i % 6]`
- Timing: `0.52s cubic-bezier(.22,.9,.32,1)`, **stagger `i · 60ms`**, fill `both`.
- On `animationend`, clear the inline animation so the element returns to its natural (untransformed) state.
- **Safety fallback:** a `setTimeout(60·count + 700ms)` force-clears all target animations even if `animationend` never fires (throttled rAF) — otherwise a `both`-filled from-state could leave panels invisible. **Do not omit this.**

### React implementation sketch
```tsx
function useEnterStagger(active: boolean, ref: RefObject<HTMLElement>) {
  useEffect(() => {
    if (!active || !ref.current) return;
    const anims = ['wsRise','wsDealL','wsZoom','wsTilt','wsDealR','wsSweep'];
    const targets = Array.from(ref.current.children) as HTMLElement[]; // panel cards
    targets.forEach((el, i) => {
      el.style.animation = 'none'; void el.offsetWidth;               // restart
      el.style.animation = `${anims[i % anims.length]} .52s cubic-bezier(.22,.9,.32,1) ${i*60}ms both`;
      const clear = () => { el.style.animation = ''; el.removeEventListener('animationend', clear); };
      el.addEventListener('animationend', clear);
    });
    const t = setTimeout(() => targets.forEach(el => { el.style.animation = ''; }), 60*targets.length + 700);
    return () => clearTimeout(t);
  }, [active]);
}
```
(Or wrap each panel in a `<PanelEnter index=…>` that applies the same via CSS classes + `animation-delay`.) Respect `prefers-reduced-motion: reduce` — skip the transforms, keep a plain instant/opacity reveal.

> **Removed effect:** an earlier left-to-right "shine/scanline" sweep across the page was **intentionally removed** — do not reintroduce a glare/sweep overlay.

---

## 2. Progressive chart "draw-in"

The line/area charts **draw on gradually from left to right** (the data forms over ~1.2s) when the page loads or the relevant view is entered. The static chart frame (gridlines, axis, session bands, volume profile) appears immediately; the **data series** reveal progressively.

Applies to:
- **Trading candle chart** — candlesticks, VWMA(14) line, and the ±1.5σ Z-bands reveal left→right; volume-profile/POC/grid draw fully.
- **Open Interest** mini chart (area + line).
- **Analytics cumulative equity curve** (area + line).

### Mechanism
A progress value `p` ramps `0 → 1` over the duration with **ease-out cubic** (`e = 1 − (1 − p)³`), redrawing each frame via `requestAnimationFrame`. The draw functions take `p` and render only the fraction of the series up to a **fractional index** (interpolating the final partial segment so the leading edge moves smoothly, not in whole-point jumps).

- Duration: **1200 ms**, ease-out cubic.
- Candle chart: candles with index `≤ p·(n−1)` are drawn; lines (VWMA, Z-bands) stroke up to the same fractional index with an interpolated last point.
- Area charts (OI, equity): build the point list up to the fractional index, close the area to the baseline at the current leading x, fill + stroke.
- **Triggers:** initial load; switching to Trading (chart+OI replays); symbol switch (chart replays); entering Analytics (equity replays). Live data updates after the intro draw **full** (progress stays at 1) — do **not** replay on every tick.
- **Important:** only replay on *navigation/selection*, never on the high-frequency data re-render, or the chart will visibly "rewind" constantly. In the prototype this is gated by a one-shot flag (`_eqAnimNext`) for equity and by calling `startChartAnim()` only from `setWorkspace`/symbol-switch/mount.

### React implementation sketch
```tsx
function useDrawProgress(trigger: unknown, durMs = 1200) {
  const [p, setP] = useState(1);
  useEffect(() => {
    let raf = 0; const t0 = performance.now();
    const step = (t: number) => {
      const x = Math.min(1, (t - t0) / durMs);
      setP(1 - Math.pow(1 - x, 3));
      if (x < 1) raf = requestAnimationFrame(step);
      else setP(1);
    };
    setP(0); raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [trigger]);               // trigger = symbol/timeframe key, or workspace-entered token
  return p;                    // pass into the canvas draw; 1 == fully drawn
}
```
The canvas component redraws on `[data, size, p]`. When using a third-party chart lib instead of canvas, emulate with the lib's "animated series" / clip-reveal, ease-out cubic, ~1.2s, left→right, triggered on the same events only.

If `prefers-reduced-motion: reduce`, skip the ramp and render at `p = 1` immediately.

---

## Other motion already in the design (keep)
- Top-bar **LIVE** dot: `@keyframes blink { 0%,100%{opacity:1} 50%{opacity:.25} }`, `1.6s infinite`.
- New **liquidation** rows slide in: `@keyframes slideIn { from{opacity:0; transform:translateY(-9px)} to{opacity:1; transform:translateY(0)} }`, `.4s ease`, applied to the newest row only.
- **News feed** marquee: continuous vertical `transform: translateY(...)` scroll, pauses on hover.
- Row/icon **hover** tints (instant, no keyframes): rows → `#15151f` / `#13131d`; rail icons & tabs brighten to `#e2e2f0`.
- Numeric **flash** on update: a cell briefly tints green/red then settles to white (~500ms) — used for the live price.
