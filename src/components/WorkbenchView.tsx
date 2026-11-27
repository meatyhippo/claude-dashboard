import { QargoMcpBanner } from "./QargoMcpBanner.tsx";
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ClaudeMark } from "./Icons.tsx";
import type { BaFrontThread, Cached } from "../../shared/baCustomers.ts";
import { blockerOf, dateTone, stageOf, dueOf, held, neededForGoLive, toneRank, nextStep, prioRank, WB_AWAIT, WB_PHASES, WB_STATUS_OPTS, type WbDigest, type WbFrontCand, type WbLinkedThread, type WbRow, type WbStage, type WbStep, type WbTab } from "../../shared/wb.ts";
import { agentApi, type WbViewAs, wbApi } from "../api.ts";
import { Freshness } from "./CustomerPanels.tsx";
import { AskQuestions, askQuestions } from "./Conversation.tsx";

/**
 * Workbench: your engineering tickets as one list per kind of work, each with its
 * setup steps and a Claude Code session of its own.
 *
 * The page only shows and steers. Reading Notion, saving steps and running Claude
 * all happen in the daemon (`server/wb.ts`); the chat of a ticket is the dashboard's
 * normal session view, opened in the drawer.
 */

type Rows = Cached<WbRow[]> & { mode: "auto" | "step"; viewAs?: WbViewAs | null };
type Tab = "digest" | "tickets";
const TABS: [Tab, string][] = [["digest", "Morning digest"], ["tickets", "Tickets"]];
const KINDS: [WbTab, string, string][] = [["scoping", "Scoping", "Scoping"], ["tasks", "Tasks", "Task"], ["cr", "Change requests", "CR"]];
const STAGES: [WbStage, string][] = [["backlog", "Backlog"], ["current", "Current"], ["test", "To test"], ["hold", "Blocked / on hold"]];
const DAY = 86_400_000;
const dmy = (iso: string) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "");
const today = () => new Date().toISOString().slice(0, 10);
const remember = (k: string, v?: string) => {
  try {
    if (v === undefined) return localStorage.getItem(k);
    localStorage.setItem(k, v);
  } catch {
    /* private window */
  }
  return null;
};

/** A Commit date or Go-live date cell, coloured by Sander's rule (shared/wb.ts dateTone). */
function DateCell({ iso, col, r }: { iso: string; col: "commit" | "golive"; r: WbRow }) {
  const tone = dateTone(iso, col, neededForGoLive(r));
  const d = String(iso || "").slice(0, 10);
  return (
    <td className={`wb-date ${tone}`} title={r.reqPriority ? `Customer task priority: ${r.reqPriority}` : undefined}>
      {d ? dmy(d) : "No date yet"}
    </td>
  );
}

/** Calendar days between that moment and today, in local time (last night is "1 day ago", not "today"). */
const daysSince = (at: number) => {
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((day(new Date()) - day(new Date(at))) / 86_400_000);
};
const localDay = (at: number) => new Date(at).toLocaleDateString("en-GB");
const sinceLabel = (at: number) => { const d = daysSince(at); return d <= 0 ? "Today" : d === 1 ? "1 day ago" : `${d} days ago`; };

/** Days since the newest email across the ticket's Front threads (Sander's "Last Contact Date"). */
function ContactCell({ r, onMenu }: { r: WbRow; onMenu: (e: React.MouseEvent, ask?: boolean) => void }) {
  const c = r.contact;
  const menu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    onMenu(e);
  };
  const n = r.frontAsk?.threads.length ?? 0;
  const ask = n > 0 && (
    <button
      className="wb-contact-ask"
      title="The background Front search found newer threads it could not place on this ticket: pick the right one"
      onClick={(e) => { e.stopPropagation(); onMenu(e, true); }}
    >
      {n === 1 ? "New thread? Check" : `${n} new threads? Pick`}
    </button>
  );
  if (!c) {
    // A Front Link that is a conversation or message is still being read; anything else
    // (an inbox view, nothing) has no thread to read: say so instead of a waiting "…".
    const reading = r.frontLinked ? r.frontLinked.some((x) => !x.at) || /msg_[a-z0-9]+/i.test(r.front) : /(cnv|msg)_[a-z0-9]+/i.test(r.front);
    return (
      <td className="wb-contact ba-muted" onContextMenu={menu} title="Right-click to see, add or remove the Front threads on this ticket">
        {reading ? "…" : "No thread"}
        {!reading && !ask && <div className="wb-contact-hint">searched automatically</div>}
        {ask}
      </td>
    );
  }
  const d = daysSince(c.at);
  return (
    <td className={`wb-contact ${d >= 30 ? "old" : d >= 14 ? "stale" : ""}`} onContextMenu={menu} title={`${new Date(c.at).toLocaleString()} · ${c.inbound ? "from" : "by"} ${c.who}${c.threads.length > 1 ? ` · newest of ${c.threads.length} threads` : ""} · right-click to see, add or remove its Front threads`}>
      {sinceLabel(c.at)}
      <div className="ba-muted">{c.inbound ? "Customer" : "Us"}</div>
      {ask}
    </td>
  );
}

/** Every Front thread on the ticket with its last email, the most recent in bold, and a way to change them. */
function ContactThreads({ r }: { r: WbRow }) {
  const c = r.contact;
  const read = new Map((c?.threads ?? []).map((t) => [t.id, t]));
  const all = r.frontLinked ?? c?.threads.map((t) => ({ id: t.id, subject: t.subject, link: t.link, at: t.at, fromNotion: false })) ?? [];
  const manage = (e: React.MouseEvent) => window.dispatchEvent(new CustomEvent("wb-front-menu", { detail: { url: r.url, x: e.clientX, y: e.clientY } }));
  return (
    <div className="wb-threads">
      <span className="ba-muted">
        Front threads ({all.length}){" "}
        <button className="wb-linkbtn" onClick={manage}>{all.length ? "Change" : "Add"}</button>
      </span>
      {all.map((t, i) => {
        const m = read.get(t.id);
        return (
          <a key={t.id} href={t.link} target="_blank" rel="noreferrer" className={i === 0 && m ? "newest" : ""}>
            {t.at ? localDay(t.at) : "not read yet"} · {t.subject || "(no subject)"}
            {m && <span className="ba-muted"> ({m.inbound ? "from" : "by"} {m.who}, {sinceLabel(m.at).toLowerCase()})</span>}
          </a>
        );
      })}
    </div>
  );
}

function sortRows(list: WbRow[]) {
  // Starred first, then Sander's date colours: the worse of Commit date and Go-live date
  // (red, orange, yellow, green, gray, no date). Within a colour, the nearest date first.
  const rank = (r: WbRow) => Math.min(toneRank(dateTone(r.committed, "commit", neededForGoLive(r))), toneRank(dateTone(r.deal?.golive ?? "", "golive", neededForGoLive(r))));
  const near = (r: WbRow) => [r.committed, r.deal?.golive].map((d) => String(d || "").slice(0, 10)).filter(Boolean).map((d) => Math.abs(Date.parse(d) - Date.now())).reduce((m, x) => Math.min(m, x), Infinity);
  return list.slice().sort((a, b) => Number(b.pinned) - Number(a.pinned) || rank(a) - rank(b) || near(a) - near(b) || b.edited.localeCompare(a.edited));
}

/**
 * A ticket's steps as one timeline: a dot per step on a vertical line, grouped by
 * phase. Shared by the expanded row and the panel beside a session's chat.
 */
function StepTimeline({ r, act, cols, onOpen }: { r: WbRow; act: (p: Promise<unknown>) => void; cols?: boolean; onOpen?: (s: WbStep) => void }) {
  const cur = nextStep(r.steps);
  const phases: { name: string; steps: WbStep[] }[] = [];
  for (const s of r.steps) {
    const last = phases[phases.length - 1];
    if (last && last.name === s.phase) last.steps.push(s);
    else phases.push({ name: s.phase, steps: [s] });
  }
  return (
    <div className={`wbt-phases ${cols ? "cols" : ""}`}>
      {phases.map((ph, i) => {
        const done = ph.steps.filter((s) => s.state === "done").length;
        return (
          <section key={i} className={`wbt-phase ${done === ph.steps.length ? "all-done" : ""}`}>
            <div className="wbt-tl-phase">
              <span>{ph.name || "Steps"}</span>
              <span className="wbt-phase-count">{done}/{ph.steps.length}</span>
            </div>
            <ol className="wbt-tl">
              {ph.steps.map((s) => (
                <li key={s.order} className={`wbt-tl-step ${s.state.replace(" ", "-")} ${s === cur ? "cur" : ""}`}>
                  <select className={`wb-dot ${s.state.replace(" ", "-")} ${s.kind === "manual" ? "you" : "claude"}`} value={s.state} aria-label={`State of step ${s.order}: ${s.name}`} title={s.state} onChange={(e) => act(wbApi.step(r.url, s.order, e.target.value))}>
                    <option value="pending">○</option>
                    <option value="done">✓</option>
                    <option value="needs you">!</option>
                    <option value="blocked">×</option>
                  </select>
                  <div className="wbt-tl-body">
                    <button type="button" className="wbt-tl-name" title={[s.check && `Done when: ${s.check}`, "Click to have Claude explain this step in the chat"].filter(Boolean).join("\n")} onClick={() => onOpen?.(s)}>
                      {s.name}
                      <span className={`wbt-tl-who ${s.kind === "manual" ? "you" : "claude"}`}>{s.kind === "manual" ? "you" : "Claude"}</span>
                    </button>
                  </div>
                </li>
              ))}
            </ol>
          </section>
        );
      })}
    </div>
  );
}

/** A proposed step list as one button: the details are in its tooltip, not on the page. */
function ProposalButton({ r, act }: { r: WbRow; act: (p: Promise<unknown>) => void }) {
  const p = r.proposal;
  if (!p) return null;
  const list = p.steps.map((s, i) => `${i + 1}. ${s.state === "done" ? "✓ " : ""}${s.name} · ${s.kind === "manual" ? "you" : "Claude"}`).join("\n");
  return (
    <span className="wb-proposal-btns">
      <button className="icon-btn wb-next" title={`${p.note ? p.note + "\n\n" : ""}${list}`} onClick={() => act(wbApi.proposal(r.url, true))}>
        ✓ {p.replace ? "Update" : "Save"} steps ({p.steps.length})
      </button>
      <button className="icon-btn ghost" title="Discard the proposed steps" onClick={() => act(wbApi.proposal(r.url, false))}>
        Discard
      </button>
    </span>
  );
}

/**
 * The proposed steps themselves, by phase, so you see what you save. Open when it is
 * the first list; folded when it would replace the current one (shown below it).
 */
function ProposalPreview({ p, open }: { p: NonNullable<WbRow["proposal"]>; open: boolean }) {
  const phases = WB_PHASES.map((ph) => [ph, p.steps.map((st, i) => ({ ...st, n: i + 1 })).filter((st) => st.phase === ph)] as const).filter(([, l]) => l.length);
  return (
    <details className="wb-prop" open={open}>
      <summary>{open ? "Proposed steps" : `See the proposed list (${p.steps.length} steps)`}</summary>
      {p.note && <p className="ba-muted wb-prop-note">{p.note}</p>}
      {phases.map(([ph, list]) => (
        <div key={ph} className="wb-prop-phase">
          <div className="wb-prop-ph">{ph}</div>
          {list.map((st) => (
            <div key={st.n} className={`wb-prop-step ${st.state === "done" ? "done" : ""}`} title={st.check ? `Done when: ${st.check}` : undefined}>
              <span className="wb-prop-n">{st.state === "done" ? "✓" : st.n}</span>
              <span>
                {st.name} <span className="wb-prop-who">{st.kind === "manual" ? "you" : "Claude"}</span>
                {st.check && <span className="wb-prop-check">{st.check}</span>}
              </span>
            </div>
          ))}
        </div>
      ))}
    </details>
  );
}

/** The one next action Claude named on its last status check or step run, as a button. */
function NextAction({ r, busy, run }: { r: WbRow; busy: boolean; run: (kind: "next") => void }) {
  const n = r.next;
  if (!n) return null;
  return n.who === "claude" ? (
    <button className="icon-btn wb-next" disabled={busy} title={n.prompt} onClick={() => run("next")}>
      ▶ {n.label}
    </button>
  ) : (
    <span className="wb-next-you" title={n.prompt}>
      Next for you: <strong>{n.label}</strong>
    </span>
  );
}

function Steps({ r, act, onOpen }: { r: WbRow; act: (p: Promise<unknown>) => void; onOpen?: (s: WbStep) => void }) {
  if (!r.steps.length) return <p className="ba-muted">No steps yet. Generate them, or Get current status to build them from the tenant.</p>;
  const done = r.steps.filter((s) => s.state === "done").length;
  return (
    <div className="wb-steps">
      <div className="wbt-side-head">
        <strong>Steps</strong>
        <span className="ba-muted">{done}/{r.steps.length} done</span>
      </div>
      <div className="wbt-side-bar" aria-hidden="true">
        <span style={{ width: `${(100 * done) / r.steps.length}%` }} />
      </div>
      <StepTimeline r={r} act={act} cols onOpen={onOpen} />
    </div>
  );
}

/** The open permission request of a ticket's session, if Claude waits for Allow or Deny. */
function usePendingPermission(key: string | null) {
  const [p, setP] = useState<{ requestId: string; title: string; detail: string; input: unknown; tool: string } | null>(null);
  useEffect(() => {
    if (!key) return setP(null);
    let live = true;
    agentApi
      .get(key)
      .then((d) => {
        const it = [...d.timeline].reverse().find((x) => x.kind === "permission" && !x.decision);
        if (!live) return;
        if (it && it.kind === "permission") {
          const inp = it.input && typeof it.input === "object" ? JSON.stringify(it.input).slice(0, 400) : "";
          setP({ input: it.input, tool: it.toolName, requestId: it.requestId, title: it.title || it.toolName.replace(/^mcp__[^_]+__/, ""), detail: it.description || inp });
        } else setP(null);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [key]);
  return p;
}

/** The one decision or check a ticket waits on, answerable from the overview without opening the chat. */
function QuickDecision({ r, act, run }: { r: WbRow; act: (p: Promise<unknown>) => void; run: (kind: Parameters<typeof wbApi.run>[1], open?: boolean, order?: number) => void }) {
  const b = blockerOf(r);
  const nx = nextStep(r.steps);
  const asking = r.session?.status === "awaiting-permission" ? r.session.key : null;
  const perm = usePendingPermission(asking);
  const mark = (s: WbStep, state: string) => act(wbApi.step(r.url, s.order, state));
  let head = "";
  let body: ReactNode = null;
  let btns: ReactNode = null;
  if (b.k === "claude") {
    head = "Claude is working";
    body = <p>{b.label}</p>;
    btns = <button className="icon-btn ghost" onClick={() => run("stop")}>Stop</button>;
  } else if (asking) {
    const qs = perm?.tool === "AskUserQuestion" ? askQuestions(perm.input) : null;
    head = qs ? "Claude asks you" : "Claude asks permission";
    body = perm && qs ? (
      <AskQuestions questions={qs} busy={false} onSubmit={(answers) => act(agentApi.permission(asking, perm.requestId, "allow", answers))} onSkip={() => act(agentApi.permission(asking, perm.requestId, "deny"))} />
    ) : perm ? <><p><strong>{perm.title}</strong></p>{perm.detail && <p className="wb-qd-pre">{perm.detail}</p>}</> : <p className="ba-muted">Loading the request…</p>;
    btns = perm && !qs && (
      <>
        <button className="icon-btn wb-next" onClick={() => act(agentApi.permission(asking, perm.requestId, "allow"))}>Allow</button>
        <button className="icon-btn ghost" onClick={() => act(agentApi.permission(asking, perm.requestId, "deny"))}>Deny</button>
      </>
    );
  } else if (r.proposal) {
    const p = r.proposal;
    head = `${p.replace ? "Update to" : "Save"} ${p.steps.length} proposed steps?`;
    body = (
      <>
        {p.note && <p>{p.note}</p>}
        <ol className="wb-qd-list">
          {p.steps.map((s, i) => (
            <li key={i} className={s.state === "done" ? "done" : ""}>
              {s.name} <span className="ba-muted">· {s.kind === "manual" ? "you" : "Claude"}</span>
            </li>
          ))}
        </ol>
      </>
    );
    btns = <ProposalButton r={r} act={act} />;
  } else if (b.tag === "Customer answered") {
    head = b.label;
    body = <p>The customer replied on a ticket that was waiting on them.</p>;
    btns = (
      <>
        {/^https:\/\//.test(r.front) && <a className="icon-btn front-btn" href={r.front} target="_blank" rel="noreferrer">Read in Front ↗</a>}
        <button className="icon-btn ghost" onClick={() => act(wbApi.state(r.url, null))}>Seen, back to me</button>
      </>
    );
  } else if (b.k === "others") {
    head = b.tag;
    body = nx && b.tag === "Blocked" ? <p>{nx.name}{nx.result ? `: ${nx.result}` : ""}</p> : <p className="ba-muted">Set by hand or by Claude's last check.</p>;
    btns = r.state ? <button className="icon-btn ghost" onClick={() => act(wbApi.state(r.url, null))}>Not waiting anymore</button> : nx && <button className="icon-btn ghost" onClick={() => mark(nx, "pending")}>Unblock step</button>;
  } else if (b.k === "fresh") {
    head = b.tag;
    body = <p className="ba-muted">{b.label}</p>;
    btns = r.tab === "scoping" ? (
      <button className="icon-btn wb-next" disabled={!r.request} onClick={() => run("scope")}>▶ Run the scoping</button>
    ) : (
      <button className="icon-btn wb-next" onClick={() => run("start")}>▶ Let Claude propose steps</button>
    );
  } else if (nx) {
    const manual = nx.kind === "manual";
    head = `Step ${nx.order} · ${manual ? "for you" : nx.state === "needs you" ? "Claude flagged it" : "Claude"}`;
    body = (
      <>
        <p><strong>{nx.name}</strong></p>
        {nx.check && <p className="ba-muted">Check: {nx.check}</p>}
        {nx.result && <p className="wb-qd-pre">{nx.result}</p>}
        {r.next && <p>Next: <strong>{r.next.label}</strong></p>}
      </>
    );
    btns = (
      <>
        {!manual && r.next?.who === "claude" ? (
          <button className="icon-btn wb-next" title={r.next.prompt} onClick={() => run("next")}>▶ {r.next.label}</button>
        ) : !manual ? (
          <button className="icon-btn wb-next" onClick={() => run("step")}>▶ {nx.state === "needs you" ? "Run again" : "Run this step"}</button>
        ) : null}
        <button className={`icon-btn ${manual ? "wb-next" : "ghost"}`} onClick={() => mark(nx, "done")}>✓ Mark done</button>
        <button className="icon-btn ghost" title="Claude explains this step in the chat" onClick={() => run("explain", true, nx.order)}>Explain</button>
      </>
    );
  } else {
    head = "All steps done";
    body = <p className="ba-muted">Set the status when it is tested.</p>;
  }
  return (
    <div className={`wb-qd ${b.tone}`}>
      <div className="wb-qd-head">{head}</div>
      <div className="wb-qd-body">{body}</div>
      {btns && <div className="wb-qd-btns">{btns}</div>}
    </div>
  );
}

function Detail({ r, act, run, inChat }: { r: WbRow; act: (p: Promise<unknown>) => void; run: (kind: Parameters<typeof wbApi.run>[1], open?: boolean, order?: number) => void; inChat?: boolean }) {
  const explain = (order: number) => run("explain", true, order);
  const tenant = String(r.deal?.sandbox || "").split(/[,\s]+/).filter(Boolean)[0];
  const busy = r.running || r.session?.status === "thinking";
  const cur = nextStep(r.steps);
  return (
    <div className="wb-detail">
      {!inChat && <QuickDecision r={r} act={act} run={run} />}
      <ContactThreads r={r} />
      <div className="ba-row">
        {r.tab === "scoping" ? (
          <button className="icon-btn" disabled={busy || !r.request} onClick={() => run("scope", true)}>
            Run the scoping
          </button>
        ) : r.steps.length ? (
          <button className={`icon-btn ${r.next?.who === "claude" ? "ghost" : ""}`} disabled={busy || !cur || cur.kind === "manual"} title={cur ? cur.name : "All steps done"} onClick={() => run("step", true)}>
            Run next step
          </button>
        ) : (
          <button className="icon-btn" disabled={busy} onClick={() => run("generate", true)}>
            Let Claude generate steps
          </button>
        )}
        <button className="icon-btn ghost" disabled={busy} title="Claude reads the ticket, Front and the tenant, updates the steps and says where it stands" onClick={() => run("status")}>
          Get current status
        </button>
        {!inChat && (
          <button className="icon-btn ghost" onClick={() => run("chat", true)}>
            Open chat
          </button>
        )}
        <span className="wb-links">
          <a href={r.url} target="_blank" rel="noreferrer">Engineering issue ↗</a>
          {r.request && <a href={r.request} target="_blank" rel="noreferrer">Customer request ↗</a>}
          {/^https:\/\//.test(r.front) && <a className="front-btn" href={r.front} target="_blank" rel="noreferrer">Front ↗</a>}
          {tenant && <a href={`https://app.qargo.com/${encodeURIComponent(tenant)}`} target="_blank" rel="noreferrer">Open tenant ↗</a>}
        </span>
      </div>
      {r.diag && <p className="ba-muted">{r.diag}</p>}
      {r.tab !== "scoping" && <Steps r={r} act={act} onOpen={(st) => explain(st.order)} />}
    </div>
  );
}

/** The ticket a Workbench session belongs to, read from its folder (…/wb/<notion id>). */
export const wbTicketIdOf = (cwd?: string | null) => cwd?.match(/[\\/]wb[\\/]([0-9a-f]{32})\/?$/)?.[1] ?? null;

/**
 * Beside a Workbench session's chat: the ticket's steps top to bottom, with the
 * actions, so the run can be followed step by step while Claude works.
 */
/** The Workbench ticket a session belongs to, kept fresh from the daemon's cache. */
function useWbRow(cwd?: string | null) {
  const id = wbTicketIdOf(cwd);
  const [row, setRow] = useState<WbRow | null>(null);
  const load = () =>
    wbApi
      .rows(false)
      .then((x) => setRow((x.data ?? []).find((r) => r.url.replace(/-/g, "").includes(id!)) ?? null))
      .catch(() => {});
  useEffect(() => {
    if (!id) return;
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => clearInterval(t);
  }, [id]);
  return { id, row: id ? row : null, load };
}

const tenantOf = (r: WbRow) => String(r.deal?.sandbox || "").split(/[,\s]+/).filter(Boolean)[0];

/**
 * View as: show another teammate's tickets (their "Me" view in Notion), e.g. to help
 * them or to test the Workbench on their work. Chats and changes still run as you.
 */
function ViewAs({ current, onChange }: { current: WbViewAs | null; onChange: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState<WbViewAs[] | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open || q.trim().length < 2) return setPeople(null);
    const t = setTimeout(() => void wbApi.people(q.trim()).then((r) => setPeople(r.people)).catch(() => setPeople([])), 400);
    return () => clearTimeout(t);
  }, [q, open]);
  const pick = (v: WbViewAs | null) => {
    setBusy(true);
    void wbApi.viewAs(v).then(() => { setOpen(false); setQ(""); onChange(); }).finally(() => setBusy(false));
  };
  return (
    <span className="wb-viewas">
      {current ? (
        <span className="wb-viewas-on">
          Viewing as <strong>{current.name}</strong>
          <button className="link-btn" disabled={busy} onClick={() => pick(null)}>{busy ? "Loading your tickets (about a minute)…" : "Back to my tickets"}</button>
        </span>
      ) : (
        <button className="link-btn" onClick={() => setOpen(!open)} title="Show another teammate's tickets">View as…</button>
      )}
      {open && !current && (
        <span className="wb-viewas-pop">
          <input autoFocus className="drawings-search" placeholder="Name or email of a teammate" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setOpen(false)} />
          {people === null && q.trim().length >= 2 && <span className="ba-muted">Searching Notion…</span>}
          {people?.length === 0 && <span className="ba-muted">Nobody found.</span>}
          {people?.map((p) => (
            <button key={p.id} className="wb-viewas-person" disabled={busy} onClick={() => pick(p)}>
              {p.name} {p.email && <span className="ba-muted">{p.email}</span>}
            </button>
          ))}
          {busy && <span className="ba-muted">Loading their tickets (about a minute)…</span>}
        </span>
      )}
    </span>
  );
}

/** A Workbench session's title: the ticket name, opening the ticket in Notion. */
export function WbDrawerTitle({ cwd, title }: { cwd?: string | null; title: string }) {
  const { row } = useWbRow(cwd);
  return (
    <h3 className="session-title">
      <ClaudeMark />
      {row?.url ? (
        <a className="wb-drawer-title" href={row.url} target="_blank" rel="noreferrer" title="Open the ticket in Notion" onPointerDown={(e) => e.stopPropagation()}>{title}</a>
      ) : (
        <span>{title}</span>
      )}
    </h3>
  );
}

/** Open Front and Open tenant, for the top right of a Workbench session's drawer. */
export function WbDrawerLinks({ cwd }: { cwd?: string | null }) {
  const { row } = useWbRow(cwd);
  if (!row) return null;
  const tenant = tenantOf(row);
  const front = /^https:\/\//.test(row.front) ? row.front : null;
  return (
    <span className="wb-drawer-links">
      {front && <a className="icon-btn ghost front-btn" href={front} target="_blank" rel="noreferrer">Open Front ↗</a>}
      {tenant && <a className="icon-btn ghost" href={`https://app.qargo.com/${encodeURIComponent(tenant)}`} target="_blank" rel="noreferrer">Open tenant ↗</a>}
    </span>
  );
}

/** Under Claude's last reply in a Workbench chat: the next action it named, as a button. */
export function WbChatNext({ cwd }: { cwd?: string | null }) {
  const { row, load } = useWbRow(cwd);
  if (!row?.next) return null;
  const busy = row.running || row.session?.status === "thinking";
  return (
    <div className="wb-chat-next">
      <NextAction r={row} busy={!!busy} run={() => void wbApi.run(row.url, "next").then(load).catch(() => {})} />
      <NextWhat prompt={row.next.prompt} who={row.next.who} />
    </div>
  );
}

/** What the button does, in the words it sends: the first lines, the rest on request. */
function NextWhat({ prompt, who }: { prompt: string; who: "claude" | "you" }) {
  const [all, setAll] = useState(false);
  const text = prompt.replace(/\s+/g, " ").trim();
  if (!text) return null;
  const long = text.length > 220;
  return (
    <div className="wb-next-what">
      <span className="ba-muted">{who === "claude" ? "Asks Claude to: " : "What to do: "}</span>
      {all || !long ? text : `${text.slice(0, 220).replace(/\s+\S*$/, "")}…`}
      {long && (
        <button className="link-btn" onClick={() => setAll(!all)}>
          {all ? "Less" : "More"}
        </button>
      )}
    </div>
  );
}

export function WbSessionSteps({ cwd }: { cwd?: string | null }) {
  const { id, row, load } = useWbRow(cwd);
  const [error, setError] = useState<string | null>(null);
  if (!id || !row) return null;
  const act = (p: Promise<unknown>) => void p.then(load).catch((e) => setError(String(e?.message ?? e)));
  const run = (kind: Parameters<typeof wbApi.run>[1]) => act(wbApi.run(row.url, kind));
  const busy = row.running || row.session?.status === "thinking";
  const done = row.steps.filter((s) => s.state === "done").length;
  const cur = nextStep(row.steps);
  const tenant = String(row.deal?.sandbox || "").split(/[,\s]+/).filter(Boolean)[0];
  return (
    <aside className="wbt-side">
      <div className="wbt-side-head">
        <strong>Steps</strong>
        <span className="ba-muted">{row.steps.length ? `${done}/${row.steps.length} done` : "none yet"}</span>
      </div>
      {row.qai && (
        <a className="wb-qai-banner" href={row.qai.link ?? undefined} target="_blank" rel="noreferrer" title="Read the question in Slack">
          <span className="wb-qai-dot" aria-hidden="true" /> Waiting on Qai · the answer comes into this chat by itself
        </a>
      )}
      {row.steps.length > 0 && (
        <div className="wbt-side-bar" aria-hidden="true">
          <span style={{ width: `${(100 * done) / row.steps.length}%` }} />
        </div>
      )}
      {row.proposal && (
        <div className="wbt-side-actions">
          <ProposalButton r={row} act={act} />
        </div>
      )}
      {row.proposal && <ProposalPreview p={row.proposal} open={!row.steps.length} />}
      {row.stepsError && <p className="chat-error">{row.stepsError}</p>}
      <div className="wbt-side-actions">
        {row.tab === "scoping" ? (
          <button className="icon-btn" disabled={busy || !row.request} onClick={() => run("scope")}>Run the scoping</button>
        ) : row.steps.length ? (
          <button className="icon-btn" disabled={busy || !cur || cur.kind === "manual"} title={cur ? cur.name : "All steps done"} onClick={() => run("step")}>Run next step</button>
        ) : (
          <button className="icon-btn" disabled={busy} onClick={() => run("generate")}>Generate steps</button>
        )}
        <button className="icon-btn ghost" disabled={busy} title="Claude reads the ticket, Front and the tenant, updates the steps and says where it stands" onClick={() => run("status")}>Get status</button>
      </div>
      {error && <p className="ba-muted">{error}</p>}
      {row.diag && <p className="ba-muted">{row.diag}</p>}
      {row.tab !== "scoping" && !row.steps.length && !row.proposal && <p className="ba-muted">No steps yet. Generate them, or Get status to build them from the tenant.</p>}
      <StepTimeline r={row} act={act} onOpen={(st) => act(wbApi.run(row.url, "explain", st.order))} />
      <div className="wbt-side-links">
        <a href={row.url} target="_blank" rel="noreferrer">Engineering issue ↗</a>
        {row.request && <a href={row.request} target="_blank" rel="noreferrer">Customer request ↗</a>}
      </div>
    </aside>
  );
}

/**
 * Digest items you ticked off, per sweep date (the same on Home and the Workbench).
 * Kept in this browser: it is your own to-do state for the day, not shared data.
 */
function useDigestDone(date: string | undefined) {
  const key = `wb-digest-done:${date ?? ""}`;
  const read = () => {
    try {
      return new Set<string>(JSON.parse(localStorage.getItem(key) || "[]"));
    } catch {
      return new Set<string>();
    }
  };
  const [done, setDone] = useState<Set<string>>(read);
  useEffect(() => {
    setDone(read());
    const sync = (e: StorageEvent | Event) => (!("key" in e) || (e as StorageEvent).key === key || e.type === "wb-digest-done") && setDone(read());
    window.addEventListener("storage", sync);
    window.addEventListener("wb-digest-done", sync);
    return () => {
      window.removeEventListener("storage", sync);
      window.removeEventListener("wb-digest-done", sync);
    };
  }, [key]);
  const toggle = (id: string) => {
    const next = read();
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      localStorage.setItem(key, JSON.stringify([...next]));
    } catch {
      /* private window: still toggles for this view */
    }
    setDone(next);
    window.dispatchEvent(new Event("wb-digest-done"));
  };
  return { done, toggle };
}

/** Home's Morning digest card: today's sweep from your Slack DM, the way the old artifact showed it. */
export function WbDigestCard() {
  const [d, setD] = useState<Awaited<ReturnType<typeof wbApi.digest>> | null>(null);
  const [running, setRunning] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    wbApi.digest(false).then((r) => {
      setD(r);
      setRunning(!!r.sweep?.run?.running);
    }).catch(() => setD(null));
  }, []);
  // While the sweep runs (a few minutes), check every 15 s; when it ends, read the new DM.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => {
      void wbApi.sweep().then((s) => {
        if (s.run?.running) return;
        setRunning(false);
        void wbApi.digest(true).then(setD).catch(() => {});
      }).catch(() => {});
    }, 15_000);
    return () => clearInterval(t);
  }, [running]);
  const refresh = () => {
    setErr(null);
    if (!d?.sweep?.available) {
      void wbApi.digest(true).then(setD).catch((e) => setErr(String(e?.message ?? e)));
      return;
    }
    void wbApi.runSweep().then((r) => (r.ok ? setRunning(true) : setErr(r.error ?? "Could not start the sweep."))).catch((e) => setErr(String(e?.message ?? e)));
  };
  const s = d?.data;
  const { done, toggle } = useDigestDone(s?.date);
  const openAll = () => {
    remember("wb-tab", "digest");
    location.hash = "#/workbench";
  };
  return (
    <section className="panel home-digest">
      <div className="panel-head">
        <h2>
          Morning digest {s?.items.length ? <em>{s.items.length - s.items.filter((it) => done.has(it.title)).length}</em> : null}
        </h2>
        <span className="home-digest-links">
          <button className="link-btn inline" disabled={running} title={d?.sweep?.available ? "Run the morning sweep now (a few minutes); the digest updates when it is done" : "Read the newest sweep from Slack again"} onClick={refresh}>
            {running ? "Running the sweep…" : "Refresh"}
          </button>
          <button className="link-btn inline" onClick={openAll}>
            Open
          </button>
        </span>
      </div>
      {err && <p className="chat-error">{err}</p>}
      {running && <p className="home-none">The sweep is running as a session (a few minutes). It sends you the Slack DM and this updates when it is done.</p>}
      {!d && <p className="home-none">Reading your morning sweep…</p>}
      {d && !s && <p className="home-none">No morning sweep found in your Slack DM to yourself.</p>}
      {s && s.date < today() && <p className="home-none">Newest sweep is from {dmy(s.date)}.</p>}
      {s?.lead && <p className="home-digest-lead">{s.lead}</p>}
      {s?.items.slice(0, 6).map((it, i) => {
        const link = it.links[0]?.url;
        return (
          <div key={i} className={`home-digest-item ${done.has(it.title) ? "done" : ""}`}>
            <button className="wb-digest-check" aria-pressed={done.has(it.title)} title={done.has(it.title) ? "Mark as not done" : "Mark as done"} onClick={() => toggle(it.title)}>
              {done.has(it.title) ? "✓" : i + 1}
            </button>
            <span className="home-digest-body">
              {link ? (
                <a href={link} target="_blank" rel="noreferrer" className="home-digest-title">
                  {it.title}
                </a>
              ) : (
                <span className="home-digest-title">{it.title}</span>
              )}
              {it.meta && <small>{it.meta}</small>}
            </span>
          </div>
        );
      })}
      {s && s.items.length > 6 && (
        <button className="link-btn inline home-more" onClick={openAll}>
          {s.items.length - 6} more in the digest
        </button>
      )}
    </section>
  );
}

function Digest({ rows, open }: { rows: WbRow[]; open: (url: string) => void }) {
  const [d, setD] = useState<(Cached<WbDigest | null> & { scan: { at: number; hits: number } | null }) | null>(null);
  const [busy, setBusy] = useState(false);
  const load = (refresh: boolean) => {
    setBusy(true);
    return wbApi.digest(refresh).then(setD).catch((e) => setD({ data: null, error: String(e?.message ?? e), fetchedAt: Date.now(), stale: true, scan: null })).finally(() => setBusy(false));
  };
  useEffect(() => {
    void load(false);
  }, []);
  const goLives = useMemo(() => {
    const td = today();
    const lim = new Date(Date.now() + 28 * DAY).toISOString().slice(0, 10);
    const by = new Map<string, { customer: string; date: string; list: WbRow[] }>();
    for (const r of rows) {
      const g = String(r.deal?.golive ?? "").slice(0, 10);
      if (!g || g < td || g > lim) continue;
      const k = r.deal!.url;
      if (!by.has(k)) by.set(k, { customer: r.customer, date: g, list: [] });
      by.get(k)!.list.push(r);
    }
    return [...by.values()].sort((a, b) => a.date.localeCompare(b.date)).map((o) => {
      const days = Math.round((Date.parse(o.date) - Date.parse(td)) / DAY);
      const weeks = Math.max(1, Math.ceil(days / 7));
      const blocked = o.list.filter(held).length;
      const left = o.list.reduce((n, r) => n + (r.steps.length ? r.steps.filter((s) => s.state !== "done").length : 6), 0);
      const why = [blocked && `${blocked} blocked`, o.list.length > weeks && `${o.list.length} open for ${weeks} week${weeks > 1 ? "s" : ""}`, left > 5 * Math.max(0.5, days / 7) && `${left} steps left`].filter(Boolean) as string[];
      return { ...o, days, why };
    });
  }, [rows]);
  const s = d?.data;
  const { done: digestDone, toggle: toggleDigest } = useDigestDone(s?.date);
  return (
    <div className="wb-digest">
      <div className="ba-row">
        <span className="ba-muted">{s ? `Sweep of ${dmy(s.date)} ${s.time}${s.mode ? ` · ${s.mode} mode` : ""}` : busy ? "Reading your morning sweep…" : ""}</span>
        {s?.full && <a href={s.full} target="_blank" rel="noreferrer">Full picture ↗</a>}
        <Freshness state={d} busy={busy} onRefresh={() => void load(true)} />
      </div>
      {d?.error && <div className="chat-error">{d.error}</div>}
      {s?.date && s.date < today() && <div className="ba-card">Not from today: the newest sweep in your Slack DM is from {dmy(s.date)}.</div>}
      {d && !s && !d.error && <div className="ba-card ba-muted">No morning sweep found in your Slack DM to yourself.</div>}
      {s?.lead && <p>{s.lead}</p>}
      {s?.items.map((it, i) => (
        <div key={i} className={`ba-card wb-item ${digestDone.has(it.title) ? "done" : ""}`}>
          <strong>
            <button className="wb-digest-check" aria-pressed={digestDone.has(it.title)} title={digestDone.has(it.title) ? "Mark as not done" : "Mark as done"} onClick={() => toggleDigest(it.title)}>
              {digestDone.has(it.title) ? "✓" : i + 1}
            </button>{" "}
            {it.title} {it.meta && <span className="ba-chip">{it.meta}</span>}
          </strong>
          {it.text && <span>{it.text}</span>}
          {it.quote && (
            <blockquote>
              <small>{it.who} wrote</small>
              {it.quote}
            </blockquote>
          )}
          <div className="ba-row">
            {it.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noreferrer" className={/frontapp/.test(l.url) ? "front-btn" : undefined}>
                {/frontapp/.test(l.url) ? "Open in Front" : /notion/.test(l.url) ? "Open in Notion" : /slack\.com/.test(l.url) ? "Open in Slack" : l.label || "Open"} ↗
              </a>
            ))}
            {it.ticketUrl && (
              <button className="icon-btn ghost" onClick={() => open(it.ticketUrl!)}>
                Open ticket
              </button>
            )}
          </div>
        </div>
      ))}
      {!!s?.notes.length && <div className="ba-card">{s.notes.map((n, i) => <span key={i}>{n}</span>)}</div>}
      <h3>Go-lives in the next 4 weeks</h3>
      {goLives.length === 0 && <div className="ba-card ba-muted">No go-live in the next 4 weeks on the deals of your open tickets.</div>}
      {goLives.length > 0 && (
        <table className="ba-table">
          <thead>
            <tr><th>Customer</th><th>Go-live</th><th>Open tickets</th><th>Pace</th></tr>
          </thead>
          <tbody>
            {goLives.map((g) => (
              <tr key={g.customer + g.date}>
                <td><strong>{g.customer}</strong></td>
                <td>{dmy(g.date)} <span className="ba-muted">{g.days === 0 ? "today" : `in ${g.days} d`}</span></td>
                <td>{g.list.map((r) => <button key={r.url} className="wb-linkbtn" onClick={() => open(r.url)}>{r.task}</button>)}</td>
                <td><span className={`wb-tag ${g.why.length ? "warn" : "good"}`}>{g.why.length ? "Needs to go faster" : "On track"}</span> <span className="ba-muted">{g.why.join(" · ")}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

export default function WorkbenchView({ onOpen }: { onOpen: (key: string) => void }) {
  const [state, setState] = useState<Rows | null>(null);
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState<Tab>(() => {
    const t = remember("wb-tab");
    return t === "digest" ? "digest" : "tickets";
  });
  const [kinds, setKinds] = useState<WbTab[]>(() => {
    const v = remember("wb-kinds");
    if (v === null || v === undefined) return KINDS.map(([k]) => k);
    return v.split(",").filter((k): k is WbTab => KINDS.some(([x]) => x === k));
  });
  const [menu, setMenu] = useState<{ url: string; x: number; y: number } | null>(null);
  const [fmenu, setFmenu] = useState<{ url: string; x: number; y: number; ask?: WbRow["frontAsk"] } | null>(null);
  useEffect(() => {
    const open = (e: Event) => {
      const d = (e as CustomEvent<{ url: string; x: number; y: number }>).detail;
      setMenu(null);
      setFmenu({ ...d, ask: rowsRef.current.find((x) => x.url === d.url)?.frontAsk ?? null });
    };
    window.addEventListener("wb-front-menu", open);
    return () => window.removeEventListener("wb-front-menu", open);
  }, []);
  const [stage, setStage] = useState<WbStage>((remember("wb-stage") as WbStage) || "current");
  const [q, setQ] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = (refresh: boolean) => wbApi.rows(refresh).then(setState).catch((e) => setState((s) => ({ data: s?.data ?? null, error: String(e?.message ?? e), fetchedAt: Date.now(), stale: true, mode: s?.mode ?? "step" })));
  const refresh = () => {
    setBusy(true);
    void load(true).finally(() => setBusy(false));
  };
  useEffect(() => {
    setBusy(true);
    void load(false).finally(() => setBusy(false));
    // The list is read from the daemon's cache, so a short poll keeps running tickets current.
    const t = setInterval(() => void load(false), 4000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const key = (e: KeyboardEvent) => e.key === "Escape" && close();
    window.addEventListener("keydown", key);
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("keydown", key);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  const act = (p: Promise<unknown>) => void p.then(() => load(false)).catch((e) => setError(String(e?.message ?? e)));
  const run = (r: WbRow, kind: Parameters<typeof wbApi.run>[1], show = false, order?: number) =>
    void wbApi
      .run(r.url, kind, order)
      .then((x) => {
        setError(null);
        if (show && x.key) onOpen(x.key);
        return load(false);
      })
      .catch((e) => setError(String(e?.message ?? e)));

  const rows = state?.data ?? [];
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const counts = { scoping: 0, tasks: 0, cr: 0 } as Record<WbTab, number>;
  for (const r of rows) counts[r.tab]++;
  const inTab = rows.filter((r) => kinds.includes(r.tab));
  const needle = q.trim().toLowerCase();
  const shown = sortRows(inTab.filter((r) => (needle ? `${r.task} ${r.customer} ${r.status} ${r.reqKey} ${r.reqTask}`.toLowerCase().includes(needle) : stageOf(r) === stage)));
  const pickTab = (v: Tab) => {
    setTab(v);
    remember("wb-tab", v);
  };
  const saveKinds = (v: WbTab[]) => {
    setKinds(v);
    remember("wb-kinds", v.join(","));
  };
  const toggleKind = (k: WbTab) => saveKinds(kinds.includes(k) ? kinds.filter((x) => x !== k) : [...kinds, k]);
  const pickStage = (v: WbStage) => {
    setStage(v);
    remember("wb-stage", v);
  };
  const openTicket = (url: string) => {
    const r = rows.find((x) => x.url === url);
    if (!r) return;
    if (!kinds.includes(r.tab)) saveKinds([...kinds, r.tab]);
    pickTab("tickets");
    pickStage(stageOf(r));
    setOpen(url);
  };

  return (
    <div className="page ba-inbox wb">
      <QargoMcpBanner />
      <div className="ba-panel-head">
        <h2>Workbench</h2>
        <span className="ba-muted">
          {rows.length} tickets assigned to {state?.viewAs ? state.viewAs.name : "you"} · {rows.filter((r) => r.running || r.session?.status === "thinking").length} running
        </span>
        <ViewAs current={state?.viewAs ?? null} onChange={() => void load(false)} />
        <label className="wb-mode" title="Auto: Claude's own writes are decided by Claude Code's auto mode. Step by step: every write asks you in the chat.">
          <select value={state?.mode ?? "step"} onChange={(e) => act(wbApi.mode(e.target.value as "auto" | "step"))}>
            <option value="step">Step by step</option>
            <option value="auto">Auto</option>
          </select>
        </label>
        <Freshness state={state} busy={busy} onRefresh={refresh} />
      </div>
      {(error || state?.error) && <div className="chat-error">{error || state?.error}</div>}

      <div className="wb-tabs" role="tablist">
        {TABS.map(([k, label]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? "on" : ""} onClick={() => pickTab(k)}>
            {label} {k === "tickets" && <span className="ba-muted">{rows.length}</span>}
          </button>
        ))}
      </div>

      {tab === "digest" ? (
        <Digest rows={rows} open={openTicket} />
      ) : (
        <>
          <div className="wb-kinds" role="group" aria-label="Kinds of ticket">
            {KINDS.map(([k, label]) => (
              <button key={k} aria-pressed={kinds.includes(k)} className={kinds.includes(k) ? "on" : ""} onClick={() => toggleKind(k)}>
                {label} <span className="wb-kinds-n">{counts[k]}</span>
              </button>
            ))}
          </div>
          <div className="ba-row">
            <div className="wb-tabs sub" role="tablist">
              {STAGES.map(([k, label]) => (
                <button key={k} role="tab" aria-selected={!needle && stage === k} className={!needle && stage === k ? "on" : ""} onClick={() => pickStage(k)}>
                  {label} <span className="ba-muted">{inTab.filter((r) => stageOf(r) === k).length}</span>
                </button>
              ))}
            </div>
            <input className="drawings-search" type="search" placeholder="Search request, customer, status" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
          {state && kinds.length === 0 && <div className="ba-card ba-muted">Pick at least one kind above.</div>}
          {state && kinds.length > 0 && shown.length === 0 && <div className="ba-card ba-muted">{rows.length ? "Nothing here. Look in the other stage tabs." : state.error ? "Your tickets could not be read." : "Nothing assigned to you in Bugs and Feature development."}</div>}
          {!state && <div className="ba-card ba-muted">Loading your tickets…</div>}
          {shown.length > 0 && (
            <table className="ba-table wb-table">
              <thead>
                <tr><th aria-label="Pinned" /><th>Request</th><th>Status</th><th>State</th><th>Next step</th><th>Commit date</th><th>Go-live date</th><th>Last contact</th><th>Action</th></tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const b = blockerOf(r);
                  const nx = nextStep(r.steps);
                  const done = r.steps.filter((s) => s.state === "done").length;
                  const working = r.running || r.session?.status === "thinking" || !!r.qai;
                  const hold = b.k === "you" || b.k === "others" || b.k === "done";
                  return (
                    <Fragment key={r.url}>
                      <tr className={`wb-click ${working ? "wb-busy" : ""} ${open === r.url ? "wb-open" : ""}`} onClick={(e) => { if (!(e.target as HTMLElement).closest("button, a, select, input")) setOpen(open === r.url ? null : r.url); }} onContextMenu={(e) => { e.preventDefault(); setMenu({ url: r.url, x: e.clientX, y: e.clientY }); }}>
                        <td>
                          <button className={`wb-pin ${r.pinned ? "on" : ""}`} aria-pressed={r.pinned} aria-label={r.pinned ? "Unpin" : "Pin to the top"} onClick={() => act(wbApi.pin(r.url, !r.pinned))}>
                            {r.pinned ? "★" : "☆"}
                          </button>
                        </td>
                        <td>
                          <button className="wb-linkbtn wb-req" title={r.task} aria-expanded={open === r.url} onClick={() => setOpen(open === r.url ? null : r.url)}>
                            {r.task || "(no name)"}
                          </button>
                        </td>
                        <td>
                          <select className="wb-select" value={r.status} aria-label="Status in Notion" title="Change the status in Notion" onChange={(e) => act(wbApi.status(r.url, e.target.value))}>
                            {!WB_STATUS_OPTS.some(([, l]) => l.includes(r.status)) && <option value={r.status}>{r.status || "Set status"}</option>}
                            {WB_STATUS_OPTS.map(([g, l]) => (
                              <optgroup key={g} label={g}>
                                {l.map((v) => <option key={v}>{v}</option>)}
                              </optgroup>
                            ))}
                          </select>
                        </td>
                        <td>
                          {r.qai ? (
                            <a className="wb-tag wb-qai" href={r.qai.link ?? undefined} target="_blank" rel="noreferrer" title="The chat asked Qai and picks up its answer by itself (checked every minute). Click to read the question in Slack.">
                              Waiting on Qai
                            </a>
                          ) : (
                            <span className={`wb-tag ${b.tone}`} title="Right-click to set the state">{b.tag}</span>
                          )}
                          {r.steps.length > 0 && <div className="ba-muted">{done}/{r.steps.length} steps</div>}
                        </td>
                        <td title={b.label}>
                          {b.k === "done" ? "" : r.next ? <><strong>{r.next.who === "you" ? "You" : "Claude"}</strong> {r.next.label}</> : nx ? <><strong>{nx.kind === "manual" ? "You" : "Claude"}</strong> {nx.name}</> : <span className="ba-muted">{b.label}</span>}
                        </td>
                        <DateCell iso={r.committed} col="commit" r={r} />
                        <DateCell iso={r.deal?.golive ?? ""} col="golive" r={r} />
                        <ContactCell r={r} onMenu={(e, ask) => { setMenu(null); setFmenu({ url: r.url, x: e.clientX, y: e.clientY, ask: ask ? r.frontAsk ?? null : null }); }} />
                        <td className="wb-actions">
                          {working ? (
                            <button className="icon-btn ghost" aria-label="Stop" title="Stop Claude on this ticket" onClick={() => run(r, "stop")}>■</button>
                          ) : (
                            <button className="icon-btn" aria-label="Start" disabled={hold || (r.tab === "scoping" && !r.request)} title={hold ? "Waits on you or someone else. Open the chat." : r.tab === "scoping" ? "Run the scoping" : r.steps.length ? "Run the steps until one needs you" : "Claude proposes the setup steps for you to approve"} onClick={() => run(r, r.tab === "scoping" ? "scope" : "start", r.tab !== "scoping" && !r.steps.length)}>▶</button>
                          )}
                          <button className="icon-btn ghost" title="Chat with Claude about this ticket" onClick={() => run(r, "chat", true)}>Chat</button>
                        </td>
                      </tr>
                      {open === r.url && (
                        <tr className="wb-detail-row">
                          <td colSpan={9}>
                            <Detail r={r} act={act} run={(kind, show, order) => run(r, kind, show, order)} />
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </>
      )}
      {fmenu && <FrontMenu key={fmenu.url} menu={fmenu} linked={rows.find((x) => x.url === fmenu.url)?.frontLinked ?? []} onClose={() => setFmenu(null)} onSaved={(close = true) => { if (close) setFmenu(null); act(Promise.resolve()); }} />}
      {menu && <StateMenu menu={menu} cur={(() => { const r = rows.find((x) => x.url === menu.url); return r?.state && !r.state.auto ? r.state.k : ""; })()} onClose={() => setMenu(null)} onPick={(v) => { act(wbApi.state(menu.url, v || null)); setMenu(null); }} />}
    </div>
  );
}

/** Right-click on Last contact: search the customer's newest Front conversations and tie one to the ticket. */
type FrontCand = WbFrontCand;
/**
 * The Front threads on a ticket, and newer ones to add: one list of checkboxes, the
 * threads on the ticket first (ticked), then the background search's suggestions or a
 * fresh search. Save applies every tick and untick at once. A link or id can be pasted.
 */
function FrontMenu({ menu, linked, onClose, onSaved }: { menu: { url: string; x: number; y: number; ask?: WbRow["frontAsk"] }; linked: WbLinkedThread[]; onClose: () => void; onSaved: (close?: boolean) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const asked = !!menu.ask?.threads.length;
  const [res, setRes] = useState<{ threads: FrontCand[]; query: string } | null>(asked ? { threads: menu.ask!.threads, query: menu.ask!.query } : null);
  const [busy, setBusy] = useState<"search" | "save" | "add" | "dismiss" | null>(null);
  // Showing the background search's suggestions (until a fresh search replaces them).
  const [fromAsk, setFromAsk] = useState(asked);
  const searching = useRef(false);
  searching.current = busy === "search";
  const [err, setErr] = useState<string | null>(null);
  const [paste, setPaste] = useState("");
  // A search runs on its own; only saving, adding or dismissing locks the list.
  const locked = !!busy && busy !== "search";
  const onIds = linked.map((x) => x.id).join(",");
  const [ticked, setTicked] = useState<Set<string>>(() => new Set(linked.map((x) => x.id)));
  // A thread added by hand shows up in `linked` after the reload: tick it too.
  useEffect(() => setTicked((cur) => new Set([...cur, ...linked.map((x) => x.id)])), [onIds]);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)), y: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)) });
  }, [menu.x, menu.y, res, busy, onIds]);
  useEffect(() => {
    const down = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && !searching.current && onClose();
    const key = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [onClose]);
  const search = () => {
    setBusy("search");
    setErr(null);
    wbApi
      .frontSearch(menu.url)
      .then((r) => (r.error ? setErr(r.error) : (setRes(r), setFromAsk(false))))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(null));
  };
  // Without suggestions, look in Front straight away (a direct read takes a second or two).
  useEffect(() => {
    if (!asked) search();
  }, []);
  const onSet = new Set(linked.map((x) => x.id));
  const cands = (res?.threads ?? []).filter((t) => !onSet.has(t.id));
  // About this ticket first; the rest of the customer's mail below, for when the subject says nothing.
  const about = cands.filter((t) => (t.score ?? 2) >= 2 && !t.other);
  const rest = cands.filter((t) => !about.includes(t));
  const [showRest, setShowRest] = useState(false);
  const toAdd = cands.filter((t) => ticked.has(t.id));
  const toRemove = linked.filter((t) => !ticked.has(t.id));
  const changes = toAdd.length + toRemove.length;
  const flip = (id: string) => setTicked((cur) => { const n = new Set(cur); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const save = () => {
    setBusy("save");
    setErr(null);
    wbApi
      .frontSet(menu.url, toAdd.map(({ linked: _l, ...t }) => t), toRemove.map((t) => t.id))
      .then((r) => (r.ok ? onSaved() : setErr(r.error ?? "Could not save the threads.")))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(null));
  };
  const add = () => {
    if (!paste.trim()) return;
    setBusy("add");
    setErr(null);
    wbApi
      .frontAdd(menu.url, paste.trim())
      .then((r) => (r.ok ? (setPaste(""), onSaved(false)) : setErr(r.error ?? "Could not add that thread.")))
      .catch((e) => setErr(String(e?.message ?? e)))
      .finally(() => setBusy(null));
  };
  const row = (id: string, link: string, at: number | null, subject: string, extra?: React.ReactNode) => (
    <label key={id} className="wb-fmenu-row">
      <input type="checkbox" checked={ticked.has(id)} disabled={locked} onChange={() => flip(id)} />
      <span className="wb-fmenu-main">
        <span className="wb-fmenu-date">{at ? `${localDay(at)} · ${sinceLabel(at).toLowerCase()}` : "not read yet"}</span>
        <span className="wb-fmenu-subj">{subject || "(no subject)"}</span>
        {extra}
      </span>
      <a href={link} target="_blank" rel="noreferrer" title="Open in Front" onClick={(e) => e.stopPropagation()}>↗</a>
    </label>
  );
  return (
    <div className="wb-ctx wb-fmenu" ref={ref} role="dialog" aria-label="Front threads on this ticket" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      <div className="wb-fmenu-sec">On this ticket ({linked.length})</div>
      {linked.length === 0 && <div className="wb-fmenu-empty ba-muted">No Front thread yet.</div>}
      {linked.map((t) => row(t.id, t.link, t.at, t.subject, t.fromNotion ? <span className="ba-muted"> · Front Link in Notion</span> : null))}
      <div className="wb-fmenu-sec">
        {fromAsk ? "Newer threads found in the background" : res ? <>Newest in Front for “{res.query}”</> : "Front"}
      </div>
      {busy === "search" && <div className="wb-fmenu-empty ba-muted">Searching Front…</div>}
      {!res && busy !== "search" && <div className="wb-fmenu-empty ba-muted">The suggestions are put away. Search Front to look again.</div>}
      {res && busy !== "search" && cands.length === 0 && <div className="wb-fmenu-empty ba-muted">{res.threads.length ? "Every thread found is on the ticket already." : "Nothing in Front for this customer in the last year."}</div>}
      {busy !== "search" && about.map((t) => row(t.id, t.link, t.updatedAt, t.subject, t.why?.length ? <span className="wb-fmenu-why">names {t.why.join(", ")}</span> : null))}
      {busy !== "search" && res && about.length === 0 && rest.length > 0 && <div className="wb-fmenu-empty ba-muted">No thread names this ticket.</div>}
      {busy !== "search" && rest.length > 0 && (
        <>
          <button className="wb-fmenu-more" onClick={() => setShowRest((x) => !x)}>
            {showRest ? "▾" : "▸"} Other mail with this customer ({rest.length})
          </button>
          {showRest && rest.map((t) => row(t.id, t.link, t.updatedAt, t.subject, t.other ? <span className="ba-muted"> · looks like “{t.other}”</span> : null))}
        </>
      )}
      <form className="wb-fmenu-add" onSubmit={(e) => { e.preventDefault(); add(); }}>
        <input value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="Paste a Front link or a cnv_ / msg_ id" disabled={locked} />
        <button className="icon-btn ghost" type="submit" disabled={locked || !paste.trim()}>{busy === "add" ? "Adding…" : "Add"}</button>
      </form>
      <div className="wb-fmenu-foot">
        <button className="icon-btn primary" disabled={locked || !changes} onClick={save}>
          {busy === "save" ? "Saving…" : changes ? `Save (${[toAdd.length && `+${toAdd.length}`, toRemove.length && `−${toRemove.length}`].filter(Boolean).join(" ")})` : "Save"}
        </button>
        {fromAsk && cands.length > 0 && (
          <button className="icon-btn ghost" disabled={!!busy} title="None of the newer threads belong to the ticket: they won't be suggested again" onClick={() => { setBusy("dismiss"); void wbApi.frontDismiss(menu.url).then(() => { setRes(null); setFromAsk(false); onSaved(false); }).catch((e) => setErr(String(e?.message ?? e))).finally(() => setBusy(null)); }}>
            None of these
          </button>
        )}
        <button className="icon-btn ghost" disabled={!!busy} onClick={search}>{res && !fromAsk ? "Search again" : "Search Front"}</button>
      </div>
      {err && <div className="chat-error">{err}</div>}
    </div>
  );
}

function StateMenu({ menu, cur, onClose, onPick }: { menu: { x: number; y: number }; cur: string; onClose: () => void; onPick: (v: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setPos({ x: Math.max(4, Math.min(menu.x, window.innerWidth - width - 4)), y: Math.max(4, Math.min(menu.y, window.innerHeight - height - 4)) });
  }, [menu.x, menu.y]);
  useEffect(() => {
    const down = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) onClose();
    };
    document.addEventListener("mousedown", down);
    return () => document.removeEventListener("mousedown", down);
  }, [onClose]);
  const items: [string, string][] = [["", "Automatic"], ...Object.entries(WB_AWAIT)];
  return (
    <div className="wb-ctx" ref={ref} role="menu" style={{ left: pos.x, top: pos.y }} onContextMenu={(e) => e.preventDefault()}>
      {items.map(([k, l]) => (
        <button key={k} role="menuitemradio" aria-checked={cur === k} onClick={() => onPick(k)}>
          <span className="wb-ctx-ck">{cur === k ? "✓" : ""}</span>
          {l}
        </button>
      ))}
    </div>
  );
}
