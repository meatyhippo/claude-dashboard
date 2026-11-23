import type { Database } from "bun:sqlite";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { BaMailThread, BaRequirement, BaSavedFiles } from "../shared/baCustomers.ts";
import { connectorBatch, connectorCall, parseJson, peekCache } from "./baConnector.ts";
import { ensureProjectFolder } from "./workspaces.ts";

/**
 * BA edition: a placed mail's attachments, saved into the customer's folder.
 *
 * On an integration ticket they go to `tickets/<ticket>/attachments/`, otherwise to
 * `mail/<date> <subject>/`. Inline signature images are skipped, and a file is
 * never fetched twice (by its Front id). Front hands out a short-lived download
 * link per attachment; the file itself is fetched from that link.
 */

const GET = "mcp__claude_ai_Front__get_attachment";
let db: Database;

export function initAttachments(database: Database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS ba_attachments (file_id TEXT PRIMARY KEY, project_id INTEGER NOT NULL, thread_id TEXT, path TEXT NOT NULL, saved_at INTEGER NOT NULL);`);
}

/** Inline images in signatures and pasted screenshots under 15 KB: not worth a file. */
const isInline = (f: { name: string; size: number | null; type: string | null }) =>
  /^(image|outlook|logo)[-_ ]?\d*\.(png|jpe?g|gif|bmp)$/i.test(f.name) || (/^image\//.test(f.type ?? "") && (f.size ?? 0) > 0 && (f.size ?? 0) < 15_000);

const safe = (s: string, max = 60) =>
  s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[\\/:*?"<>|\r\n\t]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max)
    .replace(/[. ]+$/, "") || "untitled";

/** A free name in `dir`: "spec.pdf", then "spec (2).pdf". */
function freeName(dir: string, name: string): string {
  if (!existsSync(join(dir, name))) return name;
  const dot = name.lastIndexOf(".");
  const [base, ext] = dot > 0 ? [name.slice(0, dot), name.slice(dot)] : [name, ""];
  for (let i = 2; i < 100; i++) if (!existsSync(join(dir, `${base} (${i})${ext}`))) return `${base} (${i})${ext}`;
  return `${base} ${Date.now()}${ext}`;
}

const inFlight = new Set<string>();

let lastError: string | null = null;
/** After Front refuses for lack of permission, wait before asking again instead of retrying on every read. */
let blockedUntil = 0;
export const attachmentError = () => lastError;

export async function saveAttachments(threadId: string, projectId: number, irUrl: string | null): Promise<BaSavedFiles> {
  if (inFlight.has(threadId)) return null;
  if (Date.now() < blockedUntil) return null;
  const th = peekCache<BaMailThread>(`thread:${threadId}`);
  const folder = ensureProjectFolder(projectId);
  if (!th || !folder) return null;
  const files = th.entries.flatMap((e) => (e.kind === "message" ? (e.files ?? []).map((f) => ({ ...f, at: e.at })) : []));
  const done = new Set(db.query<{ file_id: string }, []>("SELECT file_id FROM ba_attachments").all().map((r) => r.file_id));
  const todo = files.filter((f) => !done.has(f.id) && !isInline(f));
  const skipped = files.length - todo.length;

  const ir = irUrl ? (peekCache<BaRequirement[]>(`p${projectId}:requirements`) ?? []).find((r) => r.url === irUrl) : null;
  const first = th.entries.find((e) => e.kind === "message")?.at ?? Date.now();
  const dir = ir ? join(folder, "tickets", safe(ir.title), "attachments") : join(folder, "mail", `${new Date(first).toISOString().slice(0, 10)} ${safe(th.subject.replace(/^(re|fw|fwd|aw|tr|antw)\s*:\s*/gi, ""))}`);
  if (!todo.length) return { dir, saved: [], skipped };

  inFlight.add(threadId);
  lastError = null;
  const saved: string[] = [];
  try {
    for (let i = 0; i < todo.length; i += 10) {
      const chunk = todo.slice(i, i + 10);
      const links = await connectorBatch(GET, chunk.map((f) => ({ attachmentId: f.id, reason: "Saves a mail attachment into the customer's folder, as the user set up." })), (x) => x.attachmentId, "Get download links for mail attachments.");
      if (links.size === 0) {
        // A batch drops errors; one direct call says why (a missing Front permission, usually).
        await connectorCall(GET, { attachmentId: chunk[0]!.id, reason: "Saves a mail attachment into the customer's folder, as the user set up." }, "Get one download link.").catch((e) => {
          const denied = /attachments:read|not authorized for attachments/i.test(String(e));
          if (denied) blockedUntil = Date.now() + 30 * 60_000;
          lastError = denied
            ? "Front has not given Claude permission to read attachments. In claude.ai → Settings → Connectors, disconnect Front, connect it again and approve “Attachments (Read)”."
            : String(e).replace(/^Error:\s*(haiku|sonnet):\s*/i, "").slice(0, 300);
        });
        break;
      }
      for (const f of chunk) {
        const raw = links.get(f.id);
        const url = raw ? (parseJson(raw)?.downloadUrl ?? parseJson(raw)?.download_url ?? raw.match(/https:\/\/\S+/)?.[0]) : null;
        if (!url) {
          console.warn(`attachment ${f.id}: no download link (${raw ? "unexpected answer" : "no answer"})`);
          continue;
        }
        const res = await fetch(url).catch((e) => (console.warn(`attachment ${f.id}: fetch failed`, String(e)), null));
        if (!res?.ok) {
          console.warn(`attachment ${f.id}: download returned ${res?.status}`);
          continue;
        }
        const bytes = new Uint8Array(await res.arrayBuffer());
        mkdirSync(dir, { recursive: true });
        const name = freeName(dir, safe(f.name, 120));
        writeFileSync(join(dir, name), bytes);
        db.query("INSERT OR REPLACE INTO ba_attachments (file_id, project_id, thread_id, path, saved_at) VALUES (?, ?, ?, ?, ?)").run(f.id, projectId, threadId, join(dir, name), Date.now());
        saved.push(name);
      }
    }
  } finally {
    inFlight.delete(threadId);
  }
  return { dir, saved, skipped };
}

/** What has been saved for a thread, for the reading pane. */
export function savedFor(threadId: string): { dir: string | null; files: string[] } {
  const rows = db.query<{ path: string }, [string]>("SELECT path FROM ba_attachments WHERE thread_id = ? ORDER BY saved_at").all(threadId).filter((r) => existsSync(r.path) && statSync(r.path).isFile());
  return { dir: rows[0] ? rows[0].path.slice(0, rows[0].path.lastIndexOf("/")) : null, files: rows.map((r) => r.path.slice(r.path.lastIndexOf("/") + 1)) };
}
