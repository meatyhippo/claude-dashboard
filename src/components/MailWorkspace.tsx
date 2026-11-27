import { useEffect, useState } from "react";
import type { BaFrontThread } from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";
import { baFlags } from "../baFlags.ts";
import { ago, useAction } from "./CustomerPanels.tsx";

/**
 * BA edition: a mail at a customer can also belong to one of that customer's
 * workspaces. Its session then runs in the workspace's folder and is filed there,
 * and the workspace page lists the mail.
 */

/** "Workspace" select for one mail. Shows nothing while the customer has no workspaces. */
export function MailWorkspacePicker({ thread, projectId, onChange }: { thread: BaFrontThread; projectId: number; onChange?: (workspaceId: number | null) => void }) {
  const [state, setState] = useState<{ workspaceId: number | null; workspaces: { id: number; title: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    void baApi.mailWorkspace(thread.id, projectId).then(setState).catch(() => setState(null));
  }, [thread.id, projectId]);
  if (!baFlags.enabled || !state || state.workspaces.length === 0) return null;
  const pick = (value: string) => {
    const id = value ? Number(value) : null;
    const before = state.workspaceId;
    setState({ ...state, workspaceId: id });
    void baApi
      .setMailWorkspace(thread.id, id, { projectId, thread })
      .then(() => {
        setError(null);
        onChange?.(id);
      })
      .catch((e: Error) => {
        setState((s) => (s ? { ...s, workspaceId: before } : s));
        setError(e.message);
      });
  };
  return (
    <>
      <select className="icon-btn ba-select mail-ws-pick" title="Link this mail to one of the customer's workspaces: its session then runs there" value={state.workspaceId ?? ""} onChange={(e) => pick(e.target.value)}>
        <option value="">No workspace</option>
        {state.workspaces.map((w) => (
          <option key={w.id} value={w.id}>
            {w.title}
          </option>
        ))}
      </select>
      {error && <span className="ba-muted">{error}</span>}
    </>
  );
}

/** The workspace page's "Mail" panel: the conversations linked to it. */
export function WorkspaceMail({ workspaceId, onOpen }: { workspaceId: number; onOpen: (key: string) => void }) {
  const [data, setData] = useState<{ projectId: number; threads: BaFrontThread[] } | null>(null);
  const { run, error } = useAction(onOpen);
  const on = baFlags.enabled && baFlags.inbox;
  const load = () => {
    if (on) void baApi.workspaceMail(workspaceId).then(setData).catch(() => setData(null));
  };
  useEffect(load, [workspaceId, on]);
  const threads = data?.threads ?? [];
  // Only where mail was linked: most workspaces (and every one outside a customer) have none.
  if (!on || threads.length === 0) return null;
  return (
    <section className="panel">
      <div className="panel-head">
        <h2>Mail</h2>
      </div>
      {threads.map((t) => (
        <div key={t.id} className="co-item mail-ws-item">
          <div className="co-item-main">
            <strong>{t.subject}</strong>
            <span className="ba-muted">{[t.from, t.updatedAt ? ago(t.updatedAt) : null].filter(Boolean).join(" · ")}</span>
          </div>
          <span className="mail-ws-actions">
            {t.link && (
              <a className="icon-btn ghost" href={t.link} target="_blank" rel="noreferrer">
                Front ↗
              </a>
            )}
            <button className="icon-btn" disabled={!t.link} onClick={() => void run("mail-session", { projectId: data?.projectId ?? null, url: t.link ?? undefined, label: t.subject })}>
              Session
            </button>
            <button className="icon-btn ghost" title="Take this mail out of the workspace (it stays at the customer)" onClick={() => void baApi.setMailWorkspace(t.id, null).then(load).catch(() => {})}>
              Unlink
            </button>
          </span>
        </div>
      ))}
      {error && <div className="chat-error">{error}</div>}
    </section>
  );
}
