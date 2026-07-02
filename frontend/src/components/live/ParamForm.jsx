import { useMemo } from "react";

/**
 * Schema-driven strategy param form — the terminal's OWN form fed by the
 * registry's PARAM_SCHEMA (data reuse, not the backtest StrategyEditor).
 * `params` holds sparse overrides; unset fields show schema defaults.
 */
export default function ParamForm({ schema = [], params = {}, onChange, lockedNote }) {
  const groups = useMemo(() => {
    const g = new Map();
    for (const spec of schema) {
      const key = spec.group || "General";
      if (!g.has(key)) g.set(key, []);
      g.get(key).push(spec);
    }
    return Array.from(g.entries());
  }, [schema]);

  const val = (spec) => (params[spec.name] !== undefined && params[spec.name] !== null ? params[spec.name] : spec.default);
  const set = (name, v) => onChange({ ...params, [name]: v });

  if (!schema.length) return <div className="lt-empty">No tunable params</div>;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      {lockedNote && <div className="lt-mono lt-amber" style={{ fontSize: 9 }}>{lockedNote}</div>}
      {groups.map(([group, specs]) => (
        <div key={group}>
          <div className="lt-panel-title" style={{ marginBottom: 6 }}>{group}</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px 14px" }}>
            {specs.map((spec) => {
              const locked = spec.name === "pyramiding";
              const v = locked ? 1 : val(spec);
              const custom = params[spec.name] !== undefined && params[spec.name] !== null
                && JSON.stringify(params[spec.name]) !== JSON.stringify(spec.default);
              const labelCls = custom ? "lt-cyan" : "lt-muted";

              if (spec.type === "bool") {
                return (
                  <label key={spec.name} className="lt-mono" style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 10.5, cursor: "pointer" }}>
                    <input type="checkbox" checked={!!v} onChange={(e) => set(spec.name, e.target.checked)} />
                    <span className={labelCls}>{spec.name}</span>
                  </label>
                );
              }

              if (spec.type === "select") {
                return (
                  <label key={spec.name} style={{ minWidth: 0 }}>
                    <span className={`lt-field-label ${custom ? "lt-cyan" : ""}`}>{spec.name}</span>
                    <select className="lt-select" value={String(v)} onChange={(e) => set(spec.name, e.target.value)}>
                      {(spec.options || []).map((o) => (
                        <option key={String(o.value)} value={String(o.value)}>{o.label ?? String(o.value)}</option>
                      ))}
                    </select>
                  </label>
                );
              }

              if (spec.type === "sides" || spec.type === "regimes") {
                const map = { ...(spec.default || {}), ...(typeof v === "object" && v ? v : {}) };
                return (
                  <div key={spec.name} style={{ gridColumn: "1 / -1" }}>
                    <span className={`lt-field-label ${custom ? "lt-cyan" : ""}`}>{spec.name}</span>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 10 }}>
                      {Object.entries(map).map(([k, on]) => (
                        <label key={k} className="lt-mono" style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 10, cursor: "pointer" }}>
                          <input type="checkbox" checked={!!on} onChange={(e) => set(spec.name, { ...map, [k]: e.target.checked })} />
                          <span className="lt-muted">{k}</span>
                        </label>
                      ))}
                    </div>
                  </div>
                );
              }

              if (spec.type === "sessions") {
                const map = typeof v === "object" && v ? v : (spec.default || {});
                return (
                  <div key={spec.name} style={{ gridColumn: "1 / -1" }}>
                    <span className={`lt-field-label ${custom ? "lt-cyan" : ""}`}>{spec.name}</span>
                    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                      {Object.entries(spec.default || {}).map(([sess, dflt]) => {
                        const cfg = { ...dflt, ...(map[sess] || {}) };
                        const upd = (patch) => set(spec.name, { ...map, [sess]: { ...cfg, ...patch } });
                        return (
                          <div key={sess} className="lt-mono" style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10 }}>
                            <label style={{ display: "flex", alignItems: "center", gap: 5, width: 90, cursor: "pointer" }}>
                              <input type="checkbox" checked={!!cfg.enabled} onChange={(e) => upd({ enabled: e.target.checked })} />
                              <span className="lt-muted">{sess}</span>
                            </label>
                            <input className="lt-input" style={{ width: 74 }} value={cfg.start || ""} onChange={(e) => upd({ start: e.target.value })} />
                            <span className="lt-dim">→</span>
                            <input className="lt-input" style={{ width: 74 }} value={cfg.end || ""} onChange={(e) => upd({ end: e.target.value })} />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              }

              // int / float
              return (
                <label key={spec.name} title={spec.description || ""} style={{ minWidth: 0 }}>
                  <span className={`lt-field-label ${custom ? "lt-cyan" : ""}`}>
                    {spec.name}{locked ? " (locked)" : ""}
                  </span>
                  <input
                    className="lt-input"
                    type="number"
                    value={v}
                    min={spec.min ?? undefined}
                    max={spec.max ?? undefined}
                    step={spec.step ?? (spec.type === "int" ? 1 : 0.01)}
                    disabled={locked}
                    onChange={(e) => {
                      const raw = e.target.value;
                      if (raw === "") return set(spec.name, spec.default);
                      set(spec.name, spec.type === "int" ? parseInt(raw, 10) : parseFloat(raw));
                    }}
                  />
                </label>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}
