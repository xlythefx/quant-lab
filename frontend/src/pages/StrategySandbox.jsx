import { useEffect, useMemo, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import TradingChart from "../components/TradingChart.jsx";
import SandboxChat from "../components/sandbox/SandboxChat.jsx";
import { getOHLCV } from "../services/api.js";
import { tradesToMarkers } from "../services/chartMarkers.js";
import { usePersistentState } from "../services/usePersistentState.js";
import { fmtPct, fmtInt, fmtNum } from "../services/format.js";

// Only the two markets the builder supports for now.
const SYMBOL_TFS = {
  BTCUSDT: ["1m", "15m", "1h"],
  ES: ["15m", "1h"],
};
const SYMBOLS = Object.keys(SYMBOL_TFS);

export default function StrategySandbox() {
  const [symbol, setSymbol] = usePersistentState("ql.sandbox.symbol", "BTCUSDT");
  const [timeframe, setTimeframe] = usePersistentState("ql.sandbox.tf", "15m");
  const [candles, setCandles] = useState([]);
  const [result, setResult] = useState(null);   // latest backtest payload

  const tfs = SYMBOL_TFS[symbol] || ["15m"];
  // Keep timeframe valid for the selected symbol.
  useEffect(() => {
    if (!tfs.includes(timeframe)) setTimeframe(tfs[0]);
  }, [symbol]); // eslint-disable-line react-hooks/exhaustive-deps

  // Plain candles for the picked market until a backtest arrives.
  useEffect(() => {
    let alive = true;
    setResult(null);
    getOHLCV({ symbol, timeframe, limit: 1000 })
      .then((c) => { if (alive) setCandles(c || []); })
      .catch(() => { if (alive) setCandles([]); });
    return () => { alive = false; };
  }, [symbol, timeframe]);

  const chartSymbol = result?.symbol || symbol;
  const chartTf = result?.timeframe || timeframe;

  const staticData = useMemo(() => {
    if (result) {
      return {
        candles: result.candles || [],
        overlaysByStrategy: { [result.strategy_id]: result.overlays || [] },
        markersByStrategy: { [result.strategy_id]: tradesToMarkers(result.trades || []) },
      };
    }
    if (candles.length) {
      return { candles, overlaysByStrategy: {}, markersByStrategy: {} };
    }
    return null;
  }, [result, candles]);

  function onBacktest(r) {
    setResult(r);
    if (r?.symbol && SYMBOLS.includes(r.symbol)) setSymbol(r.symbol);
    if (r?.timeframe) setTimeframe(r.timeframe);
  }

  return (
    <div className="h-screen flex flex-col">
      <Navbar view="strategysandbox" />
      <div className="flex-1 flex min-h-0">
        {/* Chart pane */}
        <div className="flex-1 min-w-0 flex flex-col border-r border-line">
          <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
            <Selector label="Market" value={symbol} options={SYMBOLS} onChange={setSymbol} />
            <Selector label="Timeframe" value={timeframe} options={tfs} onChange={setTimeframe} />
            {result && <StatsStrip stats={result.stats} />}
          </div>
          <div className="flex-1 min-h-0 p-3">
            <div className="h-full rounded-xl border border-line bg-bg-panel/40 overflow-hidden">
              {staticData ? (
                <TradingChart
                  mode="backtest"
                  symbol={chartSymbol}
                  timeframe={chartTf}
                  staticData={staticData}
                />
              ) : (
                <div className="flex items-center justify-center h-full text-sm text-muted">
                  Loading {symbol} {timeframe}…
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Chat pane */}
        <div className="w-[420px] shrink-0">
          <SandboxChat symbol={symbol} timeframe={timeframe} onBacktest={onBacktest} />
        </div>
      </div>
    </div>
  );
}

function Selector({ label, value, options, onChange }) {
  return (
    <label className="flex items-center gap-2 text-xs">
      <span className="uppercase tracking-wider text-muted/80">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="bg-bg border border-line rounded-md px-2 py-1 text-text focus:outline-none focus:border-accent-blue"
      >
        {options.map((o) => (
          <option key={o} value={o}>{o}</option>
        ))}
      </select>
    </label>
  );
}

function StatsStrip({ stats }) {
  if (!stats) return null;
  const cells = [
    ["Return", fmtPct(stats.total_return_pct)],
    ["Trades", fmtInt(stats.trades)],
    ["Win rate", fmtPct(stats.win_rate, false)],
    ["Sharpe", fmtNum(stats.sharpe)],
    ["Max DD", fmtPct(stats.max_drawdown_pct, false)],
  ];
  return (
    <div className="flex items-center gap-4 ml-auto">
      {cells.map(([k, v]) => (
        <div key={k} className="text-right">
          <div className="text-[10px] uppercase tracking-wider text-muted/70">{k}</div>
          <div className="text-sm font-mono text-text">{v}</div>
        </div>
      ))}
    </div>
  );
}
