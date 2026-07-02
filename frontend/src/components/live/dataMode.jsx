import { createContext, useCallback, useContext, useState } from "react";

/**
 * Terminal-level mock ⇄ live data toggle. Every live data hook reads this and
 * switches between the seeded simFeed and the real feed. The SIMULATED badge
 * on a panel is driven by which backend that panel is actually on — always
 * truthful.
 */
const DataModeContext = createContext({ dataMode: "live", toggleDataMode: () => {} });

const KEY = "ql.live_data_mode";

export function DataModeProvider({ children }) {
  const [dataMode, setDataMode] = useState(() => {
    try { return localStorage.getItem(KEY) === "mock" ? "mock" : "live"; } catch { return "live"; }
  });
  const toggleDataMode = useCallback(() => {
    setDataMode((m) => {
      const next = m === "mock" ? "live" : "mock";
      try { localStorage.setItem(KEY, next); } catch { /* ignore */ }
      return next;
    });
  }, []);
  return (
    <DataModeContext.Provider value={{ dataMode, toggleDataMode }}>
      {children}
    </DataModeContext.Provider>
  );
}

export function useDataMode() {
  return useContext(DataModeContext);
}
