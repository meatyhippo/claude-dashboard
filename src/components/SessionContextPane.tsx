import { useEffect, useMemo, useRef, useState } from "react";
import type { BaCustomer, BaRequirement, BaTicket } from "../../shared/baCustomers.ts";
import { agentApi, baApi, type TimelineItem } from "../api.ts";
import { Reader } from "./InboxView.tsx";
import { Markdown } from "./Markdown.tsx";
import { fileTab, Workbench } from "./workbench/Workbench.tsx";
import { StatusPill } from "./StatusPill.tsx";

/**
 * BA edition: what a session works on, beside its chat. The mail (with a reply
 * the session drafts from its own investigation), the integration request in
 * Notion (reloaded when the session writes to it, with what changed marked), and
 * the customer's folder (files the session touched marked). Only the tabs a
 * session has are shown.
 */

type Ctx = Awaited<ReturnType<typeof baApi.sessionContext>>;
type Tab = "mail" | "ticket" | "changes" | "files";

/** Where the pane sits next to the chat: remembered per viewer, shared by every session. */
export type ScxPos = "right" | "left" | "top";
const POS_KEY = "ba-scx-pos";
const readPos = (): ScxPos => {
  try {
    const v = localStorage.getItem(POS_KEY);
    return v === "left" || v === "top" || v === "right" ? v : "right";
  } catch {
    return "right";
  }
};
export function useScxPos(): [ScxPos, (p: ScxPos) => void] {
  const [pos, setPos] = useState<ScxPos>(readPos);
  useEffect(() => {
    const on = () => setPos(readPos());
    window.addEventListener("ba-scx-pos", on);
    return () => window.removeEventListener("ba-scx-pos", on);
  }, []);
  return [
    pos,
    (p) => {
      try {
        localStorage.setItem(POS_KEY, p);
      } catch {
        /* not remembered: still applies until reload */
      }
      window.dispatchEvent(new Event("ba-scx-pos"));
    },
  ];
}

const PosIcon = ({ p }: { p: ScxPos }) => (
  <svg width="16" height="12" viewBox="0 0 16 12" fill="none" stroke="currentColor" strokeWidth="1.3" aria-hidden>
    <rect x="0.65" y="0.65" width="14.7" height="10.7" rx="1.5" />
    {p === "left" && <rect x="1.5" y="1.5" width="5" height="9" fill="currentColor" stroke="none" />}
    {p === "right" && <rect x="9.5" y="1.5" width="5" height="9" fill="currentColor" stroke="none" />}
    {p === "top" && <rect x="1.5" y="1.5" width="13" height="4" fill="currentColor" stroke="none" />}
  </svg>
);

const DRAFT = /<draft>([\s\S]*?)<\/draft>/i;
const NOTION_WRITE = /notion-(update-page|create-pages|update-data-source)|notion__(update|create)/i;
const FILE_WRITE = /^(Write|Edit|MultiEdit|NotebookEdit)$/;

/** Paragraph blocks of a ticket, for marking what a reload changed. */
const blocksOf = (md: string) =>
  md
    .replace(/<[^>]+>/g, "")
    .split(/\n{2,}/)
    .map((b) => b.trim())
    .filter(Boolean);

export default function SessionContextPane({ agentKey, sessionId, cwd, wide }: { agentKey?: string | null; sessionId: string; cwd?: string | null; wide?: boolean }) {
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const [tab, setTab] = useState<Tab | null>(null);
  const [open, setOpen] = useState(!!wide);
  const [customers, setCustomers] = useState<BaCustomer[]>([]);
  const [timeline, setTimeline] = useState<TimelineItem[]>([]);
  const [asking, setAsking] = useState<number | null>(null);
  const [draft, setDraft] = useState<{ text: string; at: number } | null>(null);
  const [ticket, setTicket] = useState<BaTicket | null>(null);
  const [ticketErr, setTicketErr] = useState<string | null>(null);
  const [changed, setChanged] = useState<Set<string>>(new Set());
  const [ticketAt, setTicketAt] = useState<number | null>(null);
  const firstBlocks = useRef<Set<string> | null>(null);
  const [wbTab, setWbTab] = useState("session");
  const [pos, setPos] = useScxPos();
  const [reqs, setReqs] = useState<BaRequirement[] | null>(null);

  useEffect(() => {
    void baApi
      .sessionContext(sessionId, agentKey, cwd)
      .then((c) => {
        setCtx(c);
        setTab((t) => t ?? (c.thread ? "mail" : c.irUrl ? "ticket" : c.folder ? "files" : null));
      })
      .catch(() => {});
    void baApi.customers().then((r) => setCustomers(r.customers)).catch(() => {});
  }, [sessionId, agentKey, cwd]);

  // The customer's change requests: the ones this session or its mail mention come first.
  useEffect(() => {
    if (ctx?.projectId == null) return;
    void baApi
      .requirements(ctx.projectId)
      .then((r) => setReqs((r.data ?? []).filter((t) => t.type === "Change request")))
      .catch(() => setReqs([]));
  }, [ctx?.projectId]);

  // The live session's timeline: drafts it writes, Notion writes and files it touches.
  useEffect(() => {
    if (!agentKey || !ctx) return;
    let alive = true;
    const load = () =>
      agentApi
        .get(agentKey)
        .then((d) => alive && setTimeline(d.timeline))
        .catch(() => {});
    load();
    const t = setInterval(load, asking ? 2500 : 6000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [agentKey, ctx, asking]);

  // A reply the session wrote after we asked for one goes into the composer.
  useEffect(() => {
    if (asking === null) return;
    const found = [...timeline].reverse().find((i) => i.kind === "assistant" && i.ts >= asking && DRAFT.test(i.text));
    if (found && found.kind === "assistant") {
      setDraft({ text: found.text.match(DRAFT)![1]!.trim(), at: found.ts });
      setAsking(null);
    }
  }, [timeline, asking]);

  const loadTicket = (refresh: boolean) => {
    if (!ctx?.irUrl) return;
    void baApi
      .ticket(ctx.irUrl, refresh)
      .then((r) => {
        if (!r.data) return setTicketErr(r.error ?? "Could not read the ticket.");
        setTicketErr(null);
        const blocks = blocksOf(r.data.markdown);
        if (!firstBlocks.current) firstBlocks.current = new Set(blocks);
        else setChanged(new Set(blocks.filter((b) => !firstBlocks.current!.has(b))));
        setTicket(r.data);
        setTicketAt(Date.now());
      })
      .catch((e) => setTicketErr(String(e?.message ?? e)));
  };
  useEffect(() => {
    if (ctx?.irUrl) loadTicket(false);
  }, [ctx?.irUrl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reload the ticket each time the session finishes a write to Notion.
  const notionWrites = timeline.filter((i) => i.kind === "tool" && NOTION_WRITE.test(i.name) && i.result !== undefined).length;
  useEffect(() => {
    if (notionWrites > 0) loadTicket(true);
  }, [notionWrites]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Files this session wrote or edited, relative to the customer folder, with their edits. */
  const touched = useMemo(() => {
    const out = new Map<string, { kind: string; edits: { old: string; new: string }[] }>();
    const root = ctx?.folder ? `${ctx.folder.replace(/\/$/, "")}/` : null;
    for (const i of timeline) {
      if (i.kind !== "tool" || !FILE_WRITE.test(i.name)) continue;
      const input = (i.input ?? {}) as { file_path?: string; notebook_path?: string; old_string?: string; new_string?: string; edits?: { old_string: string; new_string: string }[] };
      const abs = input.file_path ?? input.notebook_path;
      if (!abs || !root || !abs.startsWith(root)) continue;
      const rel = abs.slice(root.length);
      const cur = out.get(rel) ?? { kind: i.name === "Write" ? "A" : "M", edits: [] };
      if (input.old_string !== undefined) cur.edits.push({ old: input.old_string, new: input.new_string ?? "" });
      for (const e of input.edits ?? []) cur.edits.push({ old: e.old_string, new: e.new_string });
      out.set(rel, cur);
    }
    return out;
  }, [timeline, ctx?.folder]);

  /** Change requests, linked ones first: named in the session, on its mail thread, or the session's own ticket. */
  const changes = useMemo(() => {
    if (!reqs) return [];
    const said = JSON.stringify(timeline).replace(/-/g, "");
    const idOf = (url: string) => url.replace(/-/g, "").match(/[0-9a-f]{32}/i)?.[0]?.toLowerCase() ?? url;
    const irId = ctx?.irUrl ? idOf(ctx.irUrl) : null;
    return reqs
      .map((t) => {
        const id = idOf(t.url);
        const why =
          id === irId ? "this session's ticket" : ctx?.thread && t.frontLink?.includes(ctx.thread.id) ? "on this mail" : said.toLowerCase().includes(id) ? "named in this session" : null;
        return { t, why, open: !/done|live|closed|won.?t|duplicate|cancel/i.test(t.status ?? "") };
      })
      .filter((x) => x.why || x.open)
      .sort((a, b) => Number(!!b.why) - Number(!!a.why) || Number(b.open) - Number(a.open));
  }, [reqs, timeline, ctx?.irUrl, ctx?.thread]);
  const linkedChanges = changes.filter((c) => c.why).length;

  if (!ctx || !tab) return null;
  const side = pos !== "top";
  const isOpen = open || side;
  const tabs: { key: Tab; label: string; count?: string }[] = [
    ...(ctx.thread ? [{ key: "mail" as const, label: "Mail" }] : []),
    ...(ctx.irUrl ? [{ key: "ticket" as const, label: "Ticket", count: changed.size ? `${changed.size} changed` : undefined }] : []),
    ...(ctx.projectId != null && reqs ? [{ key: "changes" as const, label: "Change requests", count: linkedChanges ? `${linkedChanges} linked` : changes.length ? String(changes.length) : undefined }] : []),
    ...(ctx.folder ? [{ key: "files" as const, label: "Files", count: touched.size ? `${touched.size} touched` : undefined }] : []),
  ];

  const ask = async (instructions: string) => {
    if (!agentKey || !ctx.thread) return;
    setAsking(Date.now());
    // Your own instructions for how mails read go with the request, as they do for Claude's quick drafts.
    const style = await baApi.mailStyle().then((r) => r.block).catch(() => "");
    void agentApi
      .message(
        agentKey,
        `Write the reply to the Front conversation "${ctx.thread.subject}" (${ctx.thread.link}), based on what you found in this session. ` +
          `Write it in the language of the conversation, as me, ready to send. ${instructions.trim() ? `Also: ${instructions.trim()}. ` : ""}` +
          `Put only the email text between <draft> and </draft>. Don't save or send it: it goes into the reply box beside this chat, where I'll edit and send it.` +
          style,
      )
      .catch(() => setAsking(null));
  };

  return (
    <aside className={`scx ${wide ? "wide" : "narrow"} ${isOpen ? "open" : ""} pos-${pos}`} aria-label="What this session works on">
      <div className="scx-tabs" role="tablist">
        {!wide && !side && (
          <button className="scx-fold" onClick={() => setOpen(!open)} aria-expanded={open} title={open ? "Fold" : "Show beside the chat"}>
            {open ? "▾" : "▸"}
          </button>
        )}
        {tabs.map((t) => (
          <button
            key={t.key}
            role="tab"
            aria-selected={tab === t.key}
            className={tab === t.key ? "on" : ""}
            onClick={() => {
              setTab(t.key);
              setOpen(true);
            }}
          >
            {t.label}
            {t.count && <span className="scx-count">{t.count}</span>}
          </button>
        ))}
        <span className="scx-who">{ctx.customer ?? ""}</span>
        <span className="scx-pos" role="group" aria-label="Where this pane sits">
          {(["left", "top", "right"] as const).map((p) => (
            <button key={p} className={pos === p ? "on" : ""} aria-pressed={pos === p} title={p === "top" ? "Above the chat" : `To the ${p} of the chat`} onClick={() => setPos(p)}>
              <PosIcon p={p} />
            </button>
          ))}
        </span>
      </div>

      {isOpen && tab === "mail" && ctx.thread && (
        <div className="scx-body scx-mail">
          <Reader
            t={ctx.thread}
            customers={customers}
            onPlaced={(th, pid, ir) => (pid === null ? baApi.untriage(th.id).then(() => ({})) : baApi.triage(th, pid, ir, "manual"))}
            onOpen={(key) => void (window.location.hash = `#/session/${encodeURIComponent(key)}`)}
            session={agentKey ? { ask: (i) => void ask(i), asking: asking !== null, draft } : undefined}
          />
        </div>
      )}

      {isOpen && tab === "ticket" && ctx.irUrl && (
        <div className="scx-body scx-ticket">
          <div className="scx-ticket-head">
            <strong>{ticket?.title ?? ctx.irTitle ?? "Integration request"}</strong>
            {agentKey && <span className="scx-live">● live{ticketAt ? ` · read ${new Date(ticketAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}` : ""}</span>}
            <button className="icon-btn ghost" onClick={() => loadTicket(true)}>
              Reload
            </button>
            <a className="icon-btn ghost" href={ctx.irUrl} target="_blank" rel="noreferrer">
              Notion ↗
            </a>
          </div>
          {ticketErr && <div className="chat-error">{ticketErr}</div>}
          {!ticket && !ticketErr && <p className="ba-muted">Reading the ticket…</p>}
          {ticket &&
            blocksOf(ticket.markdown).map((b, i) => (
              <div key={i} className={`scx-block ${changed.has(b) ? "changed" : ""}`}>
                <Markdown text={b} />
              </div>
            ))}
          {changed.size > 0 && <p className="ba-muted scx-foot">Marked: changed since this pane opened.</p>}
        </div>
      )}

      {isOpen && tab === "changes" && (
        <div className="scx-body scx-changes">
          {changes.length === 0 && <p className="ba-muted">No open change requests at {ctx.customer ?? "this customer"}.</p>}
          {changes.map(({ t, why }) => (
            <div key={t.url} className={`scx-cr ${why ? "linked" : ""}`}>
              <div className="scx-cr-main">
                <a href={t.url} target="_blank" rel="noreferrer">
                  {t.title}
                </a>
                <span className="scx-cr-meta">
                  <StatusPill status={t.status ?? "No status"} />
                  {t.billableStatus && <StatusPill status={t.billableStatus} billable />}
                  {t.billableAmount ? <span className="ba-muted">{t.billableAmount.toLocaleString()}</span> : null}
                  {why && <span className="ba-chip">{why}</span>}
                </span>
              </div>
              {agentKey && !why && (
                <button className="icon-btn ghost" title="Tell the session this work belongs to this change request" onClick={() => void agentApi.message(agentKey, `This work belongs to the change request "${t.title}" (${t.url}). Read it and keep it in mind; update it in Notion only when I ask.`)}>
                  Link
                </button>
              )}
            </div>
          ))}
          {agentKey && (
            <button
              className="icon-btn"
              onClick={() =>
                void agentApi.message(agentKey, `Based on what we found in this session, prepare a change request for ${ctx.customer ?? "this customer"} with the create-change-request skill${ctx.thread ? `, linked to the Front conversation ${ctx.thread.link}` : ""}. Show me the draft before you create it in Notion.`)
              }
            >
              New change request from this session
            </button>
          )}
        </div>
      )}

      {isOpen && tab === "files" && ctx.folder && (
        <div className="scx-body scx-files">
          <Workbench
            workspaceId={-(500000 + (ctx.projectId ?? 0))}
            cwd={ctx.folder}
            views={[
              {
                key: "session",
                label: "This session",
                count: touched.size || undefined,
                render: () => (
                  <div className="scx-touched">
                    {touched.size === 0 && <p className="ba-muted">This session hasn't written to the customer folder yet. Pick a file on the left to open it.</p>}
                    {[...touched].map(([rel, t]) => (
                      <div key={rel} className="scx-file">
                        <button className="scx-file-name" onClick={() => setWbTab(fileTab(rel))}>
                          <span className={`scx-mark ${t.kind}`}>{t.kind === "A" ? "new" : "edited"}</span> {rel}
                        </button>
                        {t.edits.slice(-3).map((e, i) => (
                          <pre key={i} className="scx-edit">
                            {e.old && <span className="del">{e.old}</span>}
                            {e.new && <span className="add">{e.new}</span>}
                          </pre>
                        ))}
                      </div>
                    ))}
                  </div>
                ),
              },
            ]}
            active={wbTab}
            onActive={setWbTab}
            changed={new Map([...touched].map(([rel, t]) => [rel, t.kind]))}
            stamp={String(touched.size)}
            terminals={[]}
            onNewTerminal={() => {}}
          />
        </div>
      )}
    </aside>
  );
}
