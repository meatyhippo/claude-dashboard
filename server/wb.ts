import type { Database } from "bun:sqlite";
import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Cached } from "../shared/baCustomers.ts";
import { nextStep, stageOf, tabOf, WB_PHASES, type WbDeal, type WbDigest, type WbNext, type WbProposal, type WbRow, type WbStateKey, type WbStep, type WbTicket, type WbContact } from "../shared/wb.ts";
import { labelFolderProject } from "./workspaces.ts";
import { getAgent, interruptAgent, onRestore, sendMessage, startAgent } from "./agents.ts";
import { cached, connectorBatch, connectorCall, FRONT_SEARCH, NOTION_QUERY, notionSql, parseJson, peekCache } from "./baConnector.ts";
import { readThread, readThreadsBatch } from "./baMail.ts";
import { readQaiAnswer, sendQaiDm } from "./baQai.ts";
import { domainOf, type BaFrontThread, type BaMailThread } from "../shared/baCustomers.ts";
import { frontThreads, getCustomer, linkThread } from "./baCustomers.ts";
import { DATA_DIR } from "./paths.ts";

/**
 * Workbench: the Integration Workbench on the BA edition's backbone.
 *
 * Reads go through `connectorCall` like the rest of the edition (one exact tool
 * call, raw result parsed, cached). Each ticket gets one Claude Code session of its
 * own, started with `startAgent`, so its chat, permission prompts and transcript are
 * Rein's. The session is given two tools served from this daemon (`propose_steps`,
 * `mark_steps`); the daemon, not the model, writes the step rows to Notion.
 */

/** The engineering issues database behind the "Me" view, for viewing someone else's tickets. */
const ISSUES_DS = "collection://18fe3fdb-2a33-4c08-b93c-7fd34931ee01";
const CLOSED = ["PS - Ready to preplan", "Production Ready", "Done", "Duplicate", "Won't do"];
const ISSUES_ME_VIEW = "https://www.notion.so/944fcba0c16c4d3497cc7a3c9dbcf603?v=2b5e32e8f8c880b4a6f3000c1f864695";
const CUSTOMER_TASKS = "collection://0d55b141-941e-473a-9240-4983e8790f92";
const DEALS = "collection://6244f314-784c-4172-b311-ff322d423a36";
const STEPS = "collection://9713dd30-44ee-4e2c-b618-d58c2e3d8474";
const STEPS_ID = "9713dd30-44ee-4e2c-b618-d58c2e3d8474";
const NOTION_UPDATE = "mcp__claude_ai_Notion__notion-update-page";
const NOTION_CREATE = "mcp__claude_ai_Notion__notion-create-pages";
const SLACK_SEARCH = "mcp__claude_ai_Slack__slack_search_public_and_private";
const SLACK_READ = "mcp__claude_ai_Slack__slack_read_channel";
const SLACK_PROFILE = "mcp__claude_ai_Slack__slack_read_user_profile";

const RULES = join(dirname(fileURLToPath(import.meta.url)), "wbRules");
const rule = (f: string) => readFileSync(join(RULES, f), "utf8");
const WB_DIR = join(DATA_DIR, "wb");

const pageId = (url: string) => {
  const all = String(url || "").split("?")[0]!.replace(/-/g, "").match(/[0-9a-f]{32}/gi) ?? [];
  return (all[all.length - 1] ?? "").toLowerCase();
};
const plain = (v: unknown) => String(v ?? "").replace(/\\([\\`*_{}\[\]()#+\-.!|<>~])/g, "$1").replace(/<\/?[a-z][^>]*>/gi, " ").replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/\s+/g, " ").trim();
const rel = (v: unknown): string[] => {
  if (Array.isArray(v)) return v.map(String);
  try {
    const a = JSON.parse(String(v || "[]"));
    return Array.isArray(a) ? a.map(String) : [];
  } catch {
    return [];
  }
};
const today = () => new Date().toISOString().slice(0, 10);

// ── local state ───────────────────────────────────────────────────────────────
let db: Database;
export function initWb(database: Database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS wb_kv (key TEXT PRIMARY KEY, json TEXT NOT NULL);`);
  mkdirSync(WB_DIR, { recursive: true });
}
function kv<T>(key: string, fallback: T): T {
  const row = db.query<{ json: string }, [string]>("SELECT json FROM wb_kv WHERE key = ?").get(key);
  return row ? (JSON.parse(row.json) as T) : fallback;
}
function kvSet(key: string, v: unknown) {
  db.query("INSERT OR REPLACE INTO wb_kv (key, json) VALUES (?, ?)").run(key, JSON.stringify(v));
}
function mapPut<T>(name: string, url: string, v: T | null): Record<string, T> {
  const m = kv<Record<string, T>>(name, {});
  if (v === null) delete m[url];
  else m[url] = v;
  kvSet(name, m);
  return m;
}
type SessionRef = { key: string; sessionId: string | null };
export const wbMode = (): "auto" | "step" => kv<"auto" | "step">("mode", "step");

// ── reads ─────────────────────────────────────────────────────────────────────
const REQ_COLUMNS_FULL = `url, "Task", "Type", "Status", "Category", "Front Link", "🚦 Integration", "Company", "Log", "userDefined:ID" AS rid, "date:Success Committed:start" AS committed, "Priority " AS reqprio`;
const REQ_COLUMNS_SAFE = `url, "Task", "Type", "Status", "Front Link", "🚦 Integration", "Company"`;

async function loadTickets(as: WbViewAs | null): Promise<WbTicket[]> {
  // 1. The "Me" view: issues assigned to you that are not complete. Viewing as someone
  //    else: the same filter on their Notion user id ("Assigned to" holds user://<id>).
  const rows: Record<string, any>[] = [];
  let cursor: string | null = null;
  if (as) {
    rows.push(
      ...(await notionSql(
        ISSUES_DS,
        `SELECT url, "Name", "Type", "Status", "Priority", "Last edited time", "All customer requests" FROM "${ISSUES_DS}" WHERE "Assigned to" LIKE ? AND "Status" NOT IN (${CLOSED.map(() => "?").join(", ")})`,
        [`%${as.id}%`, ...CLOSED],
        "List the engineering issues assigned to one teammate, for the Workbench overview viewed as them.",
      )),
    );
  }
  for (let i = 0; i < 5 && !as; i++) {
    const raw = await connectorCall(NOTION_QUERY, { data: { mode: "view", view_url: ISSUES_ME_VIEW, page_size: 100, ...(cursor ? { start_cursor: cursor } : {}) } }, "List the engineering issues assigned to the user for the Workbench overview.");
    const p = parseJson(raw);
    if (!p || !Array.isArray(p.results)) throw new Error(`Notion returned something unexpected: ${raw.slice(0, 200)}`);
    rows.push(...p.results);
    cursor = p.has_more ? p.next_cursor : null;
    if (!cursor) break;
  }
  const base = rows.map((r) => ({
    url: String(r.url),
    id: pageId(String(r.url)),
    task: plain(r.Name),
    type: String(r.Type ?? ""),
    status: String(r.Status ?? ""),
    priority: String(r.Priority ?? ""),
    edited: String(r["Last edited time"] ?? ""),
    request: rel(r["All customer requests"])[0] ?? "",
  }));

  // 2. Their customer requests, in one SQL read per 40 (full columns first; a renamed column falls back to the safe set).
  const reqIds = [...new Set(base.map((t) => pageId(t.request)).filter(Boolean))];
  const reqs = new Map<string, Record<string, any>>();
  for (let i = 0; i < reqIds.length; i += 40) {
    const chunk = reqIds.slice(i, i + 40);
    const where = chunk.map(() => `url LIKE ?`).join(" OR ");
    const params = chunk.map((id) => `%${id}%`);
    let found: Record<string, any>[];
    try {
      found = await notionSql(CUSTOMER_TASKS, `SELECT ${REQ_COLUMNS_FULL} FROM "${CUSTOMER_TASKS}" WHERE ${where}`, params, "Read the customer requests linked to the user's engineering issues.");
    } catch {
      found = await notionSql(CUSTOMER_TASKS, `SELECT ${REQ_COLUMNS_SAFE} FROM "${CUSTOMER_TASKS}" WHERE ${where}`, params, "Read the customer requests linked to the user's engineering issues.");
    }
    for (const r of found) reqs.set(pageId(String(r.url)), r);
  }

  // 3. Their deals (Deals Extract), for the customer name, tenants, Slack channel and go-live.
  const dealIds = [...new Set([...reqs.values()].flatMap((r) => rel(r.Company).map(pageId)).filter(Boolean))];
  const deals = new Map<string, WbDeal>();
  for (let i = 0; i < dealIds.length; i += 40) {
    const chunk = dealIds.slice(i, i + 40);
    const found = await notionSql(
      DEALS,
      `SELECT url, "Deal name (DONT EDIT)" AS name, "Status" AS status, "Sandbox URLs" AS sandbox, "Production URLs" AS prod, "Slack Channel ID" AS slack, "date:Go Live Date:start" AS golive FROM "${DEALS}" WHERE ${chunk.map(() => `url LIKE ?`).join(" OR ")}`,
      chunk.map((id) => `%${id}%`),
      "Read the deals behind the user's tickets (customer name, tenants, go-live).",
    );
    for (const d of found) deals.set(pageId(String(d.url)), { url: String(d.url), name: plain(d.name), status: d.status ?? null, sandbox: String(d.sandbox ?? ""), prod: String(d.prod ?? ""), slack: String(d.slack ?? ""), golive: String(d.golive ?? "") });
  }

  return base.map((t) => {
    const r = t.request ? reqs.get(pageId(t.request)) : undefined;
    const deal = r ? rel(r.Company).map((u) => deals.get(pageId(u))).find(Boolean) ?? null : null;
    const guess = (t.task.includes(":") ? t.task.split(":").pop()! : t.task).trim();
    const partial = {
      ...t,
      reqKey: r?.rid ? `T-${r.rid}` : "",
      reqTask: plain(r?.Task),
      reqType: String(r?.Type ?? ""),
      reqCategory: Array.isArray(r?.Category) ? r.Category.join(",") : String(r?.Category ?? ""),
      reqStatus: String(r?.Status ?? ""),
      committed: String(r?.committed ?? "").slice(0, 10),
      reqPriority: String(r?.reqprio ?? ""),
      front: String(r?.["Front Link"] ?? ""),
      log: String(r?.Log ?? ""),
      integ: rel(r?.["🚦 Integration"]),
      customer: deal?.name || guess || "Unknown customer",
      deal,
      diag: !t.request ? "no customer request linked on the engineering issue" : !r ? "customer request not readable" : !deal ? "customer request has no deal linked" : "",
    };
    return { ...partial, tab: tabOf(partial), stage: stageOf(partial) };
  });
}

// One list per person viewed: a load for one person finishing late never lands in another's.
const ticketsKey = () => {
  const as = wbViewAs();
  return as ? `wb:tickets:${as.id}` : "wb:tickets";
};
const tickets = (refresh: boolean) => {
  const as = wbViewAs();
  return cached(ticketsKey(), refresh, () => loadTickets(as), 10 * 60_000, { swr: true });
};
const peekTickets = (): WbTicket[] => {
  const row = db.query<{ json: string | null }, [string]>("SELECT json FROM ba_cache WHERE key = ?").get(ticketsKey());
  return row?.json ? (JSON.parse(row.json) as WbTicket[]) : [];
};
const peekList = (key: string): WbTicket[] => {
  const row = db.query<{ json: string | null }, [string]>("SELECT json FROM ba_cache WHERE key = ?").get(key);
  return row?.json ? (JSON.parse(row.json) as WbTicket[]) : [];
};
/** A ticket by URL: the list on screen first, then your own (chats and Qai waits on your tickets keep working while viewing someone else). */
const ticketOf = (url: string) => peekTickets().find((t) => t.url === url) ?? peekList("wb:tickets").find((t) => t.url === url) ?? null;

/** Steps the daemon changed and has not finished writing: a Notion read must not overwrite them. */
const dirty = new Set<string>();
const stepsMap = () => kv<Record<string, WbStep[]>>("steps", {});
const stepsOf = (url: string) => stepsMap()[url] ?? [];
function setSteps(url: string, steps: WbStep[]) {
  mapPut("steps", url, steps);
}

async function loadSteps(urls: string[]): Promise<number> {
  const by: Record<string, WbStep[]> = Object.fromEntries(urls.map((u) => [u, []]));
  // Notion returns at most 100 rows per query: six tickets (12 steps at most each) per query
  // stay under it, all queries in one batch session. A query that does hit 100 means rows
  // were cut off, so it fails instead of dropping the last steps of every ticket.
  const sqlOf = (chunk: string[]) => `SELECT url, "Ticket URL", "Name", "Order", "Phase", "Kind", "State", "Tool", "Done check", "Result" FROM "${STEPS}" WHERE "Ticket URL" IN (${chunk.map(() => "?").join(",")}) ORDER BY "Order"`;
  const chunks: string[][] = [];
  for (let i = 0; i < urls.length; i += 6) chunks.push(urls.slice(i, i + 6));
  const inputOf = (chunk: string[]) => ({ data: { mode: "sql", data_source_urls: [STEPS], query: sqlOf(chunk), params: chunk } });
  const keyOf = (x: { data: { params: string[] } }) => x.data.params.join(",");
  const got = chunks.length > 1 ? await connectorBatch(NOTION_QUERY, chunks.map(inputOf), keyOf, "Read the setup steps of the user's tickets.").catch(() => new Map<string, string>()) : new Map<string, string>();
  for (const chunk of chunks) {
    const raw = got.get(chunk.join(","));
    const parsed = raw != null ? parseJson(raw) : null;
    const rows: Record<string, any>[] = Array.isArray(parsed?.results) ? parsed.results : await notionSql(STEPS, sqlOf(chunk), chunk, "Read the setup steps of the user's tickets.");
    if (rows.length >= 100) throw new Error("Notion cut the step list off at 100 rows");
    for (const r of rows) {
      const u = String(r["Ticket URL"]);
      const state = r.State === "running" ? "pending" : (r.State ?? "pending");
      by[u]?.push({ url: String(r.url), name: String(r.Name ?? ""), order: Number(r.Order) || 0, phase: String(r.Phase ?? "Scope"), kind: r.Kind === "manual" ? "manual" : "auto", state, tool: String(r.Tool ?? ""), check: String(r["Done check"] ?? ""), result: String(r.Result ?? "") });
    }
  }
  const m = stepsMap();
  for (const u of urls) if (!dirty.has(u)) m[u] = by[u]!.sort((a, b) => a.order - b.order);
  for (const u of Object.keys(m)) if (!urls.includes(u) && !dirty.has(u)) delete m[u];
  kvSet("steps", m);
  return urls.length;
}
const syncSteps = (refresh: boolean) => cached("wb:steps", refresh, () => loadSteps(peekTickets().map((t) => t.url)), 5 * 60_000, { swr: true });

// ── rows for the page ─────────────────────────────────────────────────────────
/**
 * A run Claude is doing on a ticket's steps. `single` runs stop after one step,
 * except in Auto mode: there a step Claude finished as done hands over to the next
 * Claude step by itself, until a step is yours, needs you, is blocked, or you press Stop.
 */
type Chain = { stop: boolean; single: boolean; order: number | null; busySeen: boolean; doneBefore: number };
const doneCount = (url: string) => stepsOf(url).filter((s) => s.state === "done").length;
const chains = new Map<string, Chain>();

function autoState(t: WbTicket): { k: WbStateKey; at: number; auto: true } | null {
  const r = t.reqStatus;
  return /awaiting customer/i.test(r) ? { k: "customer", at: 0, auto: true } : /awaiting external/i.test(r) ? { k: "external", at: 0, auto: true } : /awaiting development/i.test(r) ? { k: "dev", at: 0, auto: true } : null;
}

/** How a ticket's folder is named in the sidebar and on Home instead of its Notion id. */
const wbLabel = (t: WbTicket) => (t.task || t.customer || "Workbench ticket").replace(/\s+/g, " ").trim();

// ── Last contact: the newest email across every Front thread tied to the ticket ──
const READ_MESSAGE = "mcp__claude_ai_Front__read_message";
const pid = (u: string) => (u.match(/[0-9a-f]{32}/i)?.[0] ?? "").toLowerCase();
/** The conversations of one ticket: its Front Link (a conversation, or a message resolved to one) and the threads placed on its request. */
function contactThreads(t: WbTicket): { cnv: string[]; msg: string[] } {
  const msgCnv = kv<Record<string, string>>("msgCnv", {});
  const cnv = new Set<string>();
  const msg: string[] = [];
  for (const id of t.front.match(/(cnv|msg)_[a-z0-9]+/gi) ?? []) {
    if (id.startsWith("cnv_")) cnv.add(id);
    else if (msgCnv[id]) cnv.add(msgCnv[id]!);
    else msg.push(id);
  }
  for (const id of kv<Record<string, string[]>>("extraThreads", {})[t.url] ?? []) cnv.add(id);
  const req = pid(t.request);
  if (req) for (const r of db.query<{ thread_id: string; ir_url: string }, []>("SELECT thread_id, ir_url FROM ba_thread_links WHERE ir_url IS NOT NULL").all()) if (pid(r.ir_url) === req) cnv.add(r.thread_id);
  return { cnv: [...cnv], msg };
}
function contactOf(t: WbTicket): WbContact | null {
  const threads = contactThreads(t).cnv.flatMap((id) => {
    const th = peekCache<BaMailThread>(`thread:${id}`);
    const last = th?.entries.filter((e) => e.kind === "message" && e.at).sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).pop();
    return th && last ? [{ id, subject: th.subject, link: th.link || `https://app.frontapp.com/open/${id}`, at: last.at!, who: last.author, inbound: last.inbound }] : [];
  });
  if (!threads.length) return null;
  threads.sort((a, b) => b.at - a.at);
  const top = threads[0]!;
  return { at: top.at, who: top.who, inbound: top.inbound, threads };
}
let contactWarm = 0;
/** In the background: resolve linked messages to their conversation and read conversations not read yet (at most every ten minutes). */
async function warmContacts(rows: WbTicket[]) {
  if (Date.now() - contactWarm < 10 * 60_000) return;
  contactWarm = Date.now();
  const msgs = [...new Set(rows.flatMap((t) => contactThreads(t).msg))];
  if (msgs.length) {
    const got = await connectorBatch(READ_MESSAGE, msgs.map((m) => ({ messageId: m, reason: "Finds the conversation a linked message belongs to, for the last contact date on the dashboard." })), (x) => x.messageId, "Find the conversations of linked Front messages.").catch(() => new Map<string, string>());
    const m = kv<Record<string, string>>("msgCnv", {});
    for (const [id, raw] of got) {
      const c = parseJson(raw)?.conversationId ?? raw.match(/cnv_[a-z0-9]+/i)?.[0];
      if (c) m[id] = String(c);
    }
    kvSet("msgCnv", m);
  }
  const todo = [...new Set(rows.flatMap((t) => contactThreads(t).cnv))].filter((id) => !peekCache<BaMailThread>(`thread:${id}`));
  if (todo.length) await readThreadsBatch(todo);
}

/** The dashboard customer a ticket belongs to, through its deal. */
function projectOfTicket(t: WbTicket): number | null {
  if (!t.deal?.url) return null;
  return db.query<{ project_id: number | null }, [string]>("SELECT project_id FROM ba_deals WHERE deal_url = ?").get(t.deal.url)?.project_id ?? null;
}

/** The Front search for a ticket's customer: their own Front query, else the email domains on its threads, else the name. */
function frontQueryOf(t: WbTicket): { query: string; projectId: number | null } {
  const projectId = projectOfTicket(t);
  // Best signal: the customer's email domains on the threads already tied to the ticket.
  const doms = [
    ...new Set(
      contactThreads(t).cnv.flatMap((id) => {
        const th = peekCache<BaMailThread>(`thread:${id}`);
        return (th?.entries ?? []).flatMap((e) => [e.fromAddress ?? "", ...e.to]).filter((x) => /@/.test(x)).map((x) => domainOf(x.toLowerCase()));
      }).filter((d): d is string => !!d && !/qargo\./i.test(d)),
    ),
  ];
  const short = t.customer.replace(/\b(limited|ltd|bv|b\.v\.|nv|n\.v\.|gmbh|sa|group|partnership|global|logistics?|transport|services)\b\.?/gi, " ").replace(/[^\p{L}\p{N}&' -]/gu, " ").replace(/\s+/g, " ").trim();
  const query = (projectId ? getCustomer(projectId)?.frontQuery : null) || (doms.length ? doms.slice(0, 3).join(" OR ") : `"${short || t.customer}"`);
  return { query, projectId };
}
const frontSearchInput = (query: string) => ({ query, scope: "all_inboxes", filters: { after: new Date(Date.now() - 365 * 86_400_000).toISOString().slice(0, 10) }, reason: "Finds the newest conversations with one customer, for the last contact date on a dashboard ticket." });
function frontResults(t: WbTicket, raw: string) {
  const linked = new Set(contactThreads(t).cnv);
  return frontThreads(raw)
    .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    .slice(0, 12)
    .map((x) => ({ ...x, linked: linked.has(x.id) }));
}

/** Right-click "Search latest Front thread": the customer's newest conversations, newest first. */
export async function wbFrontSearch(url: string): Promise<{ threads: (BaFrontThread & { linked: boolean })[]; query: string; projectId: number | null }> {
  const t = ticketOf(url);
  if (!t) throw new Error("ticket not found");
  const { query, projectId } = frontQueryOf(t);
  const raw = await connectorCall(FRONT_SEARCH, frontSearchInput(query), "Search the newest Front conversations with this customer.");
  return { threads: frontResults(t, raw), query, projectId };
}

// ── Automatic Front search: what right-click did, in the background ───────────
export type WbFrontAsk = { at: number; query: string; threads: (BaFrontThread & { linked: boolean })[] };
const STOP_WORDS = new Set("with from that this have your will into over about integration integrations request change setup order orders customer qargo import export update test testing ticket support".split(" "));
const wordsOf = (s: string) => (s.toLowerCase().match(/[\p{L}\p{N}]{4,}/gu) ?? []).filter((w) => !STOP_WORDS.has(w));
let frontAutoRun = 0;
/**
 * Every half hour, for tickets whose last contact is missing or older than two days (each at most
 * twice a day): search Front the way right-click does. Newer threads whose subject names the ticket
 * (its title, request or integration) and is the only such one are tied to the ticket; any other
 * newer thread is a doubt, shown on the row for the user to pick.
 */
async function autoFrontSearch(rows: WbTicket[]) {
  if (Date.now() - frontAutoRun < 30 * 60_000) return;
  frontAutoRun = Date.now();
  const done = kv<Record<string, number>>("frontAuto", {});
  const dismissed = kv<Record<string, string[]>>("frontDismissed", {});
  const due = rows.filter((t) => {
    if (Date.now() - (done[t.url] ?? 0) < 12 * 3_600_000) return false;
    const c = contactOf(t);
    // A Front Link still being read has no contact yet: wait for it rather than search.
    if (!c && /(cnv|msg)_[a-z0-9]+/i.test(t.front) && contactThreads(t).msg.length) return false;
    return !c || Date.now() - c.at > 2 * 86_400_000;
  });
  if (!due.length) return;
  const byQuery = new Map<string, WbTicket[]>();
  for (const t of due) {
    const q = frontQueryOf(t).query;
    byQuery.set(q, [...(byQuery.get(q) ?? []), t]);
  }
  const got = await connectorBatch(FRONT_SEARCH, [...byQuery.keys()].map(frontSearchInput), (x) => x.query, "Search the newest Front conversations with these customers.").catch(() => new Map<string, string>());
  for (const [query, ts] of byQuery) {
    const raw = got.get(query);
    if (raw == null) continue;
    for (const t of ts) {
      mapPut("frontAuto", t.url, Date.now());
      const since = contactOf(t)?.at ?? 0;
      const skip = new Set(dismissed[t.url] ?? []);
      const newer = frontResults(t, raw).filter((x) => !x.linked && !skip.has(x.id) && (x.updatedAt ?? 0) > since);
      if (!newer.length) {
        mapPut("frontAsk", t.url, null);
        continue;
      }
      const words = new Set(wordsOf([t.task, t.reqTask, ...t.integ].join(" ")));
      const named = newer.filter((x) => wordsOf(x.subject ?? "").some((w) => words.has(w)));
      if (named.length === 1) {
        await wbFrontUse(t.url, named[0]!).catch(() => null);
        console.log(`[wb] front auto: ${t.task} ← ${named[0]!.subject}`);
        const rest = newer.filter((x) => x.id !== named[0]!.id && (x.updatedAt ?? 0) > (named[0]!.updatedAt ?? 0));
        mapPut("frontAsk", t.url, rest.length ? { at: Date.now(), query, threads: rest.slice(0, 6) } : null);
      } else {
        mapPut("frontAsk", t.url, { at: Date.now(), query, threads: newer.slice(0, 6) } satisfies WbFrontAsk);
      }
    }
  }
}

/** "Not these": the suggested threads are not the ticket's; never suggest them again. */
export function wbFrontDismiss(url: string) {
  const ask = kv<Record<string, WbFrontAsk | null>>("frontAsk", {})[url];
  const prev = kv<Record<string, string[]>>("frontDismissed", {})[url] ?? [];
  mapPut("frontDismissed", url, [...new Set([...prev, ...(ask?.threads ?? []).map((x) => x.id)])]);
  mapPut("frontAsk", url, null);
  return { ok: true };
}

/** Tie a Front conversation to the ticket's request, so Last contact counts it. */
export async function wbFrontUse(url: string, thread: BaFrontThread): Promise<{ ok: boolean; error?: string }> {
  const t = ticketOf(url);
  if (!t) return { ok: false, error: "ticket not found" };
  const projectId = projectOfTicket(t);
  // Placed on the customer (so the Inbox knows it too) when the ticket's deal is under one; always remembered on the ticket.
  if (projectId && t.request) linkThread(thread, projectId, t.request, "manual");
  const extra = kv<Record<string, string[]>>("extraThreads", {});
  mapPut("extraThreads", url, [...new Set([...(extra[url] ?? []), thread.id])]);
  const ask = kv<Record<string, WbFrontAsk | null>>("frontAsk", {})[url];
  if (ask) {
    const rest = ask.threads.filter((x) => x.id !== thread.id && (x.updatedAt ?? 0) > (thread.updatedAt ?? 0));
    mapPut("frontAsk", url, rest.length ? { ...ask, threads: rest } : null);
  }
  await readThreadsBatch([thread.id]).catch(() => 0);
  return { ok: true };
}

// ── View as: show another teammate's tickets (their "Me" view) ────────────────
export type WbViewAs = { id: string; name: string; email?: string | null };
export const wbViewAs = () => kv<WbViewAs | null>("viewAs", null);
async function findPeople(query: string): Promise<WbViewAs[]> {
  const raw = await connectorCall("mcp__claude_ai_Notion__notion-get-users", { query, page_size: 10 }, "Find a teammate in Notion to view the Workbench as them.");
  const p = parseJson(raw) ?? {};
  const list: any[] = Array.isArray(p.results) ? p.results : Array.isArray(p.users) ? p.users : Array.isArray(p) ? p : [];
  return list
    .filter((u) => (u.type ?? "person") === "person" && u.id)
    .map((u) => ({ id: String(u.id).replace(/^user:\/\//, ""), name: String(u.name ?? u.email ?? u.id), email: u.email ?? u.person?.email ?? null }));
}

export async function wbRows(refresh: boolean): Promise<Cached<WbRow[]> & { mode: string; viewAs: WbViewAs | null }> {
  const t = await tickets(refresh);
  if (t.data) void syncSteps(refresh).catch(() => {});
  if (t.data) void warmContacts(t.data).then(() => (!wbViewAs() && t.data ? autoFrontSearch(t.data) : undefined)).catch(() => {});
  // Folders of tickets that already have a session get their name back on every read.
  for (const x of t.data ?? []) if (existsSync(join(WB_DIR, x.id))) labelFolderProject(join(WB_DIR, x.id), wbLabel(x));
  const pins = kv<Record<string, number>>("pins", {});
  const frontAsks = kv<Record<string, WbFrontAsk>>("frontAsk", {});
  const states = kv<Record<string, { k: WbStateKey; at: number }>>("state", {});
  const answered = kv<Record<string, { at: number; who: string; ack?: boolean }>>("answered", {});
  const proposals = kv<Record<string, WbProposal>>("proposals", {});
  const nexts = kv<Record<string, WbNext>>("next", {});
  const stepErrors = kv<Record<string, { at: number; error: string }>>("stepsError", {});
  const sessions = kv<Record<string, SessionRef>>("sessions", {});
  const qaiWaits = kv<Record<string, QaiWait[]>>("qaiWait", {});
  const steps = stepsMap();
  const data =
    t.data?.map((x): WbRow => {
      const ref = sessions[x.url];
      const a = ref ? getAgent(ref.key) : null;
      const live = a && a.status !== "ended" && a.status !== "error" ? { key: a.key, status: a.status as string } : null;
      return { ...x, steps: steps[x.url] ?? [], pinned: !!pins[x.url], state: states[x.url] ?? autoState(x), answered: answered[x.url] ?? null, proposal: proposals[x.url] ?? null, next: nexts[x.url] ?? null, stepsError: stepErrors[x.url]?.error ?? null, session: live, running: chains.has(x.url), contact: contactOf(x), frontAsk: frontAsks[x.url] ?? null, qai: (qaiWaits[x.url] ?? [])[0] ? { at: qaiWaits[x.url]![0]!.at, link: qaiWaits[x.url]![0]!.link } : null };
    }) ?? null;
  return { ...t, data, mode: wbMode(), viewAs: wbViewAs() };
}

// ── Notion writes the daemon makes itself (step rows, status) ─────────────────
const notionUpdate = (page: string, properties: Record<string, unknown>, reason: string) => connectorCall(NOTION_UPDATE, { page_id: page, command: "update_properties", properties }, reason);

async function writeSteps(url: string, changed: WbStep[]) {
  dirty.add(url);
  try {
    for (const s of changed) {
      if (!s.url) continue;
      await notionUpdate(s.url, { Name: s.name, State: s.state, Result: s.result.slice(0, 1900), ...(s.state === "done" ? { "date:Finished:start": today(), "date:Finished:is_datetime": 0 } : {}) }, "Save the state of a setup step the user or Claude just changed.");
    }
  } finally {
    dirty.delete(url);
  }
}

export async function setStepState(url: string, order: number, state: WbStep["state"], result?: string) {
  const steps = stepsOf(url).map((s) => ({ ...s }));
  const s = steps.find((x) => x.order === order);
  if (!s) return false;
  s.state = state;
  if (result !== undefined) s.result = result;
  setSteps(url, steps);
  void writeSteps(url, [s]).catch(() => {});
  return true;
}

/**
 * Save an approved step list to Notion. Order matters: the new rows are created
 * first and the old ones detached only once that worked, so a failed write never
 * leaves the ticket without steps. Afterwards the rows are read back and counted;
 * any failure puts the proposal back and shows why (row.stepsError).
 */
async function approveProposal(url: string) {
  const p = kv<Record<string, WbProposal>>("proposals", {})[url];
  const t = ticketOf(url);
  if (!p || !t) return false;
  const old = stepsOf(url);
  const steps: WbStep[] = p.steps.map((s, i) => ({ ...s, url: "", order: i + 1 }));
  setSteps(url, steps);
  mapPut("proposals", url, null);
  mapPut("stepsError", url, null);
  dirty.add(url);
  (async () => {
    const fail = (why: string) => {
      setSteps(url, old);
      mapPut("proposals", url, p);
      mapPut("stepsError", url, { at: Date.now(), error: why });
    };
    try {
      const pages = steps.map((s) => ({
        properties: { Name: s.name, "Ticket URL": url, Order: s.order, Phase: s.phase, Kind: s.kind, State: s.state, Tool: s.tool, "Done check": s.check, Result: s.result, ...(s.state === "done" ? { "date:Finished:start": today(), "date:Finished:is_datetime": 0 } : {}), ...(t.request ? { Ticket: [t.request] } : {}), Issue: [url] },
      }));
      try {
        await connectorCall(NOTION_CREATE, { parent: { type: "data_source_id", data_source_id: STEPS_ID }, pages }, "Save the setup steps the user approved for a ticket.");
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        // No access to the Workbench Steps database: say so plainly; the save is retried by itself.
        const access = /not.?found|could not find|restricted|permission|unauthori|access/i.test(msg);
        return fail(access ? "Your Notion account can't reach the Workbench Steps database yet. Ask its owner to share it with you (Can edit); the steps are kept here and saved by themselves once it's shared." : `Notion did not save the new steps: ${msg.slice(0, 200)}`);
      }
      // Only now take the old rows off the ticket.
      const detach = old.filter((o) => o.url).map((o) => ({ page_id: o.url, command: "update_properties", properties: { "Ticket URL": `${url}#replaced-${today()}` } }));
      const done = await connectorBatch(NOTION_UPDATE, detach, (x) => x.page_id, "Detach replaced setup steps from their ticket.").catch(() => new Map<string, string>());
      for (const d of detach) if (!done.has(d.page_id)) await notionUpdate(d.page_id, d.properties, "Detach a replaced setup step from its ticket.").catch(() => {});
      // Notion needs a moment to index new rows; read them back for their urls and check they are all there.
      await new Promise((r) => setTimeout(r, 4000));
    } finally {
      dirty.delete(url);
      await syncSteps(true).catch(() => {});
      const got = stepsOf(url);
      if (!kv<Record<string, unknown>>("stepsError", {})[url] && (got.length !== steps.length || got.some((s) => !s.url)))
        mapPut("stepsError", url, { at: Date.now(), error: `Notion shows ${got.filter((s) => s.url).length} of ${steps.length} steps after saving. Get status rebuilds the list from the tenant.` });
    }
  })().catch(() => {});
  return true;
}

// Steps that could not be saved (e.g. the database was not shared yet) are kept as the
// proposal; try saving them again every 10 minutes, so they land once access is there.
setInterval(() => {
  const errs = kv<Record<string, { at: number; error: string }>>("stepsError", {});
  const props = kv<Record<string, WbProposal>>("proposals", {});
  for (const [url, e] of Object.entries(errs)) {
    if (!props[url] || Date.now() - e.at < 10 * 60_000 || !/can't reach the Workbench Steps|did not save the new steps/.test(e.error)) continue;
    void approveProposal(url).catch(() => {});
  }
}, 10 * 60_000);

// Once: fill the Issue relation (step → engineering issue) on steps saved before it existed.
setTimeout(async () => {
  if (kv<boolean>("issueBackfill", false)) return;
  const todo = Object.entries(stepsMap()).flatMap(([url, steps]) => steps.filter((x) => x.url).map((x) => ({ page_id: x.url, command: "update_properties", properties: { Issue: [url] } })));
  if (!todo.length) return;
  let ok = 0;
  for (let i = 0; i < todo.length; i += 25) {
    const chunk = todo.slice(i, i + 25);
    const got = await connectorBatch(NOTION_UPDATE, chunk, (x) => x.page_id, "Link setup steps to their engineering issue.").catch(() => new Map<string, string>());
    ok += chunk.filter((x) => got.has(x.page_id)).length;
  }
  console.log(`[wb] issue backfill: ${ok}/${todo.length}`);
  if (ok === todo.length) kvSet("issueBackfill", true);
}, 90_000);

// Step updates proposed before they needed no approval: save the ones still waiting, once.
setTimeout(() => {
  // "Notion shows 10 of 12 steps" came from the read-back being cut at 100 rows, not from a failed save.
  for (const [url, e] of Object.entries(kv<Record<string, { error: string }>>("stepsError", {}))) if (/^Notion shows \d+ of \d+ steps after saving/.test(e.error)) mapPut("stepsError", url, null);
  const errs = kv<Record<string, unknown>>("stepsError", {});
  for (const [url, p] of Object.entries(kv<Record<string, WbProposal>>("proposals", {}))) if (p.replace && !errs[url]) void approveProposal(url).catch(() => {});
}, 60_000);

// ── the ticket's session ──────────────────────────────────────────────────────
const QARGO_READS = ["list_tenants", "get_tenant_details", "internal_integrations_get_integration_instance_definition", "internal_integrations_list_routes", "internal_read_config", "internal_list_config", "find_entity", "filter_entities", "internal_fetch_entity", "external_api_discover", "external_api_schema", "external_api_call_read", "internal_datafetchershaper_list_transformation_mappings", "internal_datafetchershaper_get_transformation_mapping", "internal_datafetchershaper_list_global_transformation_mappings", "internal_datafetchershaper_get_global_transformation_mapping", "get_filter_schema", "aggregate_entities", "app_registered_query_list", "app_registered_query_schema", "app_registered_query_run", "app_actions_list", "app_actions_schema", "internal_get_config_schema", "internal_validate_config", "internal_get_tenant_config", "internal_integrations_list_billing_entities", "internal_datafetchershaper_list_model_definitions", "internal_datafetchershaper_get_transformation_schema", "internal_datafetchershaper_fetch_transformation_input_data", "internal_datafetchershaper_transform_document", "list_resources", "read_resource", "internal_download_storage_file"];
/** Reads that never need a prompt. Everything else asks in the session, as in any dashboard session. */
const ALLOWED = [
  "mcp__workbench__propose_steps",
  "mcp__workbench__mark_steps",
  "mcp__workbench__set_next_action",
  // You asked for Qai questions to go out without a prompt: a DM to the bot, nothing else.
  "mcp__workbench__ask_qai",
  ...["notion-fetch", "notion-search", "notion-query-data-sources", "notion-get-comments", "notion-get-users", "notion-query-meeting-notes"].map((x) => `mcp__claude_ai_Notion__${x}`),
  ...["search_conversations", "read_conversation", "read_message", "search_contacts", "read_contact", "list_inboxes", "list_teammates", "get_attachment"].map((x) => `mcp__claude_ai_Front__${x}`),
  ...["slack_search_public_and_private", "slack_search_public", "slack_read_channel", "slack_read_thread", "slack_search_users", "slack_search_channels", "slack_read_canvas"].map((x) => `mcp__claude_ai_Slack__${x}`),
  ...["get_context", "list_projects", "list_explores", "grep_fields", "get_metadata", "search_field_values", "run_metric_query", "get_query_result", "find_content", "list_content", "read_content"].map((x) => `mcp__claude_ai_Lightdash__${x}`),
  ...QARGO_READS.flatMap((x) => [`mcp__claude_ai_qargo-mcp-prod__${x}`, `mcp__qargo-mcp-prod__${x}`, `mcp__claude_ai_qargo-mcp-test__${x}`, `mcp__qargo-mcp-test__${x}`]),
];

function workbenchTools(url: string) {
  const stepShape = z.object({
    name: z.string().describe("the action, verb first, plain words, 3 to 7 words; no tool or field names"),
    phase: z.enum(WB_PHASES),
    kind: z.enum(["auto", "manual"]).describe("auto = Claude does it with the Qargo tools; manual = a person or the customer"),
    tool: z.string().optional(),
    check: z.string().optional().describe("one line: what makes this step done"),
    state: z.enum(["pending", "done"]).optional().describe("done only when you verified it on the tenant"),
    result: z.string().optional().describe("what you saw, for done steps"),
  });
  return createSdkMcpServer({
    name: "workbench",
    version: "1.0.0",
    tools: [
      tool(
        "propose_steps",
        "Propose a new setup flow for this ticket, or replace the existing one: 5 to 12 ordered steps. A first list is approved by the person on the Workbench page; a replacement of an existing list is saved to Notion straight away (no approval), so call it whenever the steps really changed. Include at least one auto Test step before the customer's own testing, and end with a manual go-live approval.",
        { note: z.string().optional(), steps: z.array(stepShape).min(3).max(12) },
        async ({ note, steps }) => {
          const p: WbProposal = { id: crypto.randomUUID(), at: Date.now(), note: note ?? "", replace: stepsOf(url).length > 0, steps: steps.map((s) => ({ name: s.name.slice(0, 80), phase: s.phase, kind: s.kind, tool: s.tool ?? "", check: (s.check ?? "").slice(0, 240), state: s.state === "done" ? "done" : "pending", result: (s.result ?? "").slice(0, 300) })) };
          mapPut("proposals", url, p);
          // An update of an existing list needs no approval (the person asked for that): saved at once.
          if (p.replace) {
            await approveProposal(url);
            return { content: [{ type: "text", text: "Steps updated on the Workbench and being saved to Notion. Do not list the steps again." }] };
          }
          return { content: [{ type: "text", text: "Proposal shown on the Workbench page. The person approves it there; do not list the steps again." }] };
        },
      ),
      tool(
        "set_next_action",
        "Name the one next action on this ticket. It shows as a button on the Workbench; when the person clicks it, prompt is sent to you in this chat as the instruction. Call it at the end of every status check and step run.",
        {
          label: z.string().describe("button text, verb first, 2 to 4 words, e.g. 'Update mapping', 'Re-run test trip', 'Reply to James'"),
          prompt: z.string().describe("the full instruction you will get when the button is clicked: what to do, with the concrete facts (versions, ids, dates, the customer's answers) so it runs without re-reading everything"),
          who: z.enum(["claude", "you"]).describe("claude = you can do it with your tools; you = the person has to (a call, a decision, a mail only they can send)"),
        },
        async ({ label, prompt, who }) => {
          mapPut<WbNext>("next", url, { label: label.trim().slice(0, 40), prompt: prompt.slice(0, 4000), who, at: Date.now() });
          return { content: [{ type: "text", text: "Next action shown as a button on the Workbench." }] };
        },
      ),
      tool(
        "ask_qai",
        "Ask Qai (Qargo's bot with the TMS codebase and backend access) a backend question in the user's Slack DM with it, and wait for its answer (up to 8 minutes). Use it whenever you are unsure about something the backend or codebase settles: how a mapping, export, charge type, field or config behaves, why the TMS did something, what a setting does. Qai can only act with a tenant link: always give the tenant the question is about (the ticket's sandbox by default; another tenant, e.g. production, when the question is about that one). Ask one precise, self-contained question with ids and what you already saw. Do not ask about data you can read yourself with your tools.",
        {
          question: z.string().describe("the question, precise and self-contained, with ids and what you already saw"),
          tenant: z.string().optional().describe("the tenant slug or app.qargo.com link the question is about; defaults to the ticket's sandbox tenant"),
        },
        async ({ question, tenant: asked }) => {
          const t = ticketOf(url);
          // Qai needs the tenant link on every question, or it cannot do anything.
          const slug = (asked ?? "").trim().replace(/^https?:\/\/app\.qargo\.com\//i, "").replace(/[/?#].*$/, "") || (t ? tenantOf(t) : "");
          if (!/^[a-z0-9][a-z0-9-]*$/i.test(slug))
            return { content: [{ type: "text", text: "Not sent: Qai needs a tenant link on every question and this ticket has no sandbox tenant on its deal. Find the tenant (list_tenants), then call ask_qai again with tenant set." }], isError: true };
          const sandbox = t?.deal?.sandbox?.split(/[,\s]+/).includes(slug);
          const prod = t?.deal?.prod?.split(/[,\s]+/).includes(slug);
          const kind = sandbox ? " (sandbox)" : prod ? " (production)" : "";
          const msg = `<https://app.qargo.com/${slug}|app.qargo.com/${slug}>\n\nQuestion · tenant ${slug}${kind}\n\n${question.trim()}\n\nTicket: ${t ? `${t.task} · <${t.url}|app.notion.com/p/…> · customer ${t.customer}` : url}\n\nReply in this thread with the full answer in one message; I pick it up in the Integration Workbench.`;
          const sent = await sendQaiDm(msg).catch((e) => ({ error: String(e?.message ?? e) }) as const);
          if ("error" in sent) return { content: [{ type: "text", text: `Could not ask Qai: ${sent.error}` }], isError: true };
          if (!sent.ts) return { content: [{ type: "text", text: `Asked Qai, but Slack gave no message id, so its answer cannot be picked up here. Ask the person to read it in Slack${sent.link ? `: ${sent.link}` : ""}.` }], isError: true };
          const waits = kv<Record<string, QaiWait[]>>("qaiWait", {});
          mapPut("qaiWait", url, [...(waits[url] ?? []), { channel: sent.channel, ts: sent.ts, link: sent.link, at: Date.now(), tenant: slug, question: question.slice(0, 300) }]);
          return {
            content: [{ type: "text", text: `Asked Qai (tenant ${slug}${sent.link ? `, ${sent.link}` : ""}). Qai takes a few minutes. Its answer is checked every minute and arrives in this chat as a message when it is final; then you continue. Now: do whatever does not depend on the answer, then end your turn with one line saying you are waiting on Qai. Do not guess the answer and do not ask the person to nudge you.` }],
          };
        },
      ),
      tool(
        "mark_steps",
        "Set the state of existing steps after you verified them. order is the step's number in the list. Give a one-line result per step. name (optional) renames the step. The Workbench saves it to Notion: do not write the step rows yourself.",
        { steps: z.array(z.object({ order: z.number(), state: z.enum(["done", "pending", "needs you", "blocked"]), result: z.string().optional(), name: z.string().optional() })) },
        async ({ steps }) => {
          const list = stepsOf(url).map((s) => ({ ...s }));
          const changed: WbStep[] = [];
          const out: string[] = [];
          for (const x of steps) {
            const s = list.find((y) => y.order === x.order);
            if (!s) {
              out.push(`no step ${x.order}`);
              continue;
            }
            s.state = x.state;
            if (x.result !== undefined) s.result = x.result.slice(0, 1900);
            if (x.name?.trim()) s.name = x.name.trim().slice(0, 80);
            changed.push(s);
            out.push(`${s.order} ${s.name}: ${s.state}`);
          }
          setSteps(url, list);
          void writeSteps(url, changed).catch(() => {});
          return { content: [{ type: "text", text: out.join("; ") || "nothing changed" }] };
        },
      ),
    ],
  });
}

function tenantOf(t: WbTicket) {
  return String(t.deal?.sandbox || "").split(/[,\s]+/).filter(Boolean)[0] ?? "";
}

/** The ticket's folder and its CLAUDE.md: what stays the same for the whole session. */
function prepare(t: WbTicket): string {
  const dir = join(WB_DIR, t.id);
  mkdirSync(dir, { recursive: true });
  labelFolderProject(dir, wbLabel(t));
  const d = t.deal;
  writeFileSync(
    join(dir, "CLAUDE.md"),
    `# Workbench ticket · ${t.customer} · ${t.task}

This session belongs to ONE integration ticket. Smart Brevity, no em dashes.
- Engineering issue: ${t.url} (type ${t.type})
- Customer request: ${t.request || "none linked"}${t.reqTask ? ` · ${t.reqKey} ${t.reqTask}` : ""}
- Customer: ${t.customer}. Sandbox tenant(s): ${d?.sandbox || "none on the deal"}. Production: ${d?.prod || "none on the deal (find it with list_tenants)"}. Slack channel: ${d?.slack || "none"}. Go-live: ${d?.golive || "not set"}.
- Front thread linked on the request: ${t.front || "none"}
- Partner page(s) (🚦 Integration, with the agent documentation / playbook): ${t.integ.join(", ") || "none linked"}

## How to work here
- Call the connector tools directly by their own names (Qargo: qargo-mcp-prod / qargo-mcp-test; Notion, Slack, Front, Lightdash, Google Drive). There are no wrapper tools: the workbench server only adds propose_steps, mark_steps, set_next_action and ask_qai. Load a tool's schema with ToolSearch when it is not loaded yet.
- Reads run at once. Every write asks the person in this session. Make the call; never ask for approval in text. On a denial: stop and say in one line what you would have done.
- Production is inspect-only unless the person explicitly asks for a production write.
- Inspect before creating anything. Never guess field names: copy the config shape from an inspected instance (internal.provisioning.inspect).
- After a write ran, test it: read it back or dry-run it, write nothing more, and list under "Tested:" what you checked and what came back.
- The setup flow is kept by the Workbench: \`propose_steps\` for a new or replaced list (a first list is approved by the person on the Workbench page; a replacement is saved at once, so update the list whenever the steps really changed), \`mark_steps\` for the state, result or name of existing steps. Never write rows in the Workbench Steps database yourself.
- Doubts the backend could settle (how a mapping, export, charge type, field or config behaves; why the TMS did something): call \`ask_qai\` (always with the tenant it is about: Qai can do nothing without the tenant link). It returns at once; Qai's answer arrives in this chat as a message a few minutes later. Do what does not depend on it, then end your turn saying you are waiting on Qai, and conclude, write to the customer or rate your certainty only after the answer is in. Say what Qai confirmed. Data you can read yourself, read yourself.
- Never put an email or Slack draft in chat text: create a Front draft in the linked thread (it asks first), or say it is ready to send.

## Step names
${rule("steps.md")}

${rule("front.md")}

${rule("data.md")}

## Qargo connector notes
${rule("qargo.md")}
`,
  );
  return dir;
}

function nowBlock(t: WbTicket) {
  const st = stepsOf(t.url);
  return `[Ticket now · status ${t.status} · tenant ${tenantOf(t) || "none"} · ${wbMode() === "auto" ? "Auto" : "Step by step"}]\nSteps: ${st.map((s) => `${s.order}. ${s.name} [${s.phase}, ${s.kind}, ${s.state}]`).join("; ") || "no step list yet"}.`;
}

/** A session that never got a message has no transcript, and resuming it fails. */
function resumable(cwd: string, id: string | null | undefined): string | undefined {
  if (!id) return undefined;
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  return existsSync(join(root, cwd.replace(/[^a-zA-Z0-9]/g, "-"), `${id}.jsonl`)) ? id : undefined;
}

function ensureSession(t: WbTicket): string {
  const ref = kv<Record<string, SessionRef>>("sessions", {})[t.url];
  const a = ref ? getAgent(ref.key) : null;
  if (a && a.status !== "ended" && a.status !== "error") return a.key;
  const cwd = prepare(t);
  const resume = resumable(cwd, a?.sessionId ?? ref?.sessionId);
  const key = startAgent({
    cwd,
    resume,
    title: `${t.customer} · ${t.task}`.slice(0, 90),
    permissionMode: wbMode() === "auto" ? "auto" : "default",
    allowedTools: ALLOWED,
    mcpServers: { workbench: workbenchTools(t.url) },
  });
  mapPut<SessionRef>("sessions", t.url, { key, sessionId: resume ?? null });
  return key;
}

// ── Waiting on Qai: its answer is checked every minute and handed to the ticket's chat ──
type QaiWait = { channel: string; ts: string; link: string | null; at: number; tenant: string; question: string };
const QAI_GIVE_UP = 60 * 60_000;
let qaiPolling = false;
async function pollQai() {
  if (qaiPolling) return;
  qaiPolling = true;
  try {
    const waits = kv<Record<string, QaiWait[]>>("qaiWait", {});
    for (const [url, list] of Object.entries(waits)) {
      const keep: QaiWait[] = [];
      for (const w of list) {
        const answer = await readQaiAnswer(w.channel, w.ts).catch(() => null);
        const t = ticketOf(url);
        if (answer && t) {
          const key = ensureSession(t);
          sendMessage(key, `Qai answered your question (tenant ${w.tenant}${w.link ? `, ${w.link}` : ""}):\n\n${answer}\n\nContinue where you left off with this answer.`, [], `Qai answered${w.link ? ` (${w.link})` : ""}:\n\n${answer}`);
        } else if (Date.now() - w.at > QAI_GIVE_UP && t) {
          sendMessage(ensureSession(t), `Qai has not answered after an hour (${w.link ?? "no link"}). Continue without its answer where you can, and say plainly what is still open.`, [], "Qai has not answered after an hour.");
        } else if (t) keep.push(w);
      }
      mapPut("qaiWait", url, keep.length ? keep : null);
    }
  } finally {
    qaiPolling = false;
  }
}
setInterval(() => void pollQai().catch(() => {}), 60_000);

// Resume (Home, sidebar) on a ticket's folder: resume it as the ticket's own session,
// with the workbench tools, instead of a plain session beside the one the Workbench knows.
onRestore((cwd, sessionId) => {
  if (dirname(cwd) !== WB_DIR) return null;
  const id = cwd.slice(WB_DIR.length + 1);
  const t = peekTickets().find((x) => x.id === id) ?? peekList("wb:tickets").find((x) => x.id === id);
  if (!t) return null;
  const ref = kv<Record<string, SessionRef>>("sessions", {})[t.url];
  const live = ref ? getAgent(ref.key) : null;
  if (live && live.status !== "ended" && live.status !== "error") return live.key;
  mapPut<SessionRef>("sessions", t.url, { key: ref?.key ?? "", sessionId });
  return ensureSession(t);
});

const PROMPTS = {
  generate: (t: WbTicket) =>
    `${nowBlock(t)}\n\nBuild the setup flow for this ticket from the sources, not from memory. 1) Read the partner playbook (the 🚦 Integration page and its Agent Documentation) and search Notion for the Generic Integration Framework building blocks that match. 2) Inspect the sandbox tenant (internal.provisioning.inspect: integration_instance list, then detail on the matching one; its routes; its mapping). 3) Call propose_steps once with 7 to 12 ordered steps: name the building block or playbook section in each check, and set state done (with what you saw in result) for every step you verified on the tenant. Then reply in three short lines: sources used, what is in place, what is next.`,
  status: (t: WbTicket) =>
    `${nowBlock(t)}\n\nGet the current status of this ticket for someone with no chat history on it. Work from the sources: 1) the engineering issue and the customer request (properties, description, comments, Log); 2) Front, as the FRONT RULE says: search this customer's threads about this integration and read the open and newer ones; then the Slack channel; 3) inspect the tenant to see what is really in place. 4) ${stepsOf(t.url).length ? "Re-evaluate the step list against what you found. Call mark_steps once with every step whose real state differs: done only when you saw it in place, and re-open a done step that has to be redone (state pending, result says why, e.g. the test file predates the new mapping). If the list no longer covers what has to happen (a new mapping round, an extra test, a step that is no longer needed), call propose_steps with the complete corrected list instead, keeping the done steps done with their results; it is saved at once." : "There is no step list: call propose_steps with 7 to 12 steps, the ones in place marked done."} 5) Call set_next_action with the one next action. Write nothing else. Reply in at most six short lines: where it stands, what happened last (who, when), what it waits on and on whom, the one next action, and a last line "Front:" with the cnv ids and the date of the latest mail.`,
  scope: (t: WbTicket) => `/professional-services:prof-svc-scoping\n\nMode A: scope this integration-request ticket: ${t.request}\n\nScoping issue: ${t.url}. Customer: ${t.customer}. Questions for the customer go into a Front draft in the linked thread (${t.front || "none linked"}), never Slack.`,
  step: (t: WbTicket, s: WbStep) =>
    `${nowBlock(t)}\n\nRun step ${s.order} "${s.name}" (${s.phase}; hint ${s.tool || "none"}; done when: ${s.check || "you judge"}) on the sandbox tenant.${s.state === "needs you" && s.result ? ` Last run you flagged it with: "${s.result}". Resolve that yourself with the tools where you can; only hand it back if a person truly has to decide or supply something, and then say exactly what.` : ""} Inspect first. If it needs a write, make the call. When it is in place and tested, call mark_steps with state done and a one-line result. If it needs the person, mark_steps with "needs you" and why. End with set_next_action for what comes after.${s.phase === "Test" ? ' This is a TEST step: actually exercise the setup (simulate a sample where a tool allows it, or drive a real test order through the External API), read the result back, and list under "Tested:" each check and what came back. Mark it done only when every check passed.' : ""}`,
};

function say(t: WbTicket, text: string, display: string): string {
  const key = ensureSession(t);
  sendMessage(key, text, [], display);
  return key;
}

function runNext(url: string, first = false): string | null {
  const t = ticketOf(url);
  const c = chains.get(url);
  if (!t || !c) return null;
  const s = nextStep(stepsOf(url));
  // A Claude step it flagged "needs you" runs again when you start it yourself (the first
  // step of a chain), but a chain never loops back onto one on its own.
  const retry = s?.state === "needs you" && s.kind !== "manual" && first;
  if (!s || s.kind === "manual" || (s.state === "needs you" && !retry) || s.state === "blocked") {
    chains.delete(url);
    return null;
  }
  c.order = s.order;
  c.busySeen = false;
  c.doneBefore = doneCount(url);
  return say(t, PROMPTS.step(t, s), `Run step ${s.order}: ${s.name}`);
}

export function wbRun(url: string, kind: "start" | "step" | "status" | "generate" | "scope" | "stop" | "chat" | "next" | "explain", order?: number): { ok: true; key: string | null } | { ok: false; error: string } {
  const t = ticketOf(url);
  if (!t) return { ok: false, error: "ticket not loaded yet" };
  if (kind === "stop") {
    const c = chains.get(url);
    if (c) c.stop = true;
    const ref = kv<Record<string, SessionRef>>("sessions", {})[url];
    if (ref) void interruptAgent(ref.key);
    chains.delete(url);
    return { ok: true, key: ref?.key ?? null };
  }
  if (kind === "chat") return { ok: true, key: ensureSession(t) };
  if (kind === "explain") {
    const s = stepsOf(url).find((x) => x.order === Number(order));
    if (!s) return { ok: false, error: "no such step" };
    return {
      ok: true,
      key: say(t, `Step ${s.order} "${s.name}" (${s.phase}, ${s.kind === "manual" ? "the person's" : "yours"}, state ${s.state}). What was recorded on it: ${s.result || "nothing yet"}.${s.check ? ` Done when: ${s.check}.` : ""}\n\nIn at most four short lines: where this step stands, what is left, and who has to act next. Use no tools unless what was recorded is missing or clearly stale.`, `About step ${s.order}: ${s.name}`),
    };
  }
  if (kind === "next") {
    const n = kv<Record<string, WbNext>>("next", {})[url];
    if (!n) return { ok: false, error: "no next action yet: Get status first" };
    if (n.who === "you") return { ok: true, key: ensureSession(t) };
    // Used up once sent; the run ends with a fresh one.
    mapPut("next", url, null);
    // Tracked like a one-step run, so Auto mode carries on to the next Claude step when it lands.
    if (!chains.has(url)) chains.set(url, { stop: false, single: true, order: null, busySeen: false, doneBefore: doneCount(url) });
    return { ok: true, key: say(t, `${nowBlock(t)}\n\n${n.prompt}\n\nWhen it is done, update the steps with mark_steps and end with set_next_action.`, n.label) };
  }
  if (kind === "status") return { ok: true, key: say(t, PROMPTS.status(t), "Get current status") };
  if (kind === "scope") {
    if (!t.request) return { ok: false, error: "no customer request linked on this scoping issue" };
    return { ok: true, key: say(t, PROMPTS.scope(t), "Run the scoping") };
  }
  if (kind === "generate" || !stepsOf(url).length) return { ok: true, key: say(t, PROMPTS.generate(t), "Generate the setup steps") };
  if (chains.has(url)) return { ok: true, key: ensureSession(t) };
  chains.set(url, { stop: false, single: kind === "step", order: null, busySeen: false, doneBefore: doneCount(url) });
  const key = runNext(url, true);
  return key ? { ok: true, key } : { ok: false, error: "the next step is yours, or the list is done" };
}

/** Called on every roster change: carries a Start chain on to its next step when a turn ends. */
export function wbOnRoster(agents: { key: string; status: string; sessionId?: string | null }[]) {
  if (!db) return;
  const sessions = kv<Record<string, SessionRef>>("sessions", {});
  let changed = false;
  for (const [url, ref] of Object.entries(sessions)) {
    const a = agents.find((x) => x.key === ref.key);
    if (!a) continue;
    if (a.sessionId && a.sessionId !== ref.sessionId) {
      ref.sessionId = a.sessionId;
      changed = true;
    }
    const c = chains.get(url);
    if (!c) continue;
    if (a.status === "thinking" || a.status === "awaiting-permission") c.busySeen = true;
    else if (a.status === "ended" || a.status === "error") chains.delete(url);
    else if (a.status === "idle" && c.busySeen) {
      // A step run counts when its own step is done; a next-action run when any step got done.
      const done = c.order !== null ? stepsOf(url).find((s) => s.order === c.order)?.state === "done" : doneCount(url) > c.doneBefore;
      if (done && !c.stop && (!c.single || wbMode() === "auto")) {
        if (!runNext(url)) chains.delete(url);
      } else chains.delete(url);
    }
  }
  if (changed) kvSet("sessions", sessions);
}

// ── hourly: has the customer answered on a ticket that is Awaiting customer? ──
export async function wbScanAwaiting(): Promise<number> {
  const rows = (await wbRows(false)).data ?? [];
  let hits = 0;
  for (const r of rows) {
    if (r.state?.k !== "customer") continue;
    // The same threads as Last contact: the Front Link (also when it links one message),
    // and the threads placed on the request. The newest email across them decides.
    const cnvs = contactThreads(r).cnv;
    if (!cnvs.length) continue;
    try {
      const reads = await Promise.all(cnvs.map((c) => readThread(c, true).then((x) => x.data).catch(() => null)));
      const last = reads
        .flatMap((th) => th?.entries ?? [])
        .filter((e) => e.kind === "message")
        .sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
        .pop();
      if (!last?.inbound || !last.at || last.at <= (r.state.at || 0)) continue;
      const prev = kv<Record<string, { at: number; who: string; ack?: boolean }>>("answered", {})[r.url];
      if (prev?.at === last.at) continue;
      mapPut("answered", r.url, { at: last.at, who: last.author });
      hits++;
    } catch {
      /* one unreadable thread does not stop the scan */
    }
  }
  kvSet("scan", { at: Date.now(), hits });
  return hits;
}

// ── Refresh: run the morning sweep's scheduled task now, as a dashboard session ──
/** The Claude desktop scheduled task that writes the sweep DM. */
const SWEEP_TASK = join(homedir(), "Claude", "Scheduled", "morning-urgency-sweep", "SKILL.md");
type SweepRun = { key: string; at: number };
export function wbSweepState(): { available: boolean; run: (SweepRun & { status: string; running: boolean }) | null } {
  const r = kv<SweepRun | null>("sweepRun", null);
  const a = r ? getAgent(r.key) : null;
  const status = a?.status ?? "ended";
  return { available: existsSync(SWEEP_TASK), run: r ? { ...r, status, running: ["thinking", "starting", "awaiting-permission"].includes(status) } : null };
}
export function wbSweepStart(): { ok: boolean; error?: string } {
  if (!existsSync(SWEEP_TASK)) return { ok: false, error: `No sweep task at ${SWEEP_TASK}.` };
  const cur = wbSweepState().run;
  if (cur?.running) return { ok: true };
  const key = startAgent({
    cwd: dirname(SWEEP_TASK),
    title: "Morning urgency sweep (refresh)",
    permissionMode: "auto",
    prompt: `Run the morning urgency sweep now, exactly as its scheduled task does: read ${SWEEP_TASK} and follow it, including the Slack DM to the user and the artifact update. The user started it from the dashboard's Refresh link; they are not watching, so do not ask questions.`,
  });
  kvSet("sweepRun", { key, at: Date.now() });
  return { ok: true };
}

// ── Morning digest: the newest "sweep" DM the user's scheduled task sent them ──
function parseSweep(raw: string): WbDigest | null {
  const blocks = raw.replace(/\r/g, "").split(/\n\n(?=[^\n]{1,80}<[^>\n]*@[^>\n]*>: )/);
  const blk = blocks.find((b) => /\bsweep\b/i.test(b.slice(0, 400)));
  if (!blk) return null;
  let txt = blk.replace(/^[\s\S]*?(?:Channel:[^\n]*\n+)?[^\n]{0,80}<[^>\n]*@[^>\n]*>: /, "");
  const tm = /\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2})(?::\d{2})?[^\]]*\]\s*$/.exec(txt);
  if (tm) txt = txt.slice(0, tm.index);
  txt = txt.replace(/\*Sent using\*[^\n]*$/m, "").trim();
  const links = (x: string) => [...x.matchAll(/<(https?:[^|>\s]+)(?:\|([^>]*))?>/g)].map((m) => ({ url: m[1]!, label: m[2] ?? "" }));
  const strip = (x: string) => x.replace(/<(https?:[^|>\s]+)(?:\|([^>]*))?>/g, "").replace(/<@[^>]+>/g, "").replace(/\s{2,}/g, " ").trim();
  const lines = txt.split("\n");
  const head = lines.shift() ?? "";
  // Two header shapes: "_Morning sweep_ — lead" and "*Morning sweep, deep mode. 5 things that need you today.*".
  const bare = head.replace(/^[*_\s]+|[*_\s]+$/g, "");
  const bm = /^\*/.test(head.trim()) ? /^([^.,:—]+)(?:,[^.]*)?\.\s*(.*)$/.exec(bare) : null;
  const hm = bm ?? /^_?([^_—]*?)_?\s*(?:—|--|:)\s*(.*)$/.exec(head);
  const title = strip((hm ? hm[1]! : head).replace(/[_*]/g, ""));
  let lead = hm ? strip(hm[2]!).replace(/[:.]$/, "") : "";
  const items: { n: number; raw: string }[] = [];
  const notes: string[] = [];
  let full = "";
  let cur: { n: number; raw: string } | null = null;
  for (const l of lines) {
    const m = /^\s*(\d+)[.)]\s+(.+)$/.exec(l);
    if (m) {
      cur = { n: Number(m[1]), raw: m[2]! };
      items.push(cur);
    } else if (/^\s*also\s*:/i.test(l)) {
      cur = null;
      notes.push(strip(l.replace(/^\s*also\s*:\s*/i, "")));
    } else if (/full picture/i.test(l)) {
      cur = null;
      full = links(l).find((x) => /artifact/.test(x.url))?.url ?? full;
    } else if (!l.trim()) cur = null;
    else if (cur) cur.raw += " " + l.trim();
    else if (!items.length && !lead) lead = strip(l);
    else if (items.length) notes.push(strip(l));
  }
  const all = peekTickets();
  return {
    title,
    lead: lead.charAt(0).toUpperCase() + lead.slice(1),
    mode: /deep/i.test(head) ? "deep" : /light/i.test(head) ? "light" : "",
    date: tm?.[1] ?? "",
    time: tm?.[2] ?? "",
    notes: notes.filter(Boolean),
    full,
    items: items.slice(0, 5).map((it) => {
      const ls = links(it.raw);
      let body = strip(it.raw);
      const t2 = /^_([^_]+)_\s*/.exec(body) ?? /^\*([^*]+)\*\s*/.exec(body);
      const itemTitle = t2 ? t2[1]!.trim().replace(/\.$/, "") : body.split(/\s—\s|\. /)[0]!.slice(0, 80);
      if (t2) body = body.slice(t2[0].length);
      const pm = /^\(([^)]{2,60})\)\s*/.exec(body);
      if (pm) body = body.slice(pm[0].length);
      body = body.replace(/^(—|--|-|:)\s*/, "");
      // A quote counts as the customer's words only when a name stands right before it.
      const qm = /\b([A-Z][a-z]+(?: [A-Z][a-z]+)?):\s*_?["“]([^"”]{8,})["”]_?/.exec(body);
      if (qm) body = (body.slice(0, qm.index) + " " + body.slice(qm.index + qm[0].length)).replace(/\s{2,}/g, " ").trim();
      const ids = ls.map((l) => l.url.match(/cnv_[a-z0-9]+/i)?.[0]).filter(Boolean);
      const pages = ls.filter((l) => /notion/.test(l.url)).map((l) => pageId(l.url)).filter(Boolean);
      const hit = all.find((t) => pages.includes(t.id) || pages.includes(pageId(t.request))) ?? all.find((t) => ids.some((id) => t.front.includes(id!))) ?? all.find((t) => t.customer.length > 3 && itemTitle.toLowerCase().includes(t.customer.toLowerCase().split(/\s+/)[0]!));
      return { n: it.n, title: itemTitle, meta: pm?.[1] ?? "", text: body.replace(/^[.,;:\s]+|[:;,·\s]+$/g, ""), quote: qm?.[2]?.trim() ?? "", who: qm?.[1] ?? "", links: ls, ticketUrl: hit?.url ?? null };
    }),
  };
}

export const wbDigest = (refresh: boolean) =>
  cached<WbDigest | null>(
    "wb:digest",
    refresh,
    async () => {
      // The sweep lands in the user's own notes channel: read that first, search only if it is not there.
      try {
        let me = kv<string>("slackMe", "");
        if (!me) {
          me = (await connectorCall(SLACK_PROFILE, {}, "Find the user's own Slack id, to read the morning sweep they sent themselves.")).match(/\bU[A-Z0-9]{8,12}\b/)?.[0] ?? "";
          if (me) kvSet("slackMe", me);
        }
        if (me) {
          const rawDm = await connectorCall(SLACK_READ, { channel_id: me, limit: 25, response_format: "concise" }, "Read the newest morning urgency sweep in the user's own notes channel, for the Workbench digest.");
          const pd = parseJson(rawDm);
          const d = parseSweep(typeof pd?.messages === "string" ? pd.messages : typeof pd?.results === "string" ? pd.results : rawDm);
          if (d) return d;
        }
      } catch (e) {
        console.warn("[wb] notes channel read failed, falling back to search:", e instanceof Error ? e.message : e);
      }
      const raw = await connectorCall(SLACK_SEARCH, { keywords: ["sweep"], filters: "is:dm from:me", natural_language_query: "", sort: "timestamp", limit: 3, include_context: false, response_format: "detailed" }, "Read the newest morning urgency sweep the user's scheduled task sent them, for the Workbench digest.");
      const p = parseJson(raw);
      const text = typeof p?.results === "string" ? p.results : typeof p?.messages === "string" ? p.messages : raw;
      const k = text.search(/\bsweep\b/i);
      if (k < 0) return null;
      return parseSweep("x <a@b>: " + text.slice(Math.max(0, text.lastIndexOf("\n", k) + 1)).replace(/^[^_A-Za-z]*/, ""));
    },
    30 * 60_000,
    { swr: true },
  );

// ── routes ────────────────────────────────────────────────────────────────────
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleWbRoute(req: Request, url: URL): Promise<Response | null> {
  const p = url.pathname;
  if (!p.startsWith("/api/ba/wb/")) return null;
  const refresh = url.searchParams.get("refresh") === "1";
  const b = req.method === "POST" ? ((await req.json().catch(() => ({}))) as Record<string, any>) : {};
  const u = String(b.url ?? "");

  if (p === "/api/ba/wb/rows") return json(await wbRows(refresh));
  if (p === "/api/ba/wb/digest") return json({ ...(await wbDigest(refresh)), scan: kv("scan", null), sweep: wbSweepState() });
  if (p === "/api/ba/wb/sweep") return json(req.method === "POST" ? wbSweepStart() : wbSweepState());
  if (p === "/api/ba/wb/viewas" && req.method === "GET") return json({ viewAs: wbViewAs(), people: url.searchParams.get("q") ? await findPeople(url.searchParams.get("q")!).catch(() => []) : [] });
  if (req.method !== "POST") return null;

  if (p === "/api/ba/wb/front-search") return json(await wbFrontSearch(u).catch((e) => ({ threads: [], query: "", projectId: null, error: String(e?.message ?? e) })));
  if (p === "/api/ba/wb/front-use") return json(await wbFrontUse(u, b.thread as BaFrontThread));
  if (p === "/api/ba/wb/front-dismiss") return json(wbFrontDismiss(u));
  if (p === "/api/ba/wb/viewas") {
    const v = b.viewAs as WbViewAs | null;
    kvSet("viewAs", v && /^[0-9a-f-]{32,36}$/i.test(v.id) ? { id: v.id, name: String(v.name).slice(0, 80), email: v.email ?? null } : null);
    // A person viewed before shows at once (their saved list, refreshed in the background);
    // a first view waits for Notion.
    if (peekTickets().length) void tickets(true).catch(() => null);
    else await tickets(true).catch(() => null);
    return json({ viewAs: wbViewAs() });
  }
  if (p === "/api/ba/wb/pin") return json({ pins: mapPut("pins", u, b.on ? Date.now() : null) });
  if (p === "/api/ba/wb/mode") {
    kvSet("mode", b.mode === "auto" ? "auto" : "step");
    return json({ mode: wbMode() });
  }
  if (p === "/api/ba/wb/state") {
    mapPut("state", u, b.k ? { k: b.k as WbStateKey, at: Date.now() } : null);
    const ans = kv<Record<string, { at: number; who: string; ack?: boolean }>>("answered", {})[u];
    if (ans) mapPut("answered", u, b.k ? null : { ...ans, ack: true });
    return json({ ok: true });
  }
  if (p === "/api/ba/wb/status") {
    if (!ticketOf(u) || !b.status) return json({ error: "unknown ticket or status" }, 400);
    await notionUpdate(u, { Status: String(b.status) }, "Change the status of an engineering issue the user picked in the Workbench.");
    // Show it at once; the next Notion read confirms it.
    const list = peekTickets().map((t) => (t.url === u ? { ...t, status: String(b.status), stage: stageOf({ status: String(b.status), reqStatus: t.reqStatus }) } : t));
    db.query("UPDATE ba_cache SET json = ? WHERE key = ?").run(JSON.stringify(list), ticketsKey());
    return json({ ok: true });
  }
  if (p === "/api/ba/wb/run") {
    const r = wbRun(u, b.kind, b.order);
    return json(r, r.ok ? 200 : 400);
  }
  if (p === "/api/ba/wb/proposal") {
    if (b.approve) return json({ ok: await approveProposal(u) });
    mapPut("proposals", u, null);
    return json({ ok: true });
  }
  if (p === "/api/ba/wb/step") return json({ ok: await setStepState(u, Number(b.order), b.state) });
  if (p === "/api/ba/wb/scan") return json({ hits: await wbScanAwaiting() });
  return null;
}

