import { useEffect, useMemo, useState } from "react";
import ParamForm from "./ParamForm.jsx";
import { createDeployment, patchDeployment, previewPayload } from "./liveApi.js";
import { getLiveAlerts, listDatasets } from "../../services/api.js";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];
const PREVIEW_ACTIONS = ["BUY", "SELL", "EXIT_LONG", "EXIT_SHORT"];

/**
 * Deploy / Edit modal: strategy × symbol × timeframe × preset × params × account
 * × webhook. Arming ALWAYS goes through confirm-before-arm showing the EXACT JSON
 * payload that will fire (fetched from the backend's real build_payload — no
 * drift). Demo account is the default (safety rule #1).
 *
 * `editing` (a deployment view) switches to edit mode: prefilled, PATCHes on save,
 * and can rename / change symbol. Webhook + secret are left blank and only sent
 * when you actually retype them (blank = keep the existing one).
 */
export default function DeployModal({ open, onClose, onDeployed, strategies = [], instruments = [], prefill = null, editing = null }) {
  const isEdit = !!editing;
  const [draft, setDraft] = useState(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const [urlPresets, setUrlPresets] = useState([]);
  const [secretPresets, setSecretPresets] = useState([]);
  const [datasets, setDatasets] = useState([]);
  const [preview, setPreview] = useState(null);      // {payloads, secret_masked} | null
  const [previewErr, setPreviewErr] = useState(null);
  const [previewAction, setPreviewAction] = useState("BUY");

  useEffect(() => {
    if (!open) return;
    setErr(null);
    setConfirming(false);
    setPreview(null);
    setPreviewErr(null);
    setPreviewAction("BUY");
    if (isEdit) {
      setDraft({
        name: editing.name || "",
        strategy_id: editing.strategy_id || "",
        symbol: editing.symbol || "BTCUSDT",
        timeframe: editing.timeframe || "1h",
        preset: "",
        params: { ...(editing.params || {}) },
        account: editing.account || "demo",
        webhook_url: "",                       // blank = keep existing (hint shown)
        secret: "",                            // blank = keep existing (masked)
        strategy_alias: editing.strategy_alias || "",
        leverage: editing.leverage ?? 10,
        enabled: editing.status === "RUNNING",
      });
    } else {
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
    }
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
    // Assets = what you've actually DOWNLOADED (same list as Downloads / Overnight),
    // so you can only deploy on data you can also backtest.
    listDatasets().then((d) => setDatasets(d || [])).catch(() => setDatasets([]));
  }, [open, prefill, editing, instruments, isEdit]);

  const strat = useMemo(
    () => strategies.find((s) => s.id === draft?.strategy_id) || null,
    [strategies, draft?.strategy_id],
  );
  const presets = strat?.presets || {};

  // Downloaded symbols for the chosen timeframe (dedup, sorted). The currently
  // selected symbol is always kept as an option so an edit never loses it, and
  // if nothing is downloaded yet we fall back to the curated instruments list.
  const assetOptions = useMemo(() => {
    const tf = draft?.timeframe;
    const set = new Set();
    for (const d of datasets) {
      if (tf && d.timeframe !== tf) continue;
      if (d.symbol) set.add(d.symbol);
    }
    if (!set.size) for (const i of instruments) set.add(i.symbol);
    if (draft?.symbol) set.add(draft.symbol);
    return [...set].sort();
  }, [datasets, draft?.timeframe, draft?.symbol, instruments]);

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
    // In edit mode webhook + secret are optional (blank keeps the existing ones).
    const required = isEdit
      ? [["name", "name"], ["strategy_id", "strategy"], ["symbol", "symbol"], ["timeframe", "timeframe"], ["strategy_alias", "alias"]]
      : [["name", "name"], ["strategy_id", "strategy"], ["symbol", "symbol"], ["timeframe", "timeframe"], ["webhook_url", "webhook URL"], ["secret", "secret"], ["strategy_alias", "alias"]];
    for (const [k, label] of required) {
      if (!String(draft[k] || "").trim()) return `${label} is required`;
    }
    if (draft.webhook_url && !/^https?:\/\//.test(draft.webhook_url)) return "webhook URL must start with http(s)://";
    return null;
  };

  // Fetch the REAL payload the backend will POST when we open the confirm screen.
  const goConfirm = () => {
    const v = validate();
    if (v) { setErr(v); return; }
    setErr(null);
    setPreview(null);
    setPreviewErr(null);
    setConfirming(true);
    previewPayload({
      strategy_alias: draft.strategy_alias,
      leverage: Number(draft.leverage) || 1,
      symbol: draft.symbol,
    })
      .then(setPreview)
      .catch((e) => setPreviewErr(e?.response?.data?.error || e.message || "preview failed"));
  };

  const arm = async () => {
    setBusy(true); setErr(null);
    try {
      if (isEdit) {
        const patch = {
          name: draft.name,
          symbol: draft.symbol,
          timeframe: draft.timeframe,
          account: draft.account,
          leverage: Number(draft.leverage) || 1,
          strategy_alias: draft.strategy_alias,
          params: draft.params,
          enabled: !!draft.enabled,
        };
        // Only touch webhook/secret when actually retyped (blank = keep existing).
        if (String(draft.webhook_url || "").trim()) patch.webhook_url = draft.webhook_url;
        if (String(draft.secret || "").trim()) {
          patch.secret = draft.secret;
          if (draft.secret_source) patch.secret_source = draft.secret_source;
        }
        await patchDeployment(editing.name, patch);
      } else {
        await createDeployment({ ...draft, leverage: Number(draft.leverage) || 1 });
      }
      onDeployed?.();
      onClose();
    } catch (e) {
      setErr(e?.response?.data?.error || e.message || (isEdit ? "save failed" : "deploy failed"));
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  const title = isEdit ? "Edit Deployment" : "Deploy Strategy";
  const primaryLabel = isEdit ? "SAVE…" : "DEPLOY…";
  const previewJson = preview?.payloads?.[previewAction];

  return (
    <div className="lt-modal-overlay" onMouseDown={onClose}>
      <div className="lt-modal" style={{ maxWidth: 720 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="lt-modal-head">
          <span className="lt-modal-title">{title}</span>
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
                  <span className="lt-field-label">Instrument · downloaded {draft.timeframe} data</span>
                  <select className="lt-select" value={draft.symbol} onChange={(e) => upd({ symbol: e.target.value })}>
                    {assetOptions.map((sym) => <option key={sym} value={sym}>{sym}</option>)}
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
                  <span className="lt-field-label">
                    Webhook URL (broker bridge this deployment POSTs to)
                    {isEdit && <span className="lt-dim"> · leave blank to keep {editing.webhook_hint || "current"}</span>}
                  </span>
                  {urlPresets.length > 0 && (
                    <select className="lt-select" style={{ marginBottom: 4 }} value=""
                            onChange={(e) => { if (e.target.value) upd({ webhook_url: e.target.value }); }}>
                      <option value="">— pick an existing target —</option>
                      {urlPresets.map((u) => <option key={u} value={u}>{u}</option>)}
                    </select>
                  )}
                  <input className="lt-input" value={draft.webhook_url}
                         onChange={(e) => upd({ webhook_url: e.target.value })}
                         placeholder={isEdit ? (editing.webhook_hint || "unchanged") : "https://api.yourdomain.com/binance_webhook"} />
                </label>

                <label>
                  <span className="lt-field-label">
                    Secret{isEdit && <span className="lt-dim"> · blank = keep {editing.secret_hint || "current"}</span>}
                  </span>
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
                         onChange={(e) => upd({ secret: e.target.value, secret_source: "" })}
                         placeholder={isEdit ? "unchanged" : "shared token"} />
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
                {isEdit ? "RUNNING after save" : "start RUNNING on deploy"}
              </label>
              <button className="lt-btn" onClick={onClose} disabled={busy}>CANCEL</button>
              <button className="lt-btn primary" disabled={busy} onClick={goConfirm}>{primaryLabel}</button>
            </div>
          </>
        ) : (
          <>
            <div className="lt-modal-body">
              <div className="lt-panel-title" style={{ marginBottom: 10 }}>
                {isEdit ? "Confirm changes — this is what will fire" : "Confirm before arming — this is what will fire"}
              </div>
              <div className="lt-mono" style={{ fontSize: 11, display: "grid", gridTemplateColumns: "120px 1fr", rowGap: 7 }}>
                {isEdit && editing.name !== draft.name && (
                  <>
                    <span className="lt-muted">RENAME</span>
                    <span><span className="lt-dim">{editing.name}</span> → <b>{draft.name}</b></span>
                  </>
                )}
                <span className="lt-muted">STRATEGY</span><span>{strat?.name} ({draft.strategy_id})</span>
                <span className="lt-muted">INSTRUMENT</span><span>{draft.symbol} · {draft.timeframe} · BINANCE</span>
                <span className="lt-muted">ACCOUNT</span>
                <span className={draft.account === "live" ? "lt-red" : "lt-cyan"} style={{ fontWeight: 700 }}>
                  {draft.account.toUpperCase()}{draft.account === "live" ? " — REAL FUNDS" : " — fake money"}
                </span>
                <span className="lt-muted">WEBHOOK</span>
                <span style={{ wordBreak: "break-all" }}>
                  {draft.webhook_url || (isEdit ? (editing.webhook_hint || "unchanged") : "")}
                </span>
                <span className="lt-muted">STATE</span><span>{draft.enabled ? "RUNNING immediately" : "PAUSED (arm later)"}</span>
              </div>

              {/* EXACT JSON body, straight from the backend build_payload() */}
              <div style={{ marginTop: 12, borderTop: "1px solid var(--lt-border)", paddingTop: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <span className="lt-field-label" style={{ marginRight: "auto" }}>
                    Webhook payload (exact JSON — secret masked)
                  </span>
                  {PREVIEW_ACTIONS.map((a) => (
                    <button key={a} className={`lt-btn small ${a === previewAction ? "cyan" : ""}`}
                            onClick={() => setPreviewAction(a)}>{a}</button>
                  ))}
                </div>
                {previewErr ? (
                  <div className="lt-warn-banner" style={{ position: "static" }}>⚠ {previewErr}</div>
                ) : previewJson ? (
                  <pre className="lt-mono" style={{ margin: 0, padding: "8px 10px", fontSize: 11, background: "var(--lt-chrome)",
                        border: "1px solid var(--lt-border)", borderRadius: 4, overflowX: "auto", whiteSpace: "pre" }}>
{JSON.stringify(previewJson, null, 2)}
                  </pre>
                ) : (
                  <div className="lt-muted lt-mono" style={{ fontSize: 11 }}>building preview…</div>
                )}
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
                {busy ? (isEdit ? "SAVING…" : "ARMING…") : isEdit ? "CONFIRM & SAVE" : `CONFIRM & ARM (${draft.account.toUpperCase()})`}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
