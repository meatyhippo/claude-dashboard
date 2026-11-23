import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { BaCustomer, BaFrontThread, BaTriageThread } from "../shared/baCustomers.ts";
import { PROJECTS_DIR } from "./paths.ts";
import { ensureProjectFolder } from "./workspaces.ts";

/**
 * BA edition: what a session works on, for the pane beside the chat. The mail,
 * the integration request and the customer's folder, recorded when the dashboard
 * starts the session; for a session started elsewhere, read from the start of
 * its transcript (the Front and Notion links in its first prompt, and its folder).
 */

let db: Database;

export function initSessionContext(database: Database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ba_session_links (
      agent_key   TEXT PRIMARY KEY,
      project_id  INTEGER,
      thread_id   TEXT,
      ir_url      TEXT,
      created_at  INTEGER NOT NULL
    );
  `);
}

export function recordSessionLink(agentKey: string, link: { projectId?: number | null; threadId?: string | null; irUrl?: string | null }) {
  db.query("INSERT OR REPLACE INTO ba_session_links (agent_key, project_id, thread_id, ir_url, created_at) VALUES (?, ?, ?, ?, ?)").run(
    agentKey,
    link.projectId ?? null,
    link.threadId ?? null,
    link.irUrl ?? null,
    Date.now(),
  );
}

export const threadIdIn = (s: string | null | undefined) => s?.match(/cnv_[A-Za-z0-9]+/)?.[0] ?? null;
const NOTION_IR = /Integration request \(Notion\): (https:\/\/[^\s)]+)/;

/** The first prompt and the folder of a session, from its transcript. */
function transcriptStart(sessionId: string): { prompt: string; cwd: string | null } | null {
  if (!/^[\w-]{8,}$/.test(sessionId)) return null;
  for (const d of readdirSync(PROJECTS_DIR)) {
    const f = join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    if (!existsSync(f)) continue;
    let cwd: string | null = null;
    for (const line of readFileSync(f, "utf8").split("\n").slice(0, 60)) {
      try {
        const j = JSON.parse(line);
        cwd ??= j.cwd ?? null;
        const c = j.type === "user" ? j.message?.content : null;
        const text = typeof c === "string" ? c : Array.isArray(c) ? c.map((b: { text?: string }) => b.text ?? "").join("\n") : "";
        if (text.trim()) return { prompt: text, cwd };
      } catch {
        /* a partial line at the end of a live transcript */
      }
    }
    return { prompt: "", cwd };
  }
  return null;
}

export type SessionContext = {
  projectId: number | null;
  customer: string | null;
  folder: string | null;
  thread: BaTriageThread | null;
  irUrl: string | null;
  irTitle: string | null;
};

export function sessionContext(
  q: { agentKey?: string | null; sessionId?: string | null; cwd?: string | null },
  deps: {
    customers: () => BaCustomer[];
    placement: (threadId: string) => { projectId: number; irUrl: string | null } | null;
    threadJson: (threadId: string) => BaFrontThread | null;
    irTitle: (projectId: number, irUrl: string) => string | null;
  },
): SessionContext {
  const rec = q.agentKey ? db.query<{ project_id: number | null; thread_id: string | null; ir_url: string | null }, [string]>("SELECT project_id, thread_id, ir_url FROM ba_session_links WHERE agent_key = ?").get(q.agentKey) : null;
  const ir = q.agentKey && !rec ? db.query<{ project_id: number | null; ir_url: string }, [string]>("SELECT project_id, ir_url FROM ba_ir_sessions WHERE agent_key = ? LIMIT 1").get(q.agentKey) : null;
  const start = !rec && q.sessionId ? transcriptStart(q.sessionId) : null;

  const threadId = rec?.thread_id ?? threadIdIn(start?.prompt);
  const placed = threadId ? deps.placement(threadId) : null;
  const irUrl = rec?.ir_url ?? ir?.ir_url ?? start?.prompt.match(NOTION_IR)?.[1] ?? placed?.irUrl ?? null;
  const cwd = q.cwd ?? start?.cwd ?? null;
  const customers = deps.customers();
  const byFolder = cwd ? customers.find((c) => { const f = ensureProjectFolder(c.projectId); return !!f && (cwd === f || cwd.startsWith(`${f}/`)); }) : undefined;
  const projectId = rec?.project_id ?? ir?.project_id ?? placed?.projectId ?? byFolder?.projectId ?? null;
  const customer = customers.find((c) => c.projectId === projectId) ?? null;

  let thread: BaTriageThread | null = null;
  if (threadId) {
    const known = deps.threadJson(threadId);
    const base: BaFrontThread = known ?? { id: threadId, subject: "Front conversation", status: null, from: null, emails: [], assignee: null, tags: [], snippet: null, updatedAt: null, link: `https://app.frontapp.com/open/${threadId}` };
    thread = { ...base, link_: placed ? { threadId, projectId: placed.projectId, irUrl: placed.irUrl, source: "manual", linkedAt: 0 } : null, suggestion: null };
  }
  return {
    projectId,
    customer: customer?.name ?? null,
    folder: (projectId && ensureProjectFolder(projectId)) || cwd,
    thread,
    irUrl,
    irTitle: irUrl && projectId ? deps.irTitle(projectId, irUrl) : null,
  };
}
