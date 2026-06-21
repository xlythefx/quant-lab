"""
Report Import — parse an uploaded TradeStation Performance Report CSV.

One synchronous POST. No persistence (one-off, session-only by design): the
client uploads a file, gets back the parsed dashboard payload, and that's it.

POST /api/report/tradestation
  multipart/form-data with a `file` field, OR a raw text/csv body.
  -> { meta, reported, recomputed, equity_curve, drawdown_curve,
       pnl_histogram, monthly_grid, yearly, annual_reported, trades }
"""
import logging

from flask import Blueprint, jsonify, request

from services import tradestation_report

log = logging.getLogger(__name__)

report_bp = Blueprint("report", __name__, url_prefix="/api/report")

MAX_BYTES = 25 * 1024 * 1024  # 25 MB — a huge report is ~a few MB


def _read_csv_text():
    """Pull CSV text from a multipart `file` field or the raw request body.

    Returns (text, name) or raises ValueError.
    """
    f = request.files.get("file")
    if f is not None:
        raw = f.read()
        if len(raw) > MAX_BYTES:
            raise ValueError("File too large (max 25 MB).")
        return raw.decode("utf-8", errors="replace"), (f.filename or None)

    raw = request.get_data(cache=False) or b""
    if not raw:
        raise ValueError("No file uploaded. Send a multipart 'file' field or a raw CSV body.")
    if len(raw) > MAX_BYTES:
        raise ValueError("File too large (max 25 MB).")
    name = request.args.get("name")
    return raw.decode("utf-8", errors="replace"), name


@report_bp.post("/tradestation")
def tradestation():
    try:
        text, name = _read_csv_text()
    except ValueError as e:
        return jsonify({"error": str(e)}), 400

    try:
        result = tradestation_report.parse_report(text, name=name)
    except ValueError as e:
        # Not a recognizable TradeStation report (or empty).
        return jsonify({"error": str(e)}), 422
    except Exception as e:
        log.exception("report/tradestation parse failed")
        return jsonify({"error": f"Failed to parse report: {e}"}), 500

    return jsonify(result)
