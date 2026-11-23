import { useCallback, useEffect, useMemo, useState } from "react";
import { baFlags } from "../baFlags.ts";
import {
  gateLabel,
  groupName,
  type BaActionKind,
  type BaCustomer,
  type BaDeal,
  type BaFrontThread,
  type BaIrSession,
  type BaPublished,
  type BaRequirement,
  type BaTenant,
  type BaTicket,
  type Cached,
} from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";
import { Markdown } from "./Markdown.tsx";
import { toast } from "./Toasts.tsx";
import { RunWhere } from "./RunWhere.tsx";
import { StatusPill } from "./StatusPill.tsx";
import { Agenda } from "./Agenda.tsx";
import { Reader } from "./InboxView.tsx";
import { QaiPanel } from "./QaiPanel.tsx";

/**
 * BA edition panels on a customer's page. A customer is one or more Notion
 * deals; its requirements are their Customer Tasks; each IR opens a workspace to
 * scope it, edit the ticket and build it on the Qargo MCP, all as visible sessions.
 */

type Open = (key: string) => void;

export function ago(at: number | null | undefined): string {
  if (!at) return "";
  const m = Math.round((Date.now() - at) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** Load a cached read; `refresh` forces a fresh connector call. */
export function useCached<T>(load: (refresh: boolean) => Promise<Cached<T>>, deps: unknown[]) {
  const [state, setState] = useState<Cached<T> | null>(null);
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    (refresh: boolean) => {
      setBusy(true);
      return load(refresh)
        .then(setState)
        .catch((e) => setState({ data: null, error: errText(e), fetchedAt: Date.now(), stale: true }))
        .finally(() => setBusy(false));
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    deps,
  );
  useEffect(() => {
    void run(false);
  }, [run]);
  return { state, busy, refresh: () => void run(true) };
}

export function Freshness({ state, busy, onRefresh }: { state: { fetchedAt: number; stale: boolean } | null; busy: boolean; onRefresh: () => void }) {
  return (
    <span className="ba-fresh">
      {busy ? "Asking the connector… (10–60 s)" : state ? `Updated ${ago(state.fetchedAt)}${state.stale ? " · stale" : ""}` : ""}
      <button className="icon-btn ghost" onClick={onRefresh} disabled={busy}>
        Refresh
      </button>
    </span>
  );
}

export function useAction(onOpen: Open) {
  const [error, setError] = useState<string | null>(null);
  const run = (kind: BaActionKind, opts: { projectId?: number | null; url?: string; label?: string; prompt?: string; tenant?: BaTenant; urls?: string[]; material?: string } = {}) =>
    baApi
      .action({ kind, ...opts })
      .then((r) => {
        setError(null);
        // A cloud session lives on claude.ai/code: open it there; a session on this Mac opens in the drawer.
        if (r.url) {
          const url = r.url;
          // The app opens it in the browser; a browser may block a window opened after a wait, so a toast offers it too.
          window.open(url, "_blank", "noopener");
          toast({ title: "Cloud session started", description: "It runs on claude.ai/code, also with this Mac closed.", tone: "success", duration: 12000, action: { label: "Open", run: () => void window.open(url, "_blank", "noopener") } });
        } else onOpen(r.key);
        return true;
      })
      .catch((e) => {
        setError(errText(e));
        return false;
      });
  return { run, error };
}

// ── customer header: deals, roles, matching settings ─────────────────────────

function DealChip({ d, onRemove }: { d: BaDeal; onRemove?: () => void }) {
  return (
    <span className="ba-deal-chip" title={[d.dealStatus, d.status, d.country, d.roles.join(", ")].filter(Boolean).join(" · ")}>
      <a href={d.url} target="_blank" rel="noreferrer">
        {d.name}
      </a>
      {d.dealStatus && <em>{d.dealStatus}</em>}
      {d.roles.map((r) => (
        <span key={r} className="ba-chip">
          {r}
        </span>
      ))}
      {onRemove && (
        <button className="ba-x" onClick={onRemove} aria-label={`Remove ${d.name}`}>
          ✕
        </button>
      )}
    </span>
  );
}

export function CustomerHeader({ customer, projectId, onChange }: { customer: BaCustomer | null; projectId: number; onChange: () => void }) {
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [found, setFound] = useState<BaDeal[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [frontQuery, setFrontQuery] = useState(customer?.frontQuery ?? "");
  const [domains, setDomains] = useState("");
  const [showDeals, setShowDeals] = useState(false);

  const search = () => {
    setBusy(true);
    baApi
      .searchDeals(q)
      .then((r) => setFound(r.deals))
      .catch((e) => setError(errText(e)))
      .finally(() => setBusy(false));
  };
  const slack = customer?.deals.find((d) => d.slackUrl)?.slackUrl;

  return (
    <div className="ba-card">
      {customer ? (
        <>
          {customer.deals.length > 3 && !showDeals ? (
            <div className="ba-deals">
              <button className="ba-deal-chip ba-deal-more" onClick={() => setShowDeals(true)}>
                <strong>{customer.deals.length} deals</strong>
                <em>{[...new Set(customer.deals.map((d) => d.dealStatus))].filter(Boolean).join(", ")}</em>
                {[...new Set(customer.deals.flatMap((d) => d.roles))].map((r) => (
                  <span key={r} className="ba-chip">
                    {r}
                  </span>
                ))}
                <span className="ba-muted">Show ▸</span>
              </button>
            </div>
          ) : (
            <div className="ba-deals">
              {customer.deals.map((d) => (
                <DealChip key={d.url} d={d} onRemove={customer.deals.length > 1 ? () => void baApi.assignDeals([d.url], null).then(onChange) : undefined} />
              ))}
              {customer.deals.length > 3 && (
                <button className="icon-btn ghost" onClick={() => setShowDeals(false)}>
                  Hide ▴
                </button>
              )}
            </div>
          )}
          <div className="ba-row ba-muted">
            <span>Mail matches on: {customer.domains.length ? customer.domains.join(", ") : "no domains yet (add one, or they come from IR requesters)"}</span>
            {slack && (
              <a className="icon-btn ghost" href={slack} target="_blank" rel="noreferrer">
                Slack ↗
              </a>
            )}
            <button className="icon-btn ghost" onClick={() => setEditing(!editing)}>
              Matching…
            </button>
            <button className="icon-btn ghost" onClick={() => setAdding(!adding)}>
              + Deal
            </button>
            <span className="rw-label">Sessions run:</span>
            <RunWhere compact />
          </div>
        </>
      ) : (
        <div className="ba-row">
          <span className="ba-muted">No Notion deal linked. Add one here, or create customers from your deals on the Customers page.</span>
          <button className="icon-btn primary" onClick={() => setAdding(true)}>
            Link a deal
          </button>
        </div>
      )}
      {editing && customer && (
        <div className="ba-row">
          <input className="drawings-search" placeholder="Front search term" value={frontQuery} onChange={(e) => setFrontQuery(e.target.value)} />
          <input className="drawings-search" placeholder="Extra email domains, e.g. acme.com, acme.fr" value={domains} onChange={(e) => setDomains(e.target.value)} />
          <button
            className="icon-btn primary"
            onClick={() =>
              void baApi.setCustomer(projectId, { frontQuery, extraDomains: domains || undefined }).then(() => {
                setEditing(false);
                onChange();
              })
            }
          >
            Save
          </button>
        </div>
      )}
      {adding && (
        <div className="ba-link-edit">
          <div className="ba-row">
            <input className="drawings-search" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && search()} placeholder="Deal name in Deals Extract" />
            <button className="icon-btn primary" onClick={search} disabled={busy || !q.trim()}>
              {busy ? "Searching…" : "Find deal"}
            </button>
          </div>
          {error && <div className="chat-error">{error}</div>}
          {found?.map((d) => (
            <button
              key={d.url}
              className="ba-deal"
              onClick={() =>
                void baApi.assignDeals([d.url], projectId).then(() => {
                  setAdding(false);
                  setFound(null);
                  onChange();
                })
              }
            >
              <strong>{d.name}</strong>
              <span className="ba-muted">{[d.dealStatus, d.status, d.country, d.projectId && d.projectId !== projectId ? "already on another customer" : null].filter(Boolean).join(" · ")}</span>
            </button>
          ))}
          {found?.length === 0 && <p className="ba-muted">No deal matches “{q}”.</p>}
        </div>
      )}
    </div>
  );
}

// ── IR workspace ───────────────────────────────────────────────────────────────

const money = (n: number | null) => (n === null ? "" : n.toLocaleString(undefined, { maximumFractionDigits: 0 }));

function IrWorkspace({
  req,
  projectId,
  threads,
  onOpen,
  onClose,
}: {
  req: BaRequirement;
  projectId: number;
  threads: BaFrontThread[];
  onOpen: Open;
  onClose: () => void;
}) {
  const { state, busy, refresh } = useCached<BaTicket>((r) => baApi.ticket(req.url, r), [req.url]);
  const [sessions, setSessions] = useState<(BaIrSession & { status: string | null })[]>([]);
  const [tenant, setTenant] = useState<BaTenant>("test");
  const [mcp, setMcp] = useState<{ test: string; prod: string } | null>(null);
  const checkMcp = (refresh = false) => void baApi.qargoMcp(refresh).then(setMcp).catch(() => {});
  useEffect(() => {
    if (baFlags.qargoMcp) checkMcp();
  }, []);
  const [prompt, setPrompt] = useState("");
  const [showTicket, setShowTicket] = useState(false);
  const loadSessions = useCallback(() => void baApi.irSessions(req.url).then((r) => setSessions(r.sessions)).catch(() => {}), [req.url]);
  useEffect(loadSessions, [loadSessions]);
  const { run, error } = useAction((key) => {
    loadSessions();
    onOpen(key);
  });
  const t = state?.data ?? null;
  const gate = gateLabel(t);
  const base = { projectId, url: req.url, label: req.title };
  const build = (kind: BaActionKind) => {
    if (tenant === "prod" && !window.confirm(`Work on the PRODUCTION tenant for “${req.title}”? The session will still ask before each write.`)) return;
    void run(kind, { ...base, tenant, prompt: prompt || undefined });
  };

  return (
    <div className="ba-ticket">
      <div className="ba-ticket-head">
        <strong>{req.title}</strong>
        {req.status && <span className="ba-chip ghost">{req.status}</span>}
        {t && <span className={`ba-gate ${gate.ok ? "ok" : "no"}`}>{gate.text}</span>}
        <Freshness state={state} busy={busy} onRefresh={refresh} />
        <button className="icon-btn ghost" onClick={onClose} aria-label="Close">
          ✕
        </button>
      </div>

      <div className="ba-groups">
        <div className="ba-group">
          <h4>Notion</h4>
          <div className="ba-row">
            <button className="icon-btn primary" disabled={!t || !gate.ok} title={gate.ok ? "prof-svc-scoping, Mode A" : `Gate not met: ${gate.text}`} onClick={() => void run("scope", base)}>
              Scope (Mode A)
            </button>
            <button className="icon-btn" onClick={() => void run("fill-blocks", base)}>
              Fill building blocks
            </button>
            <button className="icon-btn" onClick={() => void run("update-ticket", { ...base, prompt: prompt || undefined })} title="Uses the text box below as the change, or fills gaps in the intake">
              Update ticket
            </button>
            <a className="icon-btn ghost" href={req.url} target="_blank" rel="noreferrer">
              Open ↗
            </a>
          </div>
        </div>
        {baFlags.qargoMcp && <div className="ba-group">
          <h4>
            Build in Qargo
            <span className="ba-seg" role="radiogroup" aria-label="Tenant">
              {(["test", "prod"] as const).map((x) => (
                <button key={x} role="radio" aria-checked={tenant === x} className={tenant === x ? "on" : ""} onClick={() => setTenant(x)}>
                  <span className={`mcp-dot ${mcp?.[x] ?? "unknown"}`} /> {x === "test" ? "Test MCP" : "Prod MCP"}
                </button>
              ))}
            </span>
          </h4>
          {mcp && mcp[tenant] !== "connected" && mcp[tenant] !== "unknown" && (
            <div className="mcp-warn">
              {mcp[tenant] === "needs-auth"
                ? `The ${tenant} Qargo MCP is not signed in. Sign in once in claude.ai → Settings → Connectors (qargo-mcp-${tenant}), or start the session anyway: it will give you the sign-in link first.`
                : mcp[tenant] === "missing"
                  ? `The ${tenant} Qargo MCP is not among your connectors. Add qargo-mcp-${tenant} in claude.ai → Settings → Connectors.`
                  : `The ${tenant} Qargo MCP did not answer the last check.`}
              <button className="icon-btn ghost" onClick={() => checkMcp(true)}>
                Check again
              </button>
            </div>
          )}
          <div className="ba-row">
            <button className="icon-btn" onClick={() => build("build-integration")}>
              Create integration
            </button>
            <button className="icon-btn" onClick={() => build("build-mapping")}>
              Create mapping
            </button>
            <button className="icon-btn" onClick={() => build("build-visibility")}>
              Visibility mapping
            </button>
          </div>
        </div>}
      </div>

      <div className="ba-ask">
        <textarea
          className="ba-prompt"
          rows={2}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={`What should Claude do on “${req.title}”? E.g. “add the SFTP folder structure to the ticket”, “create the order import mapping from the sample in the Front thread”`}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && prompt.trim()) void run("prompt", { ...base, tenant, prompt }).then((ok) => ok && setPrompt(""));
          }}
        />
        <RunWhere compact />
        <button className="icon-btn primary" disabled={!prompt.trim()} onClick={() => void run("prompt", { ...base, tenant, prompt }).then((ok) => ok && setPrompt(""))}>
          Run ⌘↵
        </button>
      </div>
      {(state?.error || error) && <div className="chat-error">{state?.error || error}</div>}

      {baFlags.qai && (
        <details className="ba-sub">
          <summary className="ba-muted">Ask Qai about this IR (#ps_troubleshooting)</summary>
          <QaiPanel projectId={projectId} irUrl={req.url} />
        </details>
      )}

      {threads.length > 0 && (
        <div className="ba-sub">
          <h4>Front threads on this IR</h4>
          {threads.map((th) => (
            <a key={th.id} className="ba-line" href={th.link} target="_blank" rel="noreferrer">
              {th.subject} <span className="ba-muted">{[th.from, ago(th.updatedAt)].filter(Boolean).join(" · ")}</span>
            </a>
          ))}
        </div>
      )}
      {sessions.length > 0 && (
        <div className="ba-sub">
          <h4>Work on this IR</h4>
          {sessions.map((s) => (
            s.key.startsWith("https://") ? (
              <span key={s.id} className="ba-line">
                <a href={s.key} target="_blank" rel="noreferrer">
                  {s.title}
                </a>
                <span className="ba-muted">{["on claude.ai/code", ago(s.startedAt)].join(" · ")}</span>
                <button
                  className="icon-btn ghost"
                  title="Pull this cloud session onto this Mac (claude --teleport) and keep working with your local files"
                  onClick={() => void baApi.teleport(s.key, projectId).then((r) => onOpen(r.key)).catch(() => {})}
                >
                  Continue on this Mac
                </button>
              </span>
            ) : (
              <button key={s.id} className="ba-line" onClick={() => onOpen(s.key)} disabled={s.status === null} title={s.status === null ? "This session is no longer running in the dashboard; find it under History." : ""}>
                {s.title} <span className="ba-muted">{[s.status ?? "ended", ago(s.startedAt)].join(" · ")}</span>
              </button>
            )
          ))}
        </div>
      )}
      {t && (
        <div className="ba-sub">
          <button className="icon-btn ghost" onClick={() => setShowTicket(!showTicket)}>
            {showTicket ? "Hide ticket" : "Show ticket"}
          </button>
          {showTicket && (
            <div className="ba-ticket-body">
              <Markdown text={t.markdown.replace(/<[^>]+>/g, "")} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── requirements ───────────────────────────────────────────────────────────────

type Group = "none" | "status" | "type" | "billable" | "priority" | "deal";
const OPEN_EXCLUDE = /done|live|closed|won.?t|duplicate|cancel|no longer|resolved/i;

export function RequirementsPanel({ projectId, customer, onOpen }: { projectId: number; customer: BaCustomer | null; onOpen: Open }) {
  const { state, busy, refresh } = useCached<BaRequirement[]>((r) => baApi.requirements(projectId, r), [projectId, customer?.deals.length]);
  const front = useCached<(BaFrontThread & { irUrl: string | null; linked: boolean })[]>((r) => baApi.front(projectId, r), [projectId]);
  const [statusF, setStatusF] = useState<"open" | "all" | "done">("open");
  const [typeF, setTypeF] = useState<string>("integrations");
  const [billF, setBillF] = useState<string>("");
  const [q, setQ] = useState("");
  const [group, setGroup] = useState<Group>("status");
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const { run, error } = useAction(onOpen);
  if (!customer) return null;

  const all = state?.data ?? [];
  const types = [...new Set(all.map((r) => r.type).filter((t): t is string => !!t))];
  const bills = [...new Set(all.map((r) => r.billableStatus).filter((t): t is string => !!t))];
  const rows = all
    .filter((r) => (statusF === "all" ? true : statusF === "open" ? !OPEN_EXCLUDE.test(r.status ?? "") : OPEN_EXCLUDE.test(r.status ?? "")))
    .filter((r) => (typeF === "" ? true : typeF === "integrations" ? r.type === "Integration request" || r.type === "Onboarding task" : r.type === typeF))
    .filter((r) => !billF || r.billableStatus === billF)
    .filter((r) => !q || r.title.toLowerCase().includes(q.toLowerCase()));
  const dealOf = (r: BaRequirement) =>
    customer.deals
      .filter((d) => r.dealIds.some((id) => d.url.toLowerCase().includes(id)))
      .map((d) => (customer.deals.length > 1 ? d.name.replace(groupName(d.name), "").replace(/^\s*[-–]\s*/, "") || d.name : d.name))
      .join(", ") || "—";
  const keyOf = (r: BaRequirement): string =>
    group === "status" ? r.status ?? "No status" : group === "type" ? r.type ?? "No type" : group === "billable" ? r.billableStatus ?? "Not billable" : group === "priority" ? r.priority ?? "No priority" : group === "deal" ? dealOf(r) : "All";
  const groups = [...rows.reduce((m, r) => m.set(keyOf(r), [...(m.get(keyOf(r)) ?? []), r]), new Map<string, BaRequirement[]>())].sort((a, b) => b[1].length - a[1].length);
  const sum = (rs: BaRequirement[]) => rs.reduce((s, r) => s + (r.billableAmount ?? 0), 0);
  const threadsFor = (url: string) => (front.state?.data ?? []).filter((t) => t.linked && t.irUrl === url);
  const current = all.find((r) => r.url === open);
  const selected = all.filter((r) => sel.has(r.url));
  const toggle = (url: string) =>
    setSel((s0) => {
      const n = new Set(s0);
      if (n.has(url)) n.delete(url);
      else n.add(url);
      return n;
    });
  const allShown = rows.length > 0 && rows.every((r) => sel.has(r.url));

  return (
    <div className="ba-panel">
      <div className="ba-panel-head">
        <h3>Integration tickets</h3>
        <span className="ba-muted">
          {rows.length} shown of {all.length} · billable {money(sum(rows))}
        </span>
        <Freshness state={state} busy={busy} onRefresh={refresh} />
      </div>

      <div className="tk-filters">
        <span className="ba-seg" role="tablist">
          {(["open", "all", "done"] as const).map((k) => (
            <button key={k} role="tab" aria-selected={statusF === k} className={statusF === k ? "on" : ""} onClick={() => setStatusF(k)}>
              {k === "open" ? "Open" : k === "all" ? "All" : "Done"}
            </button>
          ))}
        </span>
        <select className="icon-btn ba-select" value={typeF} onChange={(e) => setTypeF(e.target.value)}>
          <option value="integrations">Integrations & onboarding</option>
          <option value="">All types</option>
          {types.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <select className="icon-btn ba-select" value={billF} onChange={(e) => setBillF(e.target.value)}>
          <option value="">Any billing</option>
          {bills.map((b) => (
            <option key={b} value={b}>
              {b}
            </option>
          ))}
        </select>
        <select className="icon-btn ba-select" value={group} onChange={(e) => setGroup(e.target.value as Group)}>
          <option value="status">Group: status</option>
          <option value="type">Group: type</option>
          <option value="billable">Group: billing</option>
          <option value="priority">Group: priority</option>
          {customer.deals.length > 1 && <option value="deal">Group: deal</option>}
          <option value="none">No grouping</option>
        </select>
        <input className="drawings-search tk-search" type="search" placeholder="Search tickets" value={q} onChange={(e) => setQ(e.target.value)} />
      </div>

      <div className={`tk-bulk ${selected.length ? "on" : ""}`}>
        {selected.length ? (
          <>
            <strong>{selected.length} selected</strong>
            <button className="icon-btn primary" onClick={() => void run("draw", { projectId, urls: selected.map((r) => r.url) })}>
              Draw landscape
            </button>
            <button className="icon-btn primary" onClick={() => void run("scope", { projectId, urls: selected.map((r) => r.url), label: `${selected.length} tickets` })}>
              Scope
            </button>
            {selected.length === 1 && (
              <button className="icon-btn" onClick={() => void run("fill-blocks", { projectId, url: selected[0]!.url, label: selected[0]!.title })}>
                Fill building blocks
              </button>
            )}
            <button
              className="icon-btn"
              onClick={() =>
                void run("topic-session", {
                  projectId,
                  label: selected.length === 1 ? selected[0]!.title : `${selected.length} tickets`,
                  urls: selected.map((r) => r.url),
                  material: selected.map((r) => `[TICKET] ${r.title} · ${r.status ?? "?"} · ${r.billableStatus ?? ""} ${r.billableAmount ?? ""}\n${r.url}`).join("\n\n"),
                })
              }
            >
              Session with these
            </button>
            <button className="icon-btn ghost" onClick={() => setSel(new Set())}>
              Clear
            </button>
          </>
        ) : (
          <span className="ba-muted">Select tickets to draw the landscape, scope them (the skill picks pre-sales or Mode A itself) or start a session.</span>
        )}
      </div>
      {(state?.error || error) && <div className="chat-error">{state?.error || error}</div>}

      {state?.data && (
        <table className="ba-table tk-table">
          <thead>
            <tr>
              <th className="tk-check">
                <input type="checkbox" checked={allShown} onChange={() => setSel(allShown ? new Set() : new Set(rows.map((r) => r.url)))} aria-label="Select all shown" />
              </th>
              <th>Ticket</th>
              <th>Status</th>
              <th>Priority</th>
              <th>Blocks</th>
              <th>Mail</th>
              <th>Billing</th>
              <th className="tk-num">Amount</th>
            </tr>
          </thead>
          {groups.map(([g, rs]) => (
            <tbody key={g}>
              {group !== "none" && (
                <tr className="tk-group" onClick={() => setCollapsed((c) => (c.has(g) ? new Set([...c].filter((x) => x !== g)) : new Set([...c, g])))}>
                  <td colSpan={7}>
                    <span className="tk-caret">{collapsed.has(g) ? "▸" : "▾"}</span>
                    {group === "status" ? <StatusPill status={g} /> : group === "billable" ? <StatusPill status={g} billable /> : <strong>{g}</strong>} <em>{rs.length}</em>
                  </td>
                  <td className="tk-num">{sum(rs) ? money(sum(rs)) : ""}</td>
                </tr>
              )}
              {!collapsed.has(g) &&
                rs.map((r) => (
                  <tr key={r.url} className={`${open === r.url ? "on" : ""} ${sel.has(r.url) ? "sel" : ""}`} onClick={() => setOpen(open === r.url ? null : r.url)}>
                    <td className="tk-check" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={sel.has(r.url)} onChange={() => toggle(r.url)} aria-label={`Select ${r.title}`} />
                    </td>
                    <td>
                      <span className="ba-title">{r.title}</span>
                      {r.type && r.type !== "Integration request" && <span className="ba-chip ghost">{r.type}</span>}
                      {customer.deals.length > 1 && <span className="ba-muted ba-dealname">{dealOf(r)}</span>}
                    </td>
                    <td>
                      <StatusPill status={r.status} />
                    </td>
                    <td className="ba-muted">{r.priority}</td>
                    <td>{r.blocks || <span className="ba-muted">—</span>}</td>
                    <td>{threadsFor(r.url).length || ""}</td>
                    <td>{r.billableStatus && <StatusPill status={r.billableStatus} billable />}</td>
                    <td className="tk-num">{r.billableAmount !== null ? money(r.billableAmount) : ""}</td>
                  </tr>
                ))}
            </tbody>
          ))}
          {rows.length === 0 && (
            <tbody>
              <tr>
                <td colSpan={8} className="ba-muted">
                  Nothing matches these filters.
                </td>
              </tr>
            </tbody>
          )}
        </table>
      )}
      {current && <IrWorkspace key={current.url} req={current} projectId={projectId} threads={threadsFor(current.url)} onOpen={onOpen} onClose={() => setOpen(null)} />}
      {baFlags.published && <CustomerArtifacts projectId={projectId} />}
    </div>
  );
}

function CustomerArtifacts({ projectId }: { projectId: number }) {
  const [items, setItems] = useState<BaPublished[]>([]);
  useEffect(() => {
    void baApi
      .published()
      .then((r) => setItems(r.published.filter((p) => p.projectIds.includes(projectId))))
      .catch(() => {});
  }, [projectId]);
  if (!items.length) return null;
  return (
    <div className="ba-sub">
      <h4>Published artifacts</h4>
      {items.map((p) => (
        <a key={p.url} className="ba-line" href={p.url} target="_blank" rel="noreferrer">
          {p.title} <span className="ba-muted">{[p.owner === "shared" ? "shared with you" : null, p.updated].filter(Boolean).join(" · ")}</span>
        </a>
      ))}
    </div>
  );
}

// ── Front ──────────────────────────────────────────────────────────────────────

export function ThreadRow({
  t,
  projectId,
  onOpen,
  isNew,
  children,
}: {
  t: BaFrontThread;
  projectId: number | null;
  onOpen: Open;
  isNew?: boolean;
  children?: React.ReactNode;
}) {
  const { run, error } = useAction(onOpen);
  return (
    <div className={`ba-thread ${isNew ? "is-new" : ""}`}>
      <div className="ba-thread-main">
        <a href={t.link} target="_blank" rel="noreferrer" className="ba-title">
          {isNew && <span className="ba-dot" aria-label="new" />}
          {t.subject}
        </a>
        <span className="ba-muted">
          {[t.from, t.status, t.assignee, ago(t.updatedAt)].filter(Boolean).join(" · ")}
          {t.tags.map((tag) => (
            <span key={tag} className="ba-chip ghost">
              {tag}
            </span>
          ))}
        </span>
        {t.snippet && <span className="ba-snippet">{t.snippet}</span>}
        {children}
        {error && <div className="chat-error">{error}</div>}
      </div>
      <div className="ba-thread-actions">
        <button className="icon-btn" disabled={!projectId} title={projectId ? "" : "Place this thread at a customer first"} onClick={() => void run("ir-from-front", { projectId, url: t.link, label: t.subject })}>
          Create IR
        </button>
        <button className="icon-btn ghost" onClick={() => void run("draft-reply", { projectId, url: t.link, label: t.subject })}>
          Draft reply
        </button>
      </div>
    </div>
  );
}

/** Pick an IR of one customer, read from its (cached) requirements. */
export function IrPicker({ projectId, value, onChange }: { projectId: number; value: string | null; onChange: (url: string | null) => void }) {
  const [irs, setIrs] = useState<BaRequirement[]>([]);
  useEffect(() => {
    void baApi
      .requirements(projectId)
      .then((r) => setIrs((r.data ?? []).filter((x) => x.type !== "Feature request")))
      .catch(() => {});
  }, [projectId]);
  return (
    <select className="icon-btn ba-select" value={value ?? ""} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">No specific IR</option>
      {irs.map((r) => (
        <option key={r.url} value={r.url}>
          {r.title}
        </option>
      ))}
    </select>
  );
}

/** The customer's mail as a small mailbox: placed threads first, then what a search for the customer finds; the reader on the right. */
export function FrontPanel({ projectId, customer, onOpen }: { projectId: number; customer: BaCustomer | null; onOpen: Open }) {
  const { state, busy, refresh } = useCached((r) => baApi.front(projectId, r), [projectId, customer?.frontQuery]);
  const [selected, setSelected] = useState<string | null>(null);
  const [allCustomers, setAllCustomers] = useState<BaCustomer[]>([]);
  const [q, setQ] = useState("");
  useEffect(() => {
    void baApi.customers().then((r) => setAllCustomers(r.customers)).catch(() => {});
  }, []);
  if (!customer) return null;
  const threads = (state?.data ?? [])
    .filter((t) => !q || `${t.subject} ${t.from ?? ""}`.toLowerCase().includes(q.toLowerCase()))
    .sort((a, b) => Number(b.linked) - Number(a.linked) || (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  const current = threads.find((t) => t.id === selected) ?? null;
  const asTriage = (t: (typeof threads)[number]) => ({
    ...t,
    link_: t.linked ? { threadId: t.id, projectId, irUrl: t.irUrl, source: "manual" as const, linkedAt: 0 } : null,
    suggestion: null,
  });
  const place = (th: BaFrontThread, pid: number | null, ir: string | null) =>
    (pid === null ? baApi.untriage(th.id).then(() => ({})) : baApi.triage(th, pid, ir, "manual")).then((r) => {
      refresh();
      return r;
    });
  const when = (at: number | null) => (at ? (new Date(at).toDateString() === new Date().toDateString() ? new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" })) : "");

  return (
    <div className="cmb">
      <section className="cmb-list">
        <div className="mb-list-head">
          <input className="drawings-search" type="search" placeholder={`Search ${customer.name} mail`} value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="icon-btn ghost" onClick={refresh} disabled={busy} title="Read Front again">
            {busy ? "…" : "↻"}
          </button>
        </div>
        {state?.error && <div className="chat-error">{state.error}</div>}
        {state && threads.length === 0 && <div className="empty">No mail for this customer yet. Placed threads and a search for “{customer.frontQuery}” show here.</div>}
        <div className="mb-rows">
          {threads.map((t) => (
            <button key={t.id} className={`mb-row ${selected === t.id ? "on" : ""}`} onClick={() => setSelected(t.id)}>
              <div className="mb-row-top">
                <span className="mb-from">{t.from ?? "Unknown"}</span>
                <span className="mb-time">{when(t.updatedAt)}</span>
              </div>
              <div className="mb-subject">{t.subject}</div>
              {t.snippet && <div className="mb-snippet">{t.snippet}</div>}
              <div className="mb-tags">{t.linked ? <span className="ba-chip">placed here</span> : <span className="ba-chip ghost">found by search</span>}</div>
            </button>
          ))}
        </div>
      </section>
      {current ? (
        <Reader t={asTriage(current)} customers={allCustomers} onPlaced={place} onOpen={onOpen} />
      ) : (
        <div className="mb-reader mb-empty">
          <div className="empty">Select a conversation.</div>
        </div>
      )}
    </div>
  );
}

/** The header and one panel, for the customer page's Requirements and Front tabs. */
export function CustomerSection({ projectId, view, onOpen }: { projectId: number; projectName: string; view: "requirements" | "front"; onOpen: Open }) {
  const [customer, setCustomer] = useState<BaCustomer | null | undefined>(undefined);
  const load = useCallback(
    () =>
      void baApi
        .customer(projectId)
        .then((r) => setCustomer(r.customer))
        .catch(() => setCustomer(null)),
    [projectId],
  );
  useEffect(load, [load]);
  if (customer === undefined) return <div className="empty">Loading…</div>;
  return (
    <div className="ba-section">
      <CustomerHeader customer={customer} projectId={projectId} onChange={load} />
      {view === "requirements" ? <RequirementsPanel projectId={projectId} customer={customer} onOpen={onOpen} /> : <FrontPanel projectId={projectId} customer={customer} onOpen={onOpen} />}
    </div>
  );
}
