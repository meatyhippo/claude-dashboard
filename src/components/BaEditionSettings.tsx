import { useEffect, useState } from "react";
import { baApi } from "../api.ts";
import { BA_FLAG_INFO, BA_REFRESH_CHOICES, type BaFlags, type BaModels } from "../../shared/baCustomers.ts";
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
      {baRawFlags.enabled && <Models />}
      {baRawFlags.enabled && <MailStyle />}
    </div>
  );
}

const MODEL_LABEL: Record<string, string> = { haiku: "Haiku (cheapest)", sonnet: "Sonnet", opus: "Opus (most capable)", default: "Your Claude Code default" };

/** Which model background work uses, and how often it runs: lower is cheaper and lighter on your usage. */
function Models() {
  const [m, setM] = useState<BaModels | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    void baApi.models().then(setM).catch(() => setErr(true));
  }, []);
  if (!m) return null;
  const save = (patch: Partial<BaModels>) => {
    setM({ ...m, ...patch });
    void baApi.saveModels(patch).then(setM).catch(() => setErr(true));
  };
  const pick = (key: "sync" | "keyPoints" | "drafts" | "sessions", label: string, hint: string, withDefault = false) => (
    <label className="ba-model-row">
      <span>
        <strong>{label}</strong>
        <span className="hint">{hint}</span>
      </span>
      <select value={m[key]} onChange={(e) => save({ [key]: e.target.value } as Partial<BaModels>)}>
        {[...(withDefault ? ["default"] : []), "haiku", "sonnet", "opus"].map((v) => (
          <option key={v} value={v}>
            {MODEL_LABEL[v]}
          </option>
        ))}
      </select>
    </label>
  );
  return (
    <div className="ba-models">
      <h3>Models and refresh</h3>
      <p className="hint">Background reads only copy what a connector returns, so the smallest model does them well. Use a bigger model where Claude writes or thinks.</p>
      {pick("sync", "Syncs", "Notion, Front, Slack and Calendar reads: one exact tool call each")}
      <label className="ba-model-row">
        <span>
          <strong>Retry on Sonnet</strong>
          <span className="hint">When a read fails on the sync model, try once more on Sonnet</span>
        </span>
        <input type="checkbox" checked={m.syncFallback} onChange={(e) => save({ syncFallback: e.target.checked })} />
      </label>
      <label className="ba-model-row">
        <span>
          <strong>Background refresh</strong>
          <span className="hint">How often the mailbox is read while the app runs</span>
        </span>
        <select value={m.refreshMinutes} onChange={(e) => save({ refreshMinutes: Number(e.target.value) })}>
          {BA_REFRESH_CHOICES.map((n) => (
            <option key={n} value={n}>
              {n === 0 ? "Off: only when I open the Inbox" : `Every ${n} minutes`}
            </option>
          ))}
        </select>
      </label>
      {pick("keyPoints", "Key points", "The summary above a mail thread")}
      {pick("drafts", "Reply drafts", "Draft with Claude in the Inbox")}
      {pick("sessions", "BA sessions", "Sessions started from customer, IR and mail buttons", true)}
      {err && <div className="chat-error">Could not save. Is the dashboard's service running?</div>}
    </div>
  );
}

/** Your own instructions for how mails read: every reply draft follows them. */
function MailStyle() {
  const [text, setText] = useState<string | null>(null);
  const [saved, setSaved] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">("idle");
  useEffect(() => {
    void baApi
      .mailStyle()
      .then((r) => {
        setText(r.text);
        setSaved(r.text);
      })
      .catch(() => setText(""));
  }, []);
  if (text === null) return null;
  return (
    <div className="ba-mailstyle">
      <h3>How your mails read</h3>
      <p className="hint">
        Every reply draft follows these: <strong>Draft with Claude</strong> in the Inbox and <strong>Draft from this session</strong> beside a chat. Paste the instructions you set for Claude elsewhere (tone, greeting, sign-off, language, length). A personal
        <code> ~/.claude/CLAUDE.md</code> is added too when you have one.
      </p>
      <textarea
        id="ba-mail-style"
        className="ba-prompt"
        rows={8}
        value={text}
        placeholder={"For example:\n- Short and friendly, no corporate phrases\n- Dutch-speaking customers: informal 'je', in Dutch\n- Start with 'Hi <first name>,', no sign-off (the signature adds it)"}
        onChange={(e) => {
          setText(e.target.value);
          setState("idle");
        }}
      />
      <div className="ba-row">
        <button
          className="icon-btn primary"
          disabled={text === saved || state === "saving"}
          onClick={() => {
            setState("saving");
            baApi
              .saveMailStyle(text)
              .then((r) => {
                setSaved(r.text);
                setState("saved");
              })
              .catch(() => setState("error"));
          }}
        >
          {state === "saving" ? "Saving…" : "Save"}
        </button>
        {state === "saved" && <span className="hint">Saved. The next draft follows it.</span>}
        {state === "error" && <span className="chat-error">Could not save. Is the dashboard's service running?</span>}
      </div>
    </div>
  );
}
