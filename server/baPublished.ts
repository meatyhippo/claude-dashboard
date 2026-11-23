import type { Database } from "bun:sqlite";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { groupName, type BaCustomer, type BaPublished } from "../shared/baCustomers.ts";
import { listArtifacts } from "./artifacts.ts";
import { artifactsDir, DATA_DIR } from "./paths.ts";

/**
 * Published claude.ai artifacts, linked to the dashboard's local ones and to customers.
 *
 * Two sources, merged by URL:
 * - Transcripts. Every Artifact publish a Claude Code session made is in its
 *   transcript, with the local file and the claude.ai URL it got. That needs no
 *   connector and covers everything published from this machine.
 * - A snapshot, `published-artifacts.json` in the dashboard's data folder, for
 *   what transcripts cannot know: titles of pages published from claude.ai on the
 *   web, and pages others shared with you. Any Claude Code session can refresh it
 *   ("refresh my published artifacts list for the dashboard"), since the Artifact
 *   tool exists there and not in the daemon's background calls.
 */

const PROJECTS_DIR = join(homedir(), ".claude", "projects");
export const SNAPSHOT_PATH = join(DATA_DIR, "published-artifacts.json");
const URL_RE = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/;

type Found = { url: string; localPath: string | null; at: number };
const scanned = new Map<string, { mtime: number; found: Found[] }>();

function* transcripts(dir: string): Generator<string> {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let st;
    try {
      st = statSync(p);
    } catch {
      continue;
    }
    if (st.isDirectory()) yield* transcripts(p);
    else if (e.endsWith(".jsonl")) yield p;
  }
}

/** Artifact publishes recorded in one transcript, re-read only when the file changed. */
function scanFile(path: string): Found[] {
  const mtime = statSync(path).mtimeMs;
  const hit = scanned.get(path);
  if (hit && hit.mtime === mtime) return hit.found;
  const found: Found[] = [];
  const text = readFileSync(path, "utf8");
  if (text.includes('"name":"Artifact"')) {
    const uses = new Map<string, { file_path?: string; url?: string; action?: string; asset?: boolean }>();
    for (const line of text.split("\n")) {
      if (!line.includes("Artifact") && !line.includes("tool_result")) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const content = m?.message?.content;
      if (!Array.isArray(content)) continue;
      for (const c of content) {
        if (c?.type === "tool_use" && c.name === "Artifact") uses.set(c.id, c.input ?? {});
        if (c?.type === "tool_result" && uses.has(c.tool_use_id)) {
          const input = uses.get(c.tool_use_id)!;
          if ((input.action ?? "publish") !== "publish" || input.asset) continue;
          const out = typeof c.content === "string" ? c.content : (c.content ?? []).map((x: any) => x?.text ?? "").join(" ");
          const url = out.match(URL_RE)?.[0] ?? (/^Published/.test(out) ? input.url : undefined);
          if (url && !c.is_error) found.push({ url, localPath: input.file_path ?? null, at: Date.parse(m.timestamp ?? "") || mtime });
        }
      }
    }
  }
  scanned.set(path, { mtime, found });
  return found;
}

type Snapshot = { title: string; url: string; owner?: "mine" | "shared"; updated?: string | null; localPath?: string; kind?: string }[];

function readSnapshot(): Snapshot {
  try {
    return existsSync(SNAPSHOT_PATH) ? (JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Snapshot) : [];
  } catch {
    return [];
  }
}

const titleOf = (file: string | null): string | null => {
  if (!file || !existsSync(file)) return null;
  try {
    const html = readFileSync(file, "utf8").slice(0, 20_000);
    return html.match(/<title>([^<]+)<\/title>/i)?.[1]?.trim() ?? html.match(/<h1[^>]*>([^<]+)<\/h1>/i)?.[1]?.trim() ?? null;
  } catch {
    return null;
  }
};

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

export function publishedArtifacts(db: Database, customers: BaCustomer[]): BaPublished[] {
  const byUrl = new Map<string, Found>();
  for (const t of transcripts(PROJECTS_DIR)) {
    for (const f of scanFile(t)) {
      const prev = byUrl.get(f.url);
      if (!prev || prev.at < f.at) byUrl.set(f.url, f);
    }
  }
  const snap = new Map(readSnapshot().map((s) => [s.url, s]));
  const urls = new Set([...byUrl.keys(), ...snap.keys()]);

  const local = listArtifacts(db);
  const root = resolve(artifactsDir());
  const localByPath = new Map(local.map((a) => [resolve(root, a.entry), a.slug]));
  const localByTitle = new Map(local.map((a) => [norm(a.title), a.slug]));
  const names = customers.map((c) => ({ id: c.projectId, names: [...new Set([c.name, ...c.deals.map((d) => groupName(d.name))].map(norm).filter((n) => n.length >= 4))] }));

  const out: BaPublished[] = [];
  for (const url of urls) {
    const f = byUrl.get(url);
    const s = snap.get(url);
    const localPath = (s?.localPath && existsSync(s.localPath) ? s.localPath : null) ?? (f?.localPath && existsSync(f.localPath) ? f.localPath : null);
    const title = s?.title ?? titleOf(localPath) ?? (localPath ? basename(dirname(localPath)) : "Untitled artifact");
    const t = ` ${norm(title)} `;
    out.push({
      url,
      title,
      owner: s?.owner ?? "mine",
      updated: s?.updated ?? (f ? new Date(f.at).toISOString().slice(0, 10) : null),
      localPath,
      localSlug: (localPath && localByPath.get(resolve(localPath))) || localByTitle.get(norm(title)) || null,
      projectIds: names.filter((c) => c.names.some((n) => t.includes(` ${n} `))).map((c) => c.id),
      kind: s?.kind ?? "html",
    });
  }
  return out.sort((a, b) => (b.updated ?? "").localeCompare(a.updated ?? ""));
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handlePublishedRoute(req: Request, url: URL, db: Database, customers: () => BaCustomer[]): Promise<Response | null> {
  if (url.pathname !== "/api/ba/published") return null;
  if (req.method === "PUT") {
    // A Claude Code session (which has the Artifact tool) can post a fresh list here.
    const body = (await req.json().catch(() => null)) as Snapshot | null;
    if (!Array.isArray(body)) return json({ error: "a list of { title, url, owner, updated } is required" }, 400);
    writeFileSync(SNAPSHOT_PATH, JSON.stringify(body.filter((x) => x?.url && x?.title), null, 2));
  }
  return json({ published: publishedArtifacts(db, customers()), snapshot: SNAPSHOT_PATH });
}
