/**
 * Shared brand mark: a blue atom (three electron orbits + nucleus + a single
 * cyan electron). Used for the favicon, the Dashboard V2 nav rail, the shared
 * top navbar, and the V2 Strategies panel header so the logo stays identical
 * everywhere. Inherits no color — the atom is intentionally a fixed brand blue.
 */
export default function BrandAtom({ size = 24, className = "", title = "Quantlab" }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      <g stroke="#3b82f6" strokeWidth="1.5" fill="none">
        <ellipse cx="12" cy="12" rx="9.5" ry="3.6" />
        <ellipse cx="12" cy="12" rx="9.5" ry="3.6" transform="rotate(60 12 12)" />
        <ellipse cx="12" cy="12" rx="9.5" ry="3.6" transform="rotate(120 12 12)" />
      </g>
      <circle cx="12" cy="12" r="2" fill="#3b82f6" />
      <circle cx="21.5" cy="12" r="1.4" fill="#22d3ee" />
    </svg>
  );
}
