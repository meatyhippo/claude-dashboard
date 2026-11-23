import { useState } from "react";
import { BA_FLAG_INFO, type BaFlags } from "../../shared/baCustomers.ts";
import { baRawFlags, saveBaFlags } from "../baFlags.ts";

/**
 * Settings → BA edition: one switch per addition, and a master switch that turns
 * the dashboard back into Rein's original. Saving reloads the page so every part
 * of it agrees on the new switches.
 */
export default function BaEditionSettings() {
  const [flags, setFlags] = useState<BaFlags>(baRawFlags);
  const [saving, setSaving] = useState(false);
  const dirty = JSON.stringify(flags) !== JSON.stringify(baRawFlags);
  return (
    <div className="panel">
      <h2>BA edition</h2>
      <p className="hint">
        Claude Dashboard is made by <strong>Rein Vanbelleghem</strong> (
        <a href="https://github.com/ReinVanbelleghem/claude-dashboard" target="_blank" rel="noreferrer">
          github.com/ReinVanbelleghem/claude-dashboard
        </a>
        ). The BA edition adds solution-architect, PS and IDM workflows on top, each behind a switch below. Turn the edition off and the dashboard is Rein's original.
      </p>
      <label className="ba-flag master">
        <input type="checkbox" checked={flags.enabled} onChange={(e) => setFlags({ ...flags, enabled: e.target.checked })} />
        <span>
          <strong>BA edition</strong>
          <span className="hint">Master switch for everything below</span>
        </span>
      </label>
      {BA_FLAG_INFO.map((f) => (
        <label key={f.key} className={`ba-flag ${flags.enabled ? "" : "off"}`}>
          <input type="checkbox" disabled={!flags.enabled} checked={flags[f.key]} onChange={(e) => setFlags({ ...flags, [f.key]: e.target.checked })} />
          <span>
            <strong>{f.label}</strong>
            <span className="hint">{f.hint}</span>
          </span>
        </label>
      ))}
      <div className="ba-row">
        <button
          className="icon-btn primary"
          disabled={!dirty || saving}
          onClick={() => {
            setSaving(true);
            void saveBaFlags(flags);
          }}
        >
          {saving ? "Saving…" : "Save and reload"}
        </button>
      </div>
    </div>
  );
}
