import { useEffect, useState } from "react";
import type { BaAgendaEvent, BaCustomer, Cached } from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";
import { Freshness, useAction } from "./CustomerPanels.tsx";

/**
 * Meetings from the Google Calendar Claude is already connected to (the claude.ai
 * connector): no Google Cloud project and no sign-in in the dashboard. Matched to
 * customers by attendee email domain or name, with a briefing one click away.
 */
export function Agenda({ days, projectId, customers, onOpen, title }: { days: number; projectId?: number; customers: BaCustomer[]; onOpen: (key: string) => void; title: string }) {
  const [state, setState] = useState<Cached<BaAgendaEvent[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const { run, error } = useAction(onOpen);
  const load = (refresh: boolean) => {
    setBusy(true);
    return baApi
      .agenda(days, refresh)
      .then(setState)
      .catch((e) => setState({ data: null, error: String(e?.message ?? e), fetchedAt: Date.now(), stale: true }))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    void load(false);
  }, [days]);

  const events = (state?.data ?? []).filter((e) => !e.declined && !e.allDay && (projectId === undefined || e.projectId === projectId));
  if (projectId !== undefined && state && !state.error && events.length === 0) return null;
  const nameOf = (pid: number | null) => customers.find((c) => c.projectId === pid)?.name;
  const withCustomers = events.filter((e) => e.projectId).length;
  return (
    <section className="ba-card">
      <div className="ba-panel-head">
        <h3>
          {title} {projectId === undefined && <span className="ba-muted">{withCustomers} with customers of {events.length}</span>}
        </h3>
        <Freshness state={state} busy={busy} onRefresh={() => void load(true)} />
      </div>
      {(state?.error || error) && <div className="chat-error">{state?.error || error}</div>}
      {state && !state.error && events.length === 0 && <p className="ba-muted">No meetings.</p>}
      {events.map((e) => (
        <div key={e.id} className={`ba-line ba-meeting ${e.projectId ? "" : "dim"}`}>
          <span className="ba-time">
            {new Date(e.start!).toLocaleDateString(undefined, { weekday: "short" })} {new Date(e.start!).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
          </span>
          <span className="ba-title">{e.title}</span>
          <span className="ba-muted">{e.attendees.filter((a) => !a.self).slice(0, 3).map((a) => a.name ?? a.email).join(", ")}{e.attendees.length > 4 ? " …" : ""}</span>
          {e.projectId && projectId === undefined && (
            <a className="ba-chip" href={`#/project/${e.projectId}`}>
              {nameOf(e.projectId)}
            </a>
          )}
          {e.meetLink && (
            <a className="icon-btn ghost" href={e.meetLink} target="_blank" rel="noreferrer">
              Join
            </a>
          )}
          {e.projectId && (
            <button className="icon-btn ghost" onClick={() => void run("briefing", { projectId: e.projectId })}>
              Briefing
            </button>
          )}
        </div>
      ))}
    </section>
  );
}
