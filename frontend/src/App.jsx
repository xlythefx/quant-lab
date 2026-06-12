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
import MarketLab from "./pages/MarketLab.jsx";
import Skills from "./pages/Skills.jsx";
import LiveAlerts from "./pages/LiveAlerts.jsx";
import Landing from "./pages/Landing.jsx";
import Login from "./pages/Login.jsx";
import { isAuthenticated } from "./services/auth.js";

const PUBLIC = new Set(["", "landing", "login"]);

function getView() {
  // Hash like "#analytics?key=..." → strip query and route by base name.
  const raw = window.location.hash.replace("#", "") || "";
  return raw.split("?")[0];
}

export default function App() {
  const [view, setView] = useState(getView());

  useEffect(() => {
    const onHash = () => setView(getView());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const authed = isAuthenticated();

  // Unauthenticated user trying to reach a protected route → login.
  if (!authed && !PUBLIC.has(view)) {
    window.location.hash = "#login";
    return <Login />;
  }

  // Authenticated user landing on public pages → go to dashboard.
  if (authed && PUBLIC.has(view)) {
    window.location.hash = "#dashboard";
    return null;
  }

  if (view === "landing") return <Landing />;
  if (view === "login")   return <Login />;
  if (view === "downloads")   return <Downloads />;
  if (view === "strategies")  return <Strategies />;
  if (view === "settings")    return <RiskSettings />;
  if (view === "analytics")   return <Analytics />;
  if (view === "walkforward")  return <WalkForward />;
  if (view === "gridsearch")   return <GridSearch />;
  if (view === "montecarlo")   return <MonteCarlo />;
  if (view === "costsweep")    return <CostSweep />;
  if (view === "marketlab")    return <MarketLab />;
  if (view === "skills")       return <Skills />;
  if (view === "livealerts")   return <LiveAlerts />;

  // Dashboard — page-enter fades it in; ripple overlay bursts on mount
  return (
    <div key="dashboard" className="page-enter" style={{ height: "100%", minHeight: "100vh" }}>
      <div className="page-ripple-overlay" aria-hidden="true" />
      <Dashboard />
    </div>
  );
}
