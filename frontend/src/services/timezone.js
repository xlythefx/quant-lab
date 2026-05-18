/**
 * Display-timezone preference (browser-local, no backend round-trip).
 *
 * Session times are ALWAYS stored as UTC HH:MM in strategy params — this
 * module only converts those values for human-readable display.
 */

const STORAGE_KEY = "quantlab.display_tz";
const DEFAULT_TZ = "Etc/UTC";

export const TZ_PRESETS = [
  { value: "Etc/UTC",          label: "UTC" },
  { value: "America/New_York", label: "New York (ET)",      short: "NY"  },
  { value: "Asia/Manila",      label: "Manila (PHT, +8)",   short: "PH"  },
  { value: "Asia/Singapore",   label: "Singapore (SGT, +8)",short: "SG"  },
  { value: "Europe/London",    label: "London (UK)",        short: "LDN" },
  { value: "Asia/Tokyo",       label: "Tokyo (JST, +9)",    short: "TYO" },
  { value: "Asia/Shanghai",    label: "Shanghai (CST, +8)", short: "SHA" },
  { value: "Asia/Dubai",       label: "Dubai (GST, +4)",    short: "DXB" },
  { value: "Australia/Sydney", label: "Sydney (AEDT)",      short: "SYD" },
  { value: "America/Los_Angeles", label: "Los Angeles (PT)",short: "LA"  },
  { value: "America/Chicago",  label: "Chicago (CT)",       short: "CHI" },
];

export function getTz() {
  try {
    return localStorage.getItem(STORAGE_KEY) || DEFAULT_TZ;
  } catch {
    return DEFAULT_TZ;
  }
}

export function setTz(tz) {
  try {
    localStorage.setItem(STORAGE_KEY, tz || DEFAULT_TZ);
    // notify any listeners in the same tab (storage event only fires cross-tab)
    window.dispatchEvent(new CustomEvent("quantlab:tz-change", { detail: tz }));
  } catch {}
}

export function tzShort(tz) {
  const hit = TZ_PRESETS.find((p) => p.value === tz);
  if (hit?.short) return hit.short;
  if (hit?.label) return hit.label.split(" ")[0];
  // IANA fallback: take the last city segment
  return (tz || "").split("/").pop() || tz || "UTC";
}

/**
 * Convert a UTC "HH:MM" string to the equivalent wall-clock "HH:MM" in `toTz`.
 * Uses today's date as the anchor — DST-aware via Intl.DateTimeFormat.
 *
 * If `toTz` is UTC or invalid, returns the input unchanged.
 */
export function convertUtcHHmm(hhmm, toTz) {
  if (!hhmm) return hhmm;
  if (!toTz || toTz === "Etc/UTC" || toTz === "UTC") return hhmm;
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (!m) return hhmm;
  const h = Math.min(23, Math.max(0, parseInt(m[1], 10)));
  const min = Math.min(59, Math.max(0, parseInt(m[2], 10)));
  const now = new Date();
  const d = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(),
    h, min, 0, 0,
  ));
  try {
    const out = new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit", minute: "2-digit", hour12: false, timeZone: toTz,
    }).format(d);
    // Some browsers return "24:00" for midnight — normalize.
    return out === "24:00" ? "00:00" : out;
  } catch {
    return hhmm;
  }
}
