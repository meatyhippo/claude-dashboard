import { CalendarIcon } from "./Icons.tsx";
import { useEffect, useMemo, useState } from "react";
import type { BaAgendaEvent, BaCustomer, BaRequirement, Cached } from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";
import { ago, Freshness, useAction } from "./CustomerPanels.tsx";

/**
 * BA edition: the delivery board for IDMs and PS, one collapsible card per
 * customer, most urgent first. Inside each: this week's meetings, the 2-week
 * scoping window after kick-off ("PS has a 2-week window from the handover to get
 * all non-native integrations scoped, assigned, and estimated"), the billable
 * pipeline, go-live and change requests. The strip on top totals them and filters.
 *
 * One cached Notion read (deals + their tasks) and the calendar connector.
 */

type Task = BaRequirement & { projectId: number | null };
type Filter = "today" | "late" | "quote" | "invoice" | "golive" | "changes" | null;

const DONE = /done|live|closed|won.?t|duplicate|cancel|no longer|invoiced|paid/i;
const DAY = 86_400_000;
const PIPELINE = ["Awaiting timeline", "To Estimate", "To quote", "Quoted", "Ready to Invoice", "Invoiced", "Paid", "On Hold"];
const days = (iso: string | null) => (iso ? Math.floor((Date.now() - Date.parse(iso)) / DAY) : null);
const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });
const time = (at: number) => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
const dayName = (at: number) => {
  const d = new Date(at);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === new Date(today.getTime() + DAY).toDateString()) return "Tomorrow";
  return d.toLocaleDateString(undefined, { weekday: "short", day: "numeric" });
};

type Row = {
  c: BaCustomer;
  meetings: BaAgendaEvent[];
  today: BaAgendaEvent[];
  kickoff: string | null;
  since: number | null;
  irs: Task[];
  unscoped: Task[];
  late: boolean;
  billing: Map<string, Task[]>;
  toQuote: Task[];
  readyToInvoice: Task[];
  goLive: { name: string; date: string; inDays: number }[];
  goLiveIrs: Task[];
  changes: Task[];
  urgency: number;
};

function build(c: BaCustomer, tasks: Task[], events: BaAgendaEvent[]): Row {
  const mine = tasks.filter((t) => t.projectId === c.projectId);
  const meetings = events.filter((e) => e.projectId === c.projectId && !e.declined && !e.allDay);
  const today = meetings.filter((e) => new Date(e.start!).toDateString() === new Date().toDateString());
  const kickoff = c.deals.map((d) => d.kickoff).filter((d): d is string => !!d).sort()[0] ?? null;
  const since = days(kickoff);
  const irs = mine.filter((t) => t.type === "Integration request" && !DONE.test(t.status ?? ""));
  const unscoped = irs.filter((t) => t.blocks === 0 || t.billableStatus === "Awaiting timeline" || t.billableStatus === "To Estimate" || t.hasScopingIssue);
  const late = !!kickoff && (since ?? 0) > 14 && unscoped.length > 0;
  const billing = new Map<string, Task[]>();
  for (const t of mine) if (t.billableStatus && PIPELINE.includes(t.billableStatus)) billing.set(t.billableStatus, [...(billing.get(t.billableStatus) ?? []), t]);
  const goLive = c.deals
    .filter((d) => d.goLive && !/live/i.test(d.goLiveStatus ?? ""))
    .map((d) => ({ name: d.name, date: d.goLive!, inDays: -(days(d.goLive) ?? 0) }))
    .filter((g) => g.inDays >= -14)
    .sort((a, b) => a.inDays - b.inDays);
  const goLiveIrs = mine.filter((t) => /go-live|1 month before/i.test(t.priority ?? "") && !DONE.test(t.status ?? ""));
  const changes = mine.filter((t) => t.type === "Change request" && !DONE.test(t.status ?? ""));
  const toQuote = billing.get("To quote") ?? [];
  const readyToInvoice = billing.get("Ready to Invoice") ?? [];
  const soon = goLive[0]?.inDays ?? 999;
  const urgency =
    (late ? 100 : 0) + today.length * 40 + (soon <= 14 ? 60 : soon <= 30 ? 30 : 0) + readyToInvoice.length * 15 + toQuote.length * 5 + changes.length * 10 + unscoped.length * 3 + meetings.length * 5;
  return { c, meetings, today, kickoff, since, irs, unscoped, late, billing, toQuote, readyToInvoice, goLive, goLiveIrs, changes, urgency };
}

const sum = (ts: Task[]) => ts.reduce((n, t) => n + (t.billableAmount ?? 0), 0);

/** The first few of a long list, and a button for the rest. */
function Capped<T>({ items, render, max = 8 }: { items: T[]; render: (t: T) => React.ReactNode; max?: number }) {
  const [all, setAll] = useState(false);
  return (
    <>
      {(all ? items : items.slice(0, max)).map(render)}
      {items.length > max && (
        <button className="icon-btn ghost dl-more" onClick={() => setAll(!all)}>
          {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </>
  );
}

function TaskLine({ t, extra }: { t: Task; extra?: string }) {
  return (
    <div className="dl-line">
      <a className="ba-title" href={t.url} target="_blank" rel="noreferrer">
        {t.title}
      </a>
      <span className="ba-muted">{[t.status, t.billableAmount !== null ? money(t.billableAmount) : null, extra].filter(Boolean).join(" · ")}</span>
    </div>
  );
}

function CustomerCard({ r, open, onToggle, onOpen }: { r: Row; open: boolean; onToggle: () => void; onOpen: (key: string) => void }) {
  const { run } = useAction(onOpen);
  const next = r.meetings.find((e) => (e.end ?? e.start!) > Date.now());
  return (
    <div className={`dl-card ${open ? "open" : ""} ${r.late ? "late" : ""}`}>
      <button className="dl-head" onClick={onToggle} aria-expanded={open}>
        <span className="dl-caret">{open ? "▾" : "▸"}</span>
        <span className="dl-name">{r.c.name}</span>
        <span className="dl-stage ba-muted">{[...new Set(r.c.deals.map((d) => d.status))].filter(Boolean).join(", ")}</span>
        <span className="dl-chips">
          {next && <span className={`dl-chip ${r.today.length ? "hot" : ""}`}><CalendarIcon /> {dayName(next.start!)} {time(next.start!)}</span>}
          {r.kickoff && r.irs.length > 0 && (
            <span className={`dl-chip ${r.late ? "bad" : r.unscoped.length ? "warn" : "ok"}`}>
              {(r.since ?? 0) < 0 ? `kick-off in ${-(r.since ?? 0)} d` : `scoping day ${r.since}/14`}
              {r.unscoped.length ? ` · ${r.unscoped.length} unscoped` : ""}
            </span>
          )}
          {!r.kickoff && r.unscoped.length > 0 && <span className="dl-chip">{r.unscoped.length} IRs to scope</span>}
          {r.toQuote.length > 0 && <span className="dl-chip warn">To quote {r.toQuote.length} · {money(sum(r.toQuote))}</span>}
          {r.readyToInvoice.length > 0 && <span className="dl-chip ok">Invoice {r.readyToInvoice.length} · {money(sum(r.readyToInvoice))}</span>}
          {r.goLive[0] && <span className={`dl-chip ${r.goLive[0].inDays < 0 ? "bad" : r.goLive[0].inDays <= 30 ? "warn" : ""}`}>{r.goLive[0].inDays < 0 ? `go-live ${-r.goLive[0].inDays} d late` : `go-live in ${r.goLive[0].inDays} d`}</span>}
          {r.changes.length > 0 && <span className="dl-chip">{r.changes.length} change req.</span>}
        </span>
      </button>
      {open && (
        <div className="dl-body">
          <div className="dl-actions">
            <a className="icon-btn" href={`#/project/${r.c.projectId}`}>
              Open customer →
            </a>
            <button className="icon-btn ghost" onClick={() => void run("briefing", { projectId: r.c.projectId })}>
              Pre-call briefing
            </button>
            <button className="icon-btn ghost" onClick={() => void run("ballpark", { projectId: r.c.projectId })}>
              Pre-sales ballpark
            </button>
          </div>
          <div className="dl-grid">
            <details className="dl-sec" open={r.meetings.length > 0}>
              <summary>
                Meetings this week <em>{r.meetings.length}</em>
              </summary>
              {r.meetings.length === 0 && <p className="ba-muted">None.</p>}
              {r.meetings.map((e) => (
                <div key={e.id} className="dl-line">
                  <span className="ba-time">
                    {dayName(e.start!)} {time(e.start!)}
                  </span>
                  <span className="ba-title">{e.title}</span>
                  {e.meetLink && (
                    <a className="icon-btn ghost" href={e.meetLink} target="_blank" rel="noreferrer">
                      Join
                    </a>
                  )}
                </div>
              ))}
            </details>
            <details className="dl-sec" open={r.unscoped.length > 0}>
              <summary>
                Scoping <em>{r.unscoped.length} of {r.irs.length}</em>
              </summary>
              <p className="ba-muted">{r.kickoff ? `Kick-off ${r.kickoff} · 2-week window ${r.late ? "passed" : "running"}` : "No Integrations kick-off date on the deal yet"}</p>
              <Capped items={r.unscoped} render={(t) => <TaskLine key={t.url} t={t} extra={t.blocks ? `${t.blocks} blocks` : "no blocks"} />} />
            </details>
            <details className="dl-sec" open={r.toQuote.length + r.readyToInvoice.length > 0}>
              <summary>
                Billing <em>{[...r.billing.values()].reduce((n, v) => n + v.length, 0)}</em>
              </summary>
              {[...r.billing.entries()]
                .sort(([a], [b]) => PIPELINE.indexOf(a) - PIPELINE.indexOf(b))
                .map(([stage, items]) => (
                  <details key={stage} className="dl-stage-group" open={stage === "To quote" || stage === "Ready to Invoice"}>
                    <summary>
                      {stage} · {items.length} · {money(sum(items))}
                    </summary>
                    <Capped items={items} render={(t) => <TaskLine key={t.url} t={t} extra={t.readyToInvoiceAt ? `ready ${t.readyToInvoiceAt}` : t.createdAt ? `created ${ago(Date.parse(t.createdAt))}` : undefined} />} />
                  </details>
                ))}
              {r.billing.size === 0 && <p className="ba-muted">Nothing billable open.</p>}
            </details>
            <details className="dl-sec" open={r.goLive.length > 0 && r.goLive[0]!.inDays <= 30}>
              <summary>
                Go-live <em>{r.goLive.length ? r.goLive[0]!.date : "—"}</em>
              </summary>
              {r.goLive.map((g) => (
                <div key={g.name} className="dl-line">
                  <strong>{g.date}</strong>
                  <span className="ba-muted">
                    {g.name} · {g.inDays < 0 ? `${-g.inDays} d late` : `in ${g.inDays} d`}
                  </span>
                </div>
              ))}
              {r.goLiveIrs.length > 0 && <p className="ba-muted">{r.goLiveIrs.length} IRs needed for go-live still open:</p>}
              <Capped items={r.goLiveIrs} render={(t) => <TaskLine key={t.url} t={t} />} />
            </details>
            {r.changes.length > 0 && (
              <details className="dl-sec" open>
                <summary>
                  Change requests <em>{r.changes.length}</em>
                </summary>
                {r.changes.map((t) => (
                  <TaskLine key={t.url} t={t} extra={t.billableStatus ?? undefined} />
                ))}
              </details>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

export default function DeliveryView({ onOpen }: { onOpen: (key: string) => void }) {
  const [state, setState] = useState<(Cached<Task[]> & { customers: BaCustomer[] }) | null>(null);
  const [agenda, setAgenda] = useState<Cached<BaAgendaEvent[]> | null>(null);
  const [busy, setBusy] = useState(false);
  const [filter, setFilter] = useState<Filter>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [q, setQ] = useState("");

  const load = (refresh: boolean) => {
    setBusy(true);
    return Promise.all([baApi.delivery(refresh).then(setState), baApi.agenda(7, refresh).then(setAgenda).catch(() => {})])
      .catch((e) => setState({ data: null, error: String(e?.message ?? e), fetchedAt: Date.now(), stale: true, customers: [] }))
      .finally(() => setBusy(false));
  };
  useEffect(() => {
    void load(false);
  }, []);

  const rows = useMemo(() => {
    const tasks = state?.data ?? [];
    const events = agenda?.data ?? [];
    return (state?.customers ?? []).map((c) => build(c, tasks, events)).sort((a, b) => b.urgency - a.urgency || a.c.name.localeCompare(b.c.name));
  }, [state, agenda]);

  const totals = {
    today: rows.reduce((n, r) => n + r.today.length, 0),
    late: rows.filter((r) => r.late).length,
    quote: rows.reduce((n, r) => n + r.toQuote.length, 0),
    quoteSum: rows.reduce((n, r) => n + sum(r.toQuote), 0),
    invoice: rows.reduce((n, r) => n + r.readyToInvoice.length, 0),
    invoiceSum: rows.reduce((n, r) => n + sum(r.readyToInvoice), 0),
    golive: rows.filter((r) => r.goLive[0] && r.goLive[0].inDays <= 30).length,
    changes: rows.reduce((n, r) => n + r.changes.length, 0),
  };
  const match: Record<Exclude<Filter, null>, (r: Row) => boolean> = {
    today: (r) => r.today.length > 0,
    late: (r) => r.late,
    quote: (r) => r.toQuote.length > 0,
    invoice: (r) => r.readyToInvoice.length > 0,
    golive: (r) => !!r.goLive[0] && r.goLive[0].inDays <= 30,
    changes: (r) => r.changes.length > 0,
  };
  const shown = rows.filter((r) => (!filter || match[filter](r)) && (!q || r.c.name.toLowerCase().includes(q.toLowerCase())));
  const unmatched = (agenda?.data ?? []).filter((e) => !e.projectId && !e.declined && !e.allDay && new Date(e.start!).toDateString() === new Date().toDateString());
  const toggle = (id: number) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const stat = (k: Exclude<Filter, null>, label: string, n: number, tone: string, sub?: string) => (
    <button key={k} className={`dl-stat ${tone} ${filter === k ? "on" : ""}`} onClick={() => setFilter(filter === k ? null : k)} disabled={n === 0}>
      <strong>{n}</strong>
      <span>{label}</span>
      {sub && <span className="ba-muted">{sub}</span>}
    </button>
  );

  return (
    <div className="page ba-inbox">
      <div className="ba-panel-head">
        <h2>Delivery</h2>
        <span className="ba-muted">
          {rows.length} customers · {(state?.data ?? []).length} tasks from Notion · {(agenda?.data ?? []).length} meetings this week
        </span>
        <Freshness state={state} busy={busy} onRefresh={() => void load(true)} />
      </div>
      {state?.error && <div className="chat-error">{state.error}</div>}
      {rows.length === 0 && state && <div className="ba-card ba-muted">No customers yet. Add them from the directory on the Customers page.</div>}

      <div className="dl-stats">
        {stat("today", "meetings today", totals.today, "hot")}
        {stat("late", "scoping overdue", totals.late, "bad")}
        {stat("quote", "to quote", totals.quote, "warn", money(totals.quoteSum))}
        {stat("invoice", "ready to invoice", totals.invoice, "ok", money(totals.invoiceSum))}
        {stat("golive", "go-live ≤ 30 d", totals.golive, "warn")}
        {stat("changes", "change requests", totals.changes, "")}
      </div>

      <div className="ba-row">
        <input className="drawings-search" type="search" placeholder="Filter customers" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="icon-btn ghost" onClick={() => setOpen(new Set(shown.map((r) => r.c.projectId)))}>
          Expand all
        </button>
        <button className="icon-btn ghost" onClick={() => setOpen(new Set())}>
          Collapse all
        </button>
        {filter && (
          <button className="icon-btn ghost" onClick={() => setFilter(null)}>
            Clear filter ✕
          </button>
        )}
      </div>

      <div className="dl-list">
        {shown.map((r) => (
          <CustomerCard key={r.c.projectId} r={r} open={open.has(r.c.projectId)} onToggle={() => toggle(r.c.projectId)} onOpen={onOpen} />
        ))}
      </div>

      {unmatched.length > 0 && (
        <details className="ba-card">
          <summary>
            Other meetings today <span className="ba-muted">{unmatched.length}, not with one of your customers</span>
          </summary>
          {unmatched.map((e) => (
            <div key={e.id} className="dl-line">
              <span className="ba-time">{time(e.start!)}</span>
              <span className="ba-title">{e.title}</span>
            </div>
          ))}
        </details>
      )}
    </div>
  );
}
