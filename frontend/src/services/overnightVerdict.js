// Shared trust heuristic for an Overnight Run's per-asset record. Used by both
// the Overnight results table and the verdict PDF so they never disagree.
//
// The verdict LEADS with the trustworthy signal:
//   - grid_then_wf / walkforward : the out-of-sample result (did it hold up on
//     windows the tuning never saw?).
//   - grid-only : the plateau (do the best settings sit on a stable ridge, or a
//     lone spike we probably overfit to?).

export const TRUST = {
  strong:       { label: "Trustworthy",  tone: "#22c55e", emoji: "🟢" },
  weak:         { label: "Risky",        tone: "#f59e0b", emoji: "🟠" },
  inconclusive: { label: "Inconclusive", tone: "#94a3b8", emoji: "⚪" },
};

export const METRIC_LABEL = {
  sharpe: "Sharpe",
  profit_factor: "Profit Factor",
  total_return: "Total Return",
  total_return_pct: "Total Return",
};

// rec: one entry of result.per_asset. Returns {key, label, tone, emoji, reason}.
export function assetTrust(rec) {
  const headline = rec?.headline_metric_value;
  const hasHeadline = typeof headline === "number" && Number.isFinite(headline);

  const wf = rec?.wf;
  if (wf && typeof wf.pct_windows_positive === "number") {
    const pctTxt = `${Math.round(wf.pct_windows_positive * 100)}%`;
    if (hasHeadline && headline > 0 && wf.pct_windows_positive >= 0.6) {
      return { key: "strong", ...TRUST.strong,
        reason: `Held up out-of-sample — profitable on ${pctTxt} of the windows it was never tuned on.` };
    }
    return { key: "weak", ...TRUST.weak,
      reason: `Out-of-sample was weak — profitable on only ${pctTxt} of untested windows.` };
  }

  // grid-only: lean on the plateau
  const params = (rec?.plateau?.params || []).filter((p) => !p.single);
  const nSensitive = params.filter((p) => p.verdict === "sensitive").length;
  const nStable = params.filter((p) => p.verdict === "plateau" || p.verdict === "moderate").length;
  if (!hasHeadline) {
    return { key: "inconclusive", ...TRUST.inconclusive, reason: "No usable result for this asset." };
  }
  if (headline > 0 && nSensitive === 0 && nStable > 0) {
    return { key: "strong", ...TRUST.strong,
      reason: "Best settings sit on a stable plateau (nearby values behave similarly)." };
  }
  if (headline <= 0) {
    return { key: "weak", ...TRUST.weak, reason: "Not profitable even in-sample." };
  }
  return { key: "weak", ...TRUST.weak,
    reason: `${nSensitive} parameter${nSensitive === 1 ? "" : "s"} behave like a sharp spike — likely overfit. Validate with Walk-Forward.` };
}
