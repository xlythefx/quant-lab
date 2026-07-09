import { useEffect, useMemo, useState } from "react";
import ParamForm from "./ParamForm.jsx";
import { createDeployment } from "./liveApi.js";
import { getLiveAlerts } from "../../services/api.js";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

/**
 * Deploy modal: strategy × symbol × timeframe × preset × params × account ×
 * webhook. Arming ALWAYS goes through confirm-before-arm showing exactly
 * what will fire. Demo account is the default (safety rule #1).
 */
export default function DeployModal({ open, onClose, onDeployed, strategies = [], instruments = [], prefill = null }) {
  const [draft, setDraft] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [urlPresets, setUrlPresets] = useState([]);
  const [secretPresets, setSecretPresets] = useState([]);

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setConfirming(false);
    setDraft({
      name: "",
      strategy_id: prefill?.strategy_id || "",
      symbol: prefill?.symbol || instruments[0]?.symbol || "BTCUSDT",
      timeframe: prefill?.timeframe || "1h",
      preset: "",
      params: prefill?.params ? { ...prefill.params } : {},
      account: "demo",
      webhook_url: "",
      secret: "",
      strategy_alias: "",
      leverage: 10,
      enabled: true,
    });
    // Offer the URLs/secrets already configured in existing rules (the user's
    // own endpoints — same backend the old page uses).
    getLiveAlerts()
      .then((rules) => {
        const rs = rules || [];
        setUrlPresets([...new Set(rs.map((r) => r.webhook_url).filter(Boolean))]);
        // Secrets come back masked. Reference the source rule by name; the backend
        // restores the real secret on save (it never reaches the browser).
        setSecretPresets(rs.filter((r) => r.secret).map((r) => ({ name: r.name, hint: r.secret })));
      })
      .catch(() => {});
  }, [open, prefill, instruments]);

  const strat = useMemo(
    () => strategies.find((s) => s.id === draft?.strategy_id) || null,
    [strategies, draft?.strategy_id],
  );
  const presets = strat?.presets || {};

  if (!open || !draft) return null;

  const upd = (patch) => setDraft((d) => ({ ...d, ...patch }));

  const pickStrategy = (id) => {
    const s = strategies.find((x) => x.id === id);
    upd({
      strategy_id: id,
      strategy_alias: s?.name || id,
      params: {},
      preset: "",
      name: draft.name || (s ? `${s.name} ${draft.symbol} ${draft.account}` : ""),
    });
  };

  const applyPreset = (presetName) => {
    if (!presetName) return upd({ preset: "", params: {} });
    upd({ preset: presetName, params: { ...(presets[presetName] || {}) } });
  };

  const validate = () => {
    for (const [k, label] of [["name", "name"], ["strategy_id", "strategy"], ["symbol", "symbol"],
      ["timeframe", "timeframe"], ["webhook_url", "webhook URL"], ["secret", "secret"], ["strategy_alias", "alias"]]) {
      if (!String(draft[k] || "").trim()) return `${label} is required`;
    }
    if (!/^https?:\/\//.test(draft.webhook_url)) return "webhook URL must start with http(s)://";
    return null;
  };

  const arm = async () => {
    setBusy(true); setErr(null);
    try {
      await createDeployment({ ...draft, leverage: Number(draft.leverage) || 1 });
      onDeployed?.();
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || "deploy failed");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lt-modal-overlay" onMouseDown={onClose}>
      <div className="lt-modal" style={{ maxWidth: 720 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="lt-modal-head">
          <span className="lt-modal-title">Deploy Strategy</span>
          <button className="lt-btn small" onClick={onClose}>ESC</button>
        </div>

        {!confirming ? (
          <>
            <div className="lt-modal-body">
              {err && <div className="lt-warn-banner" style={{ position: "static", marginBottom: 10 }}>⚠ {err}</div>}
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px 14px" }}>
                <label style={{ gridColumn: "1 / -1" }}>
                  <span className="lt-field-label">Deployment name (unique)</span>
                  <input className="lt-input" value={draft.name} onChange={(e) => upd({ name: e.target.value })}
                         placeholder="VWMA BTC demo" />
                </label>

                <label>
                  <span className="lt-field-label">Strategy</span>
                  <select className="lt-select" value={draft.strategy_id} onChange={(e) => pickStrategy(e.target.value)}>
                    <option value="">— select —</option>
                    {strategies.filter((s) => !s.archived).map((s) => (
                      <option key={s.id} value={s.id}>{s.name} ({s.id})</option>
                    ))}
                  </select>
                </label>

                <label>
                  <span className="lt-field-label">Instrument (Binance)</span>
                  <select className="lt-select" value={draft.symbol} onChange={(e) => upd({ symbol: e.target.value })}>
                    {instruments.map((i) => <option key={i.symbol} value={i.symbol}>{i.symbol}</option>)}
                  </select>
                </label>

                <label>
                  <span className="lt-field-label">Timeframe</span>
                  <select className="lt-select" value={draft.timeframe} onChange={(e) => upd({ timeframe: e.target.value })}>
                    {TIMEFRAMES.map((tf) => <option key={tf} value={tf}>{tf}</option>)}
                  </select>
                </label>

                <label>
                  <span className="lt-field-label">Preset</span>
                  <select className="lt-select" value={draft.preset} onChange={(e) => applyPreset(e.target.value)}>
                    <option value="">Default params</option>
                    {Object.keys(presets).map((p) => <option key={p} value={p}>{p}</option>)}
                  </select>
                </label>

                <label>
                  <span className="lt-field-label">Account · Demo runs live with fake money</span>
                  <select
                    className="lt-select"
                    value={draft.account}
                    style={draft.account === "live" ? { borderColor: "var(--lt-red)", color: "var(--lt-red)" } : {}}
                    onChange={(e) => upd({ account: e.target.value })}
                  >
                    <option value="demo">DEMO</option>
                    <option value="live">LIVE (real funds)</option>
                  </select>
                </label>

                <label>
                  <span className="lt-field-label">Leverage</span>
                  <input className="lt-input" type="number" min={1} max={125} value={draft.leverage}
                         onChange={(e) => upd({ leverage: e.target.value })} />
                </label>

                <label style={{ gridColumn: "1 / -1" }}>
                  <span className="lt-field-label">Webhook URL (broker bridge this deployment POSTs to)</span>
                  {urlPresets.length > 0 && (
                    <select className="lt-select" style={{ marginBottom: 4 }} value=""
                            onChange={(e) => { if (e.target.value) upd({ webhook_url: e.target.value }); }}>
                      <option value="">— pick an existing target —</option>
                      {urlPresets.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  )}
                  <input className="lt-input" value={draft.webhook_url}
                         onChange={(e) => upd({ webhook_url: e.target.value })}
                         placeholder="https://api.yourdomain.com/binance_webhook" />
                </label>

                <label>
                  <span className="lt-field-label">Secret</span>
                  {secretPresets.length > 0 && (
                    <select className="lt-select" style={{ marginBottom: 4 }} value=""
                            onChange={(e) => {
                              const src = secretPresets.find((p) => p.name === e.target.value);
                              if (src) upd({ secret: src.hint, secret_source: src.name });
                            }}>
                      <option value="">— reuse a secret —</option>
                      {secretPresets.map((p) => <option key={p.name} value={p.name}>{p.name} ({p.hint})</option>)}
                    </select>
                  )}
                  <input className="lt-input" type="password" value={draft.secret}
                         onChange={(e) => upd({ secret: e.target.value, secret_source: "" })} placeholder="shared token" />
                </label>

                <label>
                  <span className="lt-field-label">Strategy alias (payload `strategy` field)</span>
                  <input className="lt-input" value={draft.strategy_alias}
                         onChange={(e) => upd({ strategy_alias: e.target.value })} placeholder="VWMA-Reversion" />
                </label>
              </div>

              {strat && (
                <div style={{ marginTop: 14, borderTop: "1px solid var(--lt-border)", paddingTop: 10 }}>
                  <ParamForm
                    schema={strat.schema || []}
                    params={draft.params}
                    onChange={(p) => upd({ params: { ...p }, preset: "" })}
                    lockedNote="Increments (pyramiding > 1) allowed — validate on 156 (staging) before production"
                  />
                </div>
              )}
            </div>
            <div className="lt-modal-foot">
              <label className="lt-mono lt-muted" style={{ fontSize: 10, display: "flex", gap: 6, alignItems: "center", marginRight: "auto" }}>
                <input type="checkbox" checked={draft.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
                start RUNNING on deploy
              </label>
              <button className="lt-btn" onClick={onClose} disabled={busy}>CANCEL</button>
              <button
                className="lt-btn primary"
                disabled={busy}
                onClick={() => {
                  const v = validate();
                  if (v) { setErr(v); return; }
                  setErr(null);
                  setConfirming(true);
                }}
              >
                DEPLOY…
              </button>
            </div>
          </>
        ) : (
          <>
            <div className="lt-modal-body">
              <div className="lt-panel-title" style={{ marginBottom: 10 }}>Confirm before arming — this is what will fire</div>
              <div className="lt-mono" style={{ fontSize: 11, display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 7 }}>
                <span className="lt-muted">STRATEGY</span><span>{strat?.name} ({draft.strategy_id})</span>
                <span className="lt-muted">INSTRUMENT</span><span>{draft.symbol} · {draft.timeframe} · BINANCE</span>
                <span className="lt-muted">ACCOUNT</span>
                <span className={draft.account === "live" ? "lt-red" : "lt-cyan"} style={{ fontWeight: 700 }}>
                  {draft.account.toUpperCase()}{draft.account === "live" ? " — REAL FUNDS" : " — fake money"}
                </span>
                <span className="lt-muted">WEBHOOK</span><span style={{ wordBreak: "break-all" }}>{draft.webhook_url}</span>
                <span className="lt-muted">PAYLOAD</span><span>{`{secret, strategy:"${draft.strategy_alias}", leverage:"${draft.leverage}", action, symbol:"${draft.symbol}"}`}</span>
                <span className="lt-muted">STATE</span><span>{draft.enabled ? "RUNNING immediately" : "PAUSED (arm later)"}</span>
              </div>
              {draft.account === "live" && (
                <div className="lt-warn-banner" style={{ position: "static", marginTop: 12 }}>
                  ⚠ LIVE ACCOUNT — signals from this deployment will move real money at the broker.
                </div>
              )}
            </div>
            <div className="lt-modal-foot">
              <button className="lt-btn" onClick={() => setConfirming(false)} disabled={busy}>BACK</button>
              <button
                className={`lt-btn ${draft.account === "live" ? "sell" : "primary"}`}
                onClick={arm}
                disabled={busy}
              >
                {busy ? "ARMING…" : `CONFIRM & ARM (${draft.account.toUpperCase()})`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
