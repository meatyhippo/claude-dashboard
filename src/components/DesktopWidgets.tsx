import { useEffect, useState } from "react";
import type { BaCustomer, BaQaiQuestion, BaRequirement, BaTriageThread, Cached } from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";
import { baFlags } from "../baFlags.ts";
import { Agenda } from "./Agenda.tsx";
import { ago } from "./CustomerPanels.tsx";

/**
 * BA edition: widgets on the Desktop, suggested from what the other pages know.
 * Meetings today suggest the agenda, mail to triage the inbox, quotes waiting the
 * delivery numbers, and so on. Add one to keep it; tiles still float on top.
 */

type WidgetKey = "agenda" | "inbox" | "delivery" | "customers" | "qai";
const KEY = "desktop-widgets";
const NAMES: Record<WidgetKey, string> = { agenda: "Today & tomorrow", inbox: "Inbox to triage", delivery: "Delivery", customers: "Customers", qai: "Qai" };

const readPinned = (): WidgetKey[] => {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "[]") as WidgetKey[];
  } catch {
    return [];
  }
};
const go = (hash: string) => (window.location.hash = hash);
const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

export default function DesktopWidgets() {
  const [pinned, setPinned] = useState<WidgetKey[]>(readPinned);
  const [inbox, setInbox] = useState<BaTriageThread[] | null>(null);
  const [delivery, setDelivery] = useState<(Cached<(BaRequirement & { projectId: number | null })[]> & { customers: BaCustomer[] }) | null>(null);
  const [meetingsToday, setMeetingsToday] = useState(0);
  const [qai, setQai] = useState<BaQaiQuestion[]>([]);

  useEffect(() => {
    if (baFlags.inbox) void baApi.mail("inbox").then((r) => setInbox(r.data ?? [])).catch(() => {});
    if (baFlags.delivery) void baApi.delivery().then(setDelivery).catch(() => {});
    void baApi
      .agenda(2)
      .then((r) => setMeetingsToday((r.data ?? []).filter((e) => !e.declined && !e.allDay && new Date(e.start!).toDateString() === new Date().toDateString()).length))
      .catch(() => {});
    if (baFlags.qai) void baApi.qai().then((r) => setQai(r.questions)).catch(() => {});
  }, []);
  const save = (next: WidgetKey[]) => {
    setPinned(next);
    try {
      localStorage.setItem(KEY, JSON.stringify(next));
    } catch {
      /* private window: it lasts for this visit */
    }
  };

  const tasks = delivery?.data ?? [];
  const toQuote = tasks.filter((t) => t.billableStatus === "To quote");
  const toInvoice = tasks.filter((t) => t.billableStatus === "Ready to Invoice");
  const triage = (inbox ?? []).filter((t) => !t.link_);
  const customers = delivery?.customers ?? [];

  // Why each widget is worth having today.
  const reasons: Partial<Record<WidgetKey, string>> = {};
  if (meetingsToday) reasons.agenda = `${meetingsToday} meeting${meetingsToday > 1 ? "s" : ""} today`;
  if (triage.length) reasons.inbox = `${triage.length} mail${triage.length > 1 ? "s" : ""} to triage`;
  if (toQuote.length || toInvoice.length) reasons.delivery = `${toQuote.length} to quote · ${toInvoice.length} ready to invoice`;
  if (customers.length) reasons.customers = `${customers.length} customers`;
  if (qai.length) reasons.qai = `${qai.length} question${qai.length > 1 ? "s" : ""} asked`;
  const suggested = (Object.keys(reasons) as WidgetKey[]).filter((k) => !pinned.includes(k));

  const card = (k: WidgetKey, body: React.ReactNode) => (
    <section key={k} className="dw-card">
      <header>
        <h4>{NAMES[k]}</h4>
        <button className="icon-btn ghost" title="Remove from Desktop" onClick={() => save(pinned.filter((x) => x !== k))}>
          ✕
        </button>
      </header>
      {body}
    </section>
  );

  const render = (k: WidgetKey) => {
    switch (k) {
      case "agenda":
        return (
          <section key={k} className="dw-card dw-wide">
            <header>
              <h4>{NAMES[k]}</h4>
              <button className="icon-btn ghost" onClick={() => save(pinned.filter((x) => x !== k))}>
                ✕
              </button>
            </header>
            <Agenda days={2} customers={customers} onOpen={() => go("#/delivery")} title="" />
          </section>
        );
      case "inbox":
        return card(
          k,
          <>
            <div className="dw-big">{triage.length}</div>
            <span className="ba-muted">to triage · {(inbox ?? []).length - triage.length} placed</span>
            {triage.slice(0, 4).map((t) => (
              <div key={t.id} className="dw-line">
                {t.create ? "＋ " : t.suggestion ? "→ " : ""}
                {t.subject}
              </div>
            ))}
            <button className="icon-btn" onClick={() => go("#/inbox")}>
              Open Inbox →
            </button>
          </>,
        );
      case "delivery":
        return card(
          k,
          <>
            <div className="dw-stats">
              <span>
                <strong>{toQuote.length}</strong> to quote <em>{money(toQuote.reduce((s, t) => s + (t.billableAmount ?? 0), 0))}</em>
              </span>
              <span>
                <strong>{toInvoice.length}</strong> ready to invoice <em>{money(toInvoice.reduce((s, t) => s + (t.billableAmount ?? 0), 0))}</em>
              </span>
            </div>
            <button className="icon-btn" onClick={() => go("#/delivery")}>
              Open Delivery →
            </button>
          </>,
        );
      case "customers":
        return card(
          k,
          <div className="dw-chips">
            {customers.map((c) => (
              <a key={c.projectId} className="ba-chip" href={`#/project/${c.projectId}`}>
                {c.name}
              </a>
            ))}
          </div>,
        );
      case "qai":
        return card(
          k,
          <>
            {qai.slice(0, 4).map((q) => (
              <div key={q.id} className="dw-line">
                {q.question} <span className="ba-muted">· {q.replies?.length ? `${q.replies.length} replies` : "no reply read yet"} · {ago(q.askedAt)}</span>
              </div>
            ))}
            <button className="icon-btn" onClick={() => go("#/qai")}>
              Open Qai →
            </button>
          </>,
        );
    }
  };

  if (!pinned.length && !suggested.length) return null;
  return (
    <div className="dw">
      {suggested.length > 0 && (
        <div className="dw-suggest">
          <span className="ba-muted">Suggested for your Desktop:</span>
          {suggested.map((k) => (
            <button key={k} className="dw-sugg" onClick={() => save([...pinned, k])}>
              <strong>+ {NAMES[k]}</strong>
              <span className="ba-muted">{reasons[k]}</span>
            </button>
          ))}
        </div>
      )}
      {pinned.length > 0 && <div className="dw-grid">{pinned.map(render)}</div>}
    </div>
  );
}
