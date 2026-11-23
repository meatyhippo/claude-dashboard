import { CommentIcon, InboxIcon, TasksIcon } from "./Icons.tsx";
import { isSlackNoise, slackText } from "../../shared/baCustomers.ts";
import { useEffect, useMemo, useState } from "react";
import type { BaAgendaEvent, BaCustomer, BaFrontThread, BaRequirement, BaSlackPost, Cached } from "../../shared/baCustomers.ts";
import { cleanMail } from "../../shared/mailClean.ts";
import { baApi } from "../api.ts";
import { ago, useAction } from "./CustomerPanels.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { RunWhere } from "./RunWhere.tsx";

/**
 * BA edition: what is going on at one customer, at a glance. The latest mail, the
 * latest Slack posts, the next meetings and the open tickets, each with a session
 * one click away, and suggestions to take items that look like the same topic into
 * one session.
 */

type Mail = BaFrontThread & { irUrl: string | null; linked: boolean };
type Item = { kind: "mail" | "slack" | "ticket"; title: string; text: string; url: string | null; at: number | null };

const DONE = /done|live|closed|won.?t|duplicate|cancel|no longer/i;
const STOP = new Set(
  "about above after again against because before being below between could doing during further having other should their there these those through under until where which while would your yours from with that this have been will into what when they them then than also just only very more most such some please thanks thank regards hello dear kind best mail email message today tomorrow monday tuesday wednesday thursday friday integration request setup qargo order orders trip trips".split(
    " ",
  ),
);
const words = (s: string, skip: Set<string>) =>
  new Set(
    s
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9 ]+/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 5 && !STOP.has(w) && !skip.has(w)),
  );

/** Items from different sources that share rare words: a mail, a Slack post and a ticket about the same thing. */
function topics(items: Item[], customer: BaCustomer): Item[][] {
  const skip = new Set([customer.name, ...customer.deals.map((d) => d.name)].join(" ").toLowerCase().split(/\W+/));
  const ws = items.map((i) => words(`${i.title} ${i.text}`, skip));
  const df = new Map<string, number>();
  for (const w of ws) for (const x of w) df.set(x, (df.get(x) ?? 0) + 1);
  const parent = items.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i]!)));
  for (let a = 0; a < items.length; a++)
    for (let b = a + 1; b < items.length; b++) {
      if (items[a]!.kind === items[b]!.kind) continue;
      const shared = [...ws[a]!].filter((x) => ws[b]!.has(x));
      const score = shared.reduce((s, x) => s + 1 / (df.get(x) ?? 1), 0);
      if (score >= 0.9) parent[find(a)] = find(b);
    }
  const groups = new Map<number, Item[]>();
  items.forEach((it, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), it]));
  return [...groups.values()].filter((g) => g.length >= 2 && new Set(g.map((x) => x.kind)).size >= 2).slice(0, 4);
}

export default function CustomerOverview({ projectId, onOpen, onTab }: { projectId: number; onOpen: (key: string) => void; onTab: (tab: "requirements" | "front") => void }) {
  const [customer, setCustomer] = useState<BaCustomer | null | undefined>(undefined);
  const [mail, setMail] = useState<Cached<Mail[]> | null>(null);
  const [slack, setSlack] = useState<Cached<BaSlackPost[]> | null>(null);
  const [agenda, setAgenda] = useState<BaAgendaEvent[]>([]);
  const [tickets, setTickets] = useState<BaRequirement[]>([]);
  const { run, error } = useAction(onOpen);

  useEffect(() => {
    void baApi.customer(projectId).then((r) => setCustomer(r.customer)).catch(() => setCustomer(null));
    void baApi.front(projectId).then(setMail).catch(() => {});
    void baApi.slack(projectId).then(setSlack).catch(() => {});
    void baApi.agenda(7).then((r) => setAgenda((r.data ?? []).filter((e) => e.projectId === projectId && !e.declined))).catch(() => {});
    void baApi.requirements(projectId).then((r) => setTickets(r.data ?? [])).catch(() => {});
  }, [projectId]);

  const mails = useMemo(() => [...(mail?.data ?? [])].sort((a, b) => Number(b.linked) - Number(a.linked) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0)).slice(0, 3), [mail]);
  const posts = (slack?.data ?? []).filter((p) => !isSlackNoise(p.text)).slice(0, 3);
  const open = tickets.filter((t) => !DONE.test(t.status ?? "") && t.type !== "Feature request");
  const byStatus = [...open.reduce((m, t) => m.set(t.status ?? "No status", (m.get(t.status ?? "No status") ?? 0) + 1), new Map<string, number>())].sort((a, b) => b[1] - a[1]);
  const billable = open.reduce((m, t) => (t.billableStatus && t.billableAmount ? m.set(t.billableStatus, (m.get(t.billableStatus) ?? 0) + t.billableAmount) : m), new Map<string, number>());
  const next = agenda.filter((e) => (e.end ?? e.start ?? 0) > Date.now()).slice(0, 2);

  const suggestions = useMemo(() => {
    if (!customer) return [];
    const items: Item[] = [
      ...(mail?.data ?? []).slice(0, 15).map((m) => ({ kind: "mail" as const, title: m.subject, text: m.snippet ?? "", url: m.link, at: m.updatedAt })),
      ...(slack?.data ?? []).map((p) => ({ kind: "slack" as const, title: p.author, text: slackText(p.text).slice(0, 400), url: null, at: p.at ? Date.parse(p.at) : null })),
      ...open.slice(0, 60).map((t) => ({ kind: "ticket" as const, title: t.title, text: "", url: t.url, at: null })),
    ];
    return topics(items, customer);
  }, [customer, mail, slack, open]);

  if (customer === undefined) return null;
  if (!customer) return null;
  const money = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

  return (
    <div className="co">
      <div className="co-run">
        <span className="ba-muted">Session buttons run</span>
        <RunWhere compact />
      </div>
      {error && <div className="chat-error">{error}</div>}
      {suggestions.length > 0 && (
        <div className="co-topics">
          {suggestions.map((g, i) => (
            <div key={i} className="co-topic">
              <span className="co-topic-label">Same topic?</span>
              <span className="co-topic-items">
                {g.map((x, j) => (
                  <span key={j} className={`co-chip ${x.kind}`}>
                    {x.kind === "mail" ? <InboxIcon /> : x.kind === "slack" ? <CommentIcon /> : <TasksIcon />} {x.title.slice(0, 60)}
                  </span>
                ))}
              </span>
              <button
                className="icon-btn primary"
                onClick={() =>
                  void run("topic-session", {
                    projectId,
                    label: g.find((x) => x.kind === "ticket")?.title ?? g[0]!.title.slice(0, 40),
                    urls: g.map((x) => x.url).filter((u): u is string => !!u),
                    material: g.map((x) => `[${x.kind.toUpperCase()}] ${x.title}\n${x.text}`).join("\n\n"),
                  })
                }
              >
                One session for these
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="co-grid">
        <section className="co-card">
          <header>
            <h4>Latest mail</h4>
            <button className="icon-btn ghost" onClick={() => onTab("front")}>
              Mailbox →
            </button>
          </header>
          {mails.length === 0 && <p className="ba-muted">{mail ? "No mail placed at this customer yet." : "Loading…"}</p>}
          {mails.map((m) => (
            <div key={m.id} className="co-item">
              <div className="co-item-main">
                <strong>{m.subject}</strong>
                <span className="ba-muted">{[m.from, ago(m.updatedAt)].filter(Boolean).join(" · ")}</span>
                {m.snippet && <span className="co-snippet">{cleanMail(m.snippet).text.slice(0, 160)}</span>}
              </div>
              <button className="icon-btn" onClick={() => void run("mail-session", { projectId, url: m.link, label: m.subject })}>
                Session
              </button>
            </div>
          ))}
        </section>

        <section className="co-card">
          <header>
            <h4>Latest in Slack</h4>
            {customer.deals.find((d) => d.slackUrl) && (
              <a className="icon-btn ghost" href={customer.deals.find((d) => d.slackUrl)!.slackUrl!} target="_blank" rel="noreferrer">
                Channel ↗
              </a>
            )}
          </header>
          {slack?.error && <p className="ba-muted">{slack.error === "no Slack channel on the deal" ? "No Slack channel on the deal in Notion." : slack.error}</p>}
          {!slack && <p className="ba-muted">Loading…</p>}
          {posts.map((p, i) => (
            <div key={i} className="co-item">
              <div className="co-item-main">
                <strong>{p.author}</strong>
                <span className="ba-muted">{p.at}</span>
                <span className="co-snippet">{slackText(p.text).slice(0, 200)}</span>
              </div>
              <button className="icon-btn" onClick={() => void run("slack-session", { projectId, label: `${p.author}: ${slackText(p.text).slice(0, 30)}`, material: `${p.author} (${p.at ?? ""}):\n${slackText(p.text)}` })}>
                Session
              </button>
            </div>
          ))}
        </section>

        <section className="co-card">
          <header>
            <h4>Open tickets</h4>
            <button className="icon-btn ghost" onClick={() => onTab("requirements")}>
              All tickets →
            </button>
          </header>
          <div className="co-statuses">
            {byStatus.map(([s, n]) => (
              <span key={s} className="co-status">
                <StatusPill status={s} /> <em>{n}</em>
              </span>
            ))}
            {byStatus.length === 0 && <span className="ba-muted">{tickets.length ? "Nothing open." : "Loading…"}</span>}
          </div>
          {billable.size > 0 && (
            <div className="co-billing">
              {[...billable].map(([s, n]) => (
                <span key={s} className="co-bill">
                  <StatusPill status={s} billable /> {money(n)}
                </span>
              ))}
            </div>
          )}
          <button className="icon-btn" onClick={() => void run("prompt", { projectId, label: customer.name, prompt: "Give me the state of this customer's open integration tickets: what is blocked, what needs scoping, what is billable, and what I should do first." })}>
            Session on the open tickets
          </button>
        </section>

        <section className="co-card">
          <header>
            <h4>Next meetings</h4>
          </header>
          {next.length === 0 && <p className="ba-muted">None this week.</p>}
          {next.map((e) => (
            <div key={e.id} className="co-item">
              <div className="co-item-main">
                <strong>{e.title}</strong>
                <span className="ba-muted">{new Date(e.start!).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" })}</span>
              </div>
              <button className="icon-btn" onClick={() => void run("briefing", { projectId })}>
                Briefing
              </button>
            </div>
          ))}
        </section>
      </div>
    </div>
  );
}
