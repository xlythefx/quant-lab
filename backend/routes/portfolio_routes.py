"""
Portfolio backtest route — accepts 1..N strategies and runs them through
the shared-cash-pool PortfolioRunner. Single-strategy callers can still use
/api/strategies/run (which now also wraps PortfolioRunner under the hood).

WIRE FORMAT NOTE
----------------
`run_portfolio()` returns a rich in-process shape that Monte Carlo, the
strategy builder and the legacy /api/strategies/run all depend on. What goes
over HTTP is a SLIMMED projection of it (`_slim_for_wire`), because the rich
shape does not fit in a browser: 6 strategies × 221,755 bars measured at
649 MB, which OOMs the tab during JSON.parse (the response itself is a
perfectly valid 200). The slimming is lossless — everything removed is either
duplicated, unread, or exactly derivable from what remains:

  * equity curves ship COLUMNAR ({time: [...], equity: [...]}) instead of an
    array of 5-key objects. `value`, `drawdown` and `drawdown_dollars` are
    reconstructed client-side in services/api.js (running max seeded at
    starting_capital — identical to the runner's own arithmetic).   -206 MB
  * `equity[i].per_strategy` is walk-internal scratch; no client reads it. -57 MB
  * `analytics.drawdown_curve` is literally equity.map(time, drawdown).  -85 MB
  * candles / overlays / regime_segments move to /backtest/chart-data,
    fetched only when the Chart tab opens.                            -180 MB

Net: 649 MB -> under 10 MB.
"""
import logging
import math

from flask import Blueprint, jsonify, request

from services import portfolio_runner
from services.portfolio_runner import StrategySpec
from utils.validators import validate_symbol, validate_timeframe, ValidationError

log = logging.getLogger(__name__)

portfolio_bp = Blueprint("portfolio", __name__, url_prefix="/api")


# ---------------------------------------------------------------------------
# Wire slimming
# ---------------------------------------------------------------------------

def _columnar_equity(curve: list[dict]) -> dict:
    """[{time, equity, value, drawdown, drawdown_dollars}, ...] -> {time[], equity[]}.

    Only the two INDEPENDENT columns travel; the three derived ones are
    rebuilt on the client. Equity is rounded to cents — it is dollars, and the
    UI never shows more than 2 decimals.
    """
    times, eqs = [], []
    for p in curve:
        e = float(p["equity"])
        times.append(int(p["time"]))
        # Guard: a non-finite equity would serialize as bare NaN/Infinity,
        # which is valid Python json but crashes the browser's JSON.parse.
        eqs.append(round(e, 2) if math.isfinite(e) else None)
    return {"time": times, "equity": eqs}


def _sig(x, digits: int = 10):
    """Round a float to `digits` significant figures for the wire.

    Python's json emits the shortest round-trip repr, so a raw float64 costs the
    full 17 chars (`7853.896424506265`). 10 significant figures is far beyond
    what any chart pixel or price display can resolve, and cuts per-bar series
    by roughly a third. Non-finite values become None (bare NaN/Infinity is
    legal Python json but crashes the browser's JSON.parse).
    """
    if x is None:
        return None
    f = float(x)
    if not math.isfinite(f):
        return None
    return float(f"{f:.{digits}g}")


def _round_chart_data(data: dict) -> dict:
    """Round the per-bar chart series. Structure is unchanged."""
    for candles in (data.get("candles_by_dataset") or {}).values():
        for c in candles:
            for k in ("open", "high", "low", "close", "volume"):
                c[k] = _sig(c[k])
    for overlays in (data.get("overlays_by_strategy") or {}).values():
        for ov in overlays:
            for pt in ov.get("data") or []:
                # Whitespace points carry only `time` — leave those alone.
                if "value" in pt:
                    pt["value"] = _sig(pt["value"])
    return data


def _slim_analytics(analytics: dict) -> dict:
    """Drop `drawdown_curve` — the client derives it from the equity curve."""
    if not isinstance(analytics, dict):
        return analytics
    return {k: v for k, v in analytics.items() if k != "drawdown_curve"}


def _slim_for_wire(result: dict) -> dict:
    """Project the runner's rich result onto the browser-safe wire shape."""
    out = {
        "strategies": result.get("strategies", []),
        "risk_config": result.get("risk_config", {}),
        "trades": result.get("trades", []),
        "skipped_signals": result.get("skipped_signals", []),
        "stats": result.get("stats", {}),
        "analytics": _slim_analytics(result.get("analytics", {})),
        "correlation": result.get("correlation", {}),
        # Tells the client this payload needs decoding (and lets an older
        # cached response still be recognised as the legacy shape).
        "encoding": "columnar_v1",
        "equity": _columnar_equity(result.get("equity", [])),
    }
    per_strategy = {}
    for sid, blk in (result.get("per_strategy") or {}).items():
        per_strategy[sid] = {
            "spec": blk.get("spec", {}),
            "trades": blk.get("trades", []),
            "stats": blk.get("stats", {}),
            "analytics": _slim_analytics(blk.get("analytics", {})),
            "equity": _columnar_equity(blk.get("equity", [])),
            # ~400 {time, close} points for the buy-and-hold benchmark line.
            "benchmark": blk.get("benchmark", []),
        }
    out["per_strategy"] = per_strategy
    return out


def _parse_specs(body: dict):
    """Validate the shared `{strategies, start_time, end_time}` request body.

    Returns (specs, start_time, end_time). Raises ValidationError / ValueError.
    Shared by /backtest/portfolio and /backtest/chart-data so the two always
    resolve the SAME bar window for the same request.
    """
    raw_specs = body.get("strategies") or []
    if not isinstance(raw_specs, list) or not raw_specs:
        raise ValidationError("strategies must be a non-empty array")

    specs = []
    for i, raw in enumerate(raw_specs):
        if not isinstance(raw, dict):
            raise ValidationError(f"strategies[{i}] must be an object")
        sid = (raw.get("strategy_id") or "").strip()
        if not sid:
            raise ValidationError(f"strategies[{i}].strategy_id is required")
        symbol = validate_symbol(raw.get("symbol"))
        tf     = validate_timeframe(raw.get("timeframe"))
        params = raw.get("params") or {}
        broker = (raw.get("broker") or None)
        try:
            priority = int(raw.get("priority", 100))
        except (TypeError, ValueError):
            raise ValidationError(f"strategies[{i}].priority must be an integer")
        specs.append(StrategySpec(strategy_id=sid, symbol=symbol,
                                  timeframe=tf, params=params,
                                  priority=priority, broker=broker))

    start_time = body.get("start_time")
    end_time   = body.get("end_time")
    if start_time is not None: start_time = int(start_time)
    if end_time   is not None: end_time   = int(end_time)
    return specs, start_time, end_time


@portfolio_bp.post("/backtest/portfolio")
def run_backtest_portfolio():
    """Run a portfolio backtest across 1..N strategies sharing one cash pool.

    Request body:
        {
          "strategies": [
            { "strategy_id": "vwma_momentum",
              "symbol": "BTCUSDT", "timeframe": "1h",
              "params": { "risk_pct": 2.0, ... },
              "priority": 1 },
            ...
          ],
          "start_time": <epoch_seconds_or_null>,
          "end_time":   <epoch_seconds_or_null>
        }

    Response: the SLIMMED wire shape — see `_slim_for_wire` and the module
    docstring. Equity curves are columnar and per-bar chart data is not
    included; fetch that from /backtest/chart-data when the chart is opened.
    """
    body = request.get_json(silent=True) or {}
    try:
        specs, start_time, end_time = _parse_specs(body)
        # Optional per-run cost overrides (does NOT touch the saved Risk Settings).
        # Used by the equity-curve compare (e.g. a zero-cost variant). Only known
        # numeric cost keys are honored — everything else is ignored.
        risk_overrides = None
        raw_ov = body.get("risk_overrides")
        if isinstance(raw_ov, dict):
            allowed = ("fee_pct", "fee_flat", "slippage_bps", "futures_commission")
            risk_overrides = {}
            for k in allowed:
                if k in raw_ov and raw_ov[k] is not None:
                    risk_overrides[k] = float(raw_ov[k])
            risk_overrides = risk_overrides or None
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    except (TypeError, ValueError) as e:
        return jsonify({"error": f"invalid request: {e}"}), 400

    # Socket id of the requesting client (optional) — lets the runner stream live
    # progress (stage + HMM refit %) back to just this client while the run blocks.
    client_sid = body.get("sid") or None

    try:
        result = portfolio_runner.run_portfolio(specs, start_time=start_time,
                                                end_time=end_time, sid=client_sid,
                                                risk_overrides=risk_overrides,
                                                with_chart_data=False)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("backtest/portfolio failed")
        return jsonify({"error": str(e)}), 500

    return jsonify(_slim_for_wire(result))


@portfolio_bp.post("/backtest/chart-data")
def backtest_chart_data():
    """Per-bar chart data (candles / overlays / regime bands) for 1..N strategies.

    Same request body as /backtest/portfolio. Split out so the (large) per-bar
    series are fetched only when the Chart tab is opened, and only for the
    strategies on screen. Runs `vectorized()` only — no portfolio walk — so it
    is much cheaper than a full re-run. Trade markers come from the trades the
    portfolio response already carries.
    """
    body = request.get_json(silent=True) or {}
    try:
        specs, start_time, end_time = _parse_specs(body)
    except ValidationError as e:
        return jsonify({"error": str(e)}), 400
    except (TypeError, ValueError) as e:
        return jsonify({"error": f"invalid request: {e}"}), 400

    try:
        data = portfolio_runner.chart_data(specs, start_time=start_time,
                                           end_time=end_time)
    except KeyError as e:
        return jsonify({"error": str(e)}), 404
    except FileNotFoundError as e:
        return jsonify({"error": str(e)}), 404
    except Exception as e:
        log.exception("backtest/chart-data failed")
        return jsonify({"error": str(e)}), 500

    return jsonify(_round_chart_data(data))
