import { useEffect, useState } from "react";
import { getTz } from "./timezone.js";

/**
 * The user's display-timezone preference, re-rendering when it changes.
 *
 * Session times and heatmap hours are ALWAYS stored/computed in UTC — this is
 * purely for showing a second, human-local reading beside the UTC one.
 *
 * `setTz` fires `quantlab:tz-change` in the same tab; `storage` covers other
 * tabs. StrategyEditor grew this listener inline first — this is the shared
 * version so every page picks up the same preference.
 */
export function useDisplayTz() {
  const [tz, setTzState] = useState(getTz());
  useEffect(() => {
    const onTz = () => setTzState(getTz());
    window.addEventListener("quantlab:tz-change", onTz);
    window.addEventListener("storage", onTz);
    return () => {
      window.removeEventListener("quantlab:tz-change", onTz);
      window.removeEventListener("storage", onTz);
    };
  }, []);
  return tz;
}
