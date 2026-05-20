import { useEffect, useState } from "react";
import Dashboard from "./pages/Dashboard.jsx";
import Downloads from "./pages/Downloads.jsx";
import Strategies from "./pages/Strategies.jsx";
import RiskSettings from "./pages/RiskSettings.jsx";
import Analytics from "./pages/Analytics.jsx";
import WalkForward from "./pages/WalkForward.jsx";
import GridSearch from "./pages/GridSearch.jsx";
import MonteCarlo from "./pages/MonteCarlo.jsx";
import CostSweep from "./pages/CostSweep.jsx";

function getView() {
  // Hash like "#analytics?key=..." → strip query and route by base name.
  const raw = window.location.hash.replace("#", "") || "dashboard";
  return raw.split("?")[0];
}

export default function App() {
  const [view, setView] = useState(getView());

  useEffect(() => {
    const onHash = () => setView(getView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (view === "downloads")  return <Downloads />;
  if (view === "strategies") return <Strategies />;
  if (view === "settings")   return <RiskSettings />;
  if (view === "analytics")  return <Analytics />;
  if (view === "walkforward") return <WalkForward />;
  if (view === "gridsearch")  return <GridSearch />;
  if (view === "montecarlo")  return <MonteCarlo />;
  if (view === "costsweep")   return <CostSweep />;
  return <Dashboard />;
}
