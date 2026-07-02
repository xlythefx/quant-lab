import { useEffect, useRef, useState } from "react";
import { socket } from "../../services/socket.js";
import { logout } from "../../services/auth.js";
import LiveClock from "../LiveClock.jsx";
import BrandAtom from "../BrandAtom.jsx";

/**
 * Dashboard V2-only navigation: a thin far-left icon rail that replaces the
 * shared top Navbar (icon-only, with hover tooltips). The connection state is a
 * bare red/green dot, and the clock is tucked behind a timer icon that pops it
 * out on click. Scoped to V2 — every other page still uses the top Navbar.
 */

const PRIMARY = [
  { view: "dashboard",    href: "#dashboard",    label: "Dashboard",     icon: IconGrid },
  { view: "dashboardv2",  href: "#dashboardv2",  label: "Dashboard V2",  icon: IconChart },
  { view: "marketlab",    href: "#marketlab",    label: "Market Lab",    icon: IconFlask },
  { view: "reportimport", href: "#reportimport", label: "Report Import", icon: IconImport },
  { view: "skills",       href: "#skills",       label: "Skills",        icon: IconSparkles },
  { view: "strategies",   href: "#strategies",   label: "Strategies",    icon: IconLayers },
  { view: "livealerts",   href: "#livealerts",   label: "Live Alerts",   icon: IconBell },
  { view: "settings",     href: "#settings",     label: "Risk",          icon: IconSliders },
];

const VALIDATION_ITEMS = [
  { href: "#walkforward", view: "walkforward", label: "Walk-Forward" },
  { href: "#gridsearch",  view: "gridsearch",  label: "Grid Search" },
  { href: "#montecarlo",  view: "montecarlo",  label: "Monte Carlo" },
  { href: "#costsweep",   view: "costsweep",   label: "Cost Sweep" },
];

export default function IconNavRail({ view = "dashboardv2" }) {
  const [connected, setConnected] = useState(socket.connected);
  useEffect(() => {
    const onC = () => setConnected(true);
    const onD = () => setConnected(false);
    socket.on("connect", onC);
    socket.on("disconnect", onD);
    return () => { socket.off("connect", onC); socket.off("disconnect", onD); };
  }, []);

  return (
    <nav className="w-16 shrink-0 flex flex-col items-center border-r border-line bg-bg-panel/60 backdrop-blur py-3 gap-1">
      {/* logo */}
      <div className="w-9 h-9 flex items-center justify-center mb-2" title="Quantlab">
        <BrandAtom size={34} />
      </div>

      {/* primary nav (split so Validation flyout slots in after Dashboard V2) */}
      <RailLink {...PRIMARY[0]} active={view === PRIMARY[0].view} />
      <RailLink {...PRIMARY[1]} active={view === PRIMARY[1].view} />
      <ValidationFlyout view={view} />
      {PRIMARY.slice(2).map((it) => (
        <RailLink key={it.view} {...it} active={view === it.view} />
      ))}

      {/* bottom cluster */}
      <div className="mt-auto flex flex-col items-center gap-2 pt-2">
        <ConnDot connected={connected} />
        <ClockButton />
        <RailButton label="Sign Out" tone="loss" onClick={() => { logout(); window.location.hash = "#landing"; }} icon={IconLogout} />
      </div>
    </nav>
  );
}

// ---- rail primitives --------------------------------------------------------

function Tooltip({ children }) {
  return (
    <span className="absolute left-full ml-2 px-2 py-1 rounded-md border border-line bg-bg-panel text-xs text-text whitespace-nowrap opacity-0 group-hover:opacity-100 pointer-events-none shadow-lg shadow-black/40 z-50 transition-opacity">
      {children}
    </span>
  );
}

function RailLink({ href, label, icon: Icon, active }) {
  return (
    <a
      href={href}
      className={`group relative w-10 h-10 flex items-center justify-center rounded-lg transition ${
        active ? "bg-bg-elev text-text" : "text-muted hover:text-text hover:bg-bg-elev/50"
      }`}
    >
      <Icon />
      {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-accent-blue" />}
      <Tooltip>{label}</Tooltip>
    </a>
  );
}

function RailButton({ label, icon: Icon, onClick, tone }) {
  const hover = tone === "loss" ? "hover:text-loss" : "hover:text-text";
  return (
    <button onClick={onClick} className={`group relative w-10 h-10 flex items-center justify-center rounded-lg text-muted ${hover} hover:bg-bg-elev/50 transition`}>
      <Icon />
      <Tooltip>{label}</Tooltip>
    </button>
  );
}

function ConnDot({ connected }) {
  return (
    <div className="group relative w-10 h-6 flex items-center justify-center">
      <span
        className={`w-2.5 h-2.5 rounded-full transition ${
          connected ? "bg-[#22c55e] shadow-[0_0_8px_#22c55e]" : "bg-loss shadow-[0_0_8px_#ef4444]"
        }`}
      />
      <Tooltip>{connected ? "Connected" : "Disconnected"}</Tooltip>
    </div>
  );
}

function ClockButton() {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`group relative w-10 h-10 flex items-center justify-center rounded-lg transition ${
          open ? "bg-bg-elev text-text" : "text-muted hover:text-text hover:bg-bg-elev/50"
        }`}
      >
        <IconClock />
        {!open && <Tooltip>Clock</Tooltip>}
      </button>
      {open && (
        <div className="absolute left-full bottom-0 ml-2 px-3 py-2 rounded-lg border border-line bg-bg-panel shadow-xl shadow-black/40 z-50">
          <LiveClock />
        </div>
      )}
    </div>
  );
}

function ValidationFlyout({ view }) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const active = VALIDATION_ITEMS.some((it) => it.view === view);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className={`group relative w-10 h-10 flex items-center justify-center rounded-lg transition ${
          active || open ? "bg-bg-elev text-text" : "text-muted hover:text-text hover:bg-bg-elev/50"
        }`}
      >
        <IconShield />
        {active && <span className="absolute left-0 top-1/2 -translate-y-1/2 w-0.5 h-5 rounded-full bg-accent-blue" />}
        {!open && <Tooltip>Validation</Tooltip>}
      </button>
      {open && (
        <div className="absolute left-full top-0 ml-2 min-w-[150px] rounded-lg border border-line bg-bg-panel shadow-xl shadow-black/40 py-1 z-50">
          <div className="px-3 py-1 text-[10px] uppercase tracking-wider text-muted/70">Validation</div>
          {VALIDATION_ITEMS.map((it) => (
            <a
              key={it.view}
              href={it.href}
              onClick={() => setOpen(false)}
              className={`block px-3 py-1.5 text-sm transition ${
                it.view === view ? "text-text bg-bg-elev" : "text-muted hover:text-text hover:bg-bg-elev/50"
              }`}
            >
              {it.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- icons (20px, currentColor) --------------------------------------------
const S = { width: 20, height: 20, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round", strokeLinejoin: "round" };

function IconGrid() { return (<svg {...S}><rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" /><rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" /></svg>); }
function IconChart() { return (<svg {...S}><path d="M3 3v18h18" /><path d="M7 14l3-4 3 3 5-7" /></svg>); }
function IconFlask() { return (<svg {...S}><path d="M9 3h6" /><path d="M10 3v6l-5 9a2 2 0 0 0 2 3h10a2 2 0 0 0 2-3l-5-9V3" /><path d="M7 16h10" /></svg>); }
function IconImport() { return (<svg {...S}><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" y1="15" x2="12" y2="3" /></svg>); }
function IconSparkles() { return (<svg {...S}><path d="M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15l-1.8-4.2L5.5 9l4.7-1.3z" /><path d="M19 14l.8 2 .2.2 2 .8-2 .8-.2.2-.8 2-.8-2-.2-.2-2-.8 2-.8.2-.2z" /></svg>); }
function IconLayers() { return (<svg {...S}><polygon points="12 2 22 8.5 12 15 2 8.5 12 2" /><polyline points="2 14 12 20.5 22 14" /></svg>); }
function IconBell() { return (<svg {...S}><path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" /></svg>); }
function IconSliders() { return (<svg {...S}><line x1="4" y1="21" x2="4" y2="14" /><line x1="4" y1="10" x2="4" y2="3" /><line x1="12" y1="21" x2="12" y2="12" /><line x1="12" y1="8" x2="12" y2="3" /><line x1="20" y1="21" x2="20" y2="16" /><line x1="20" y1="12" x2="20" y2="3" /><line x1="1" y1="14" x2="7" y2="14" /><line x1="9" y1="8" x2="15" y2="8" /><line x1="17" y1="16" x2="23" y2="16" /></svg>); }
function IconShield() { return (<svg {...S}><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" /><polyline points="9 12 11 14 15 10" /></svg>); }
function IconClock() { return (<svg {...S}><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 15 14" /></svg>); }
function IconLogout() { return (<svg {...S}><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><polyline points="16 17 21 12 16 7" /><line x1="21" y1="12" x2="9" y2="12" /></svg>); }
