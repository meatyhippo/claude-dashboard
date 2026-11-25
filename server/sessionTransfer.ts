import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, platform, userInfo } from "node:os";
import { join, relative, sep } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { CLAUDE_HOME, DATA_DIR, PROJECTS_DIR } from "./paths.ts";

/**
 * Hand a session to a colleague: export it as one file, send it however you like
 * (Slack, in practice), and import it on their machine, where it resumes with its
 * whole history under their own login.
 *
 * A session is more than its transcript. Claude Code stores large tool output —
 * a Notion page, a Front thread, a screenshot from an MCP tool — as files beside
 * it, under `<id>/tool-results/`, and the transcript points at them by absolute
 * path; subagent transcripts live under `<id>/subagents/`. All of it travels, and
 * every path that names the sender's machine is rewritten to the recipient's.
 *
 * The format is gzipped JSON, so it needs no archiver on either side and can be
 * read with `gunzip -c` when someone wants to see what they were sent.
 */

export const FORMAT = "claude-dashboard-session";
export const FORMAT_VERSION = 1;
export const EXT = ".claudesession";

/**
 * Records kept without a uuid. Everything with a uuid stays, because the
 * conversation is a chain of parentUuid links and dropping a link (a compaction
 * boundary is a `system` record) would cut the history short on resume.
 *
 * What goes is bookkeeping: raw API request copies (the bulk of the file, and a
 * second copy of everything), account and organisation ids, cost counters, queue
 * and file-history state. A resume was tested without them.
 */
const KEEP_WITHOUT_UUID = new Set([
  "ai-title",
  "custom-title",
  "summary",
  "last-prompt",
  "mode",
  "permission-mode",
  "agent-name",
  "agent-setting",
]);

const SECRET_PATTERNS: { label: string; re: RegExp }[] = [
  { label: "Anthropic API key", re: /sk-ant-[A-Za-z0-9_-]{10,}/g },
  { label: "Google API key", re: /AIza[A-Za-z0-9_-]{20,}/g },
  { label: "Slack token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { label: "GitHub token", re: /gh[pousr]_[A-Za-z0-9]{20,}/g },
  { label: "Private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { label: "AWS access key", re: /AKIA[0-9A-Z]{16}/g },
  { label: "Bearer token", re: /Bearer [A-Za-z0-9._~+/-]{24,}=*/g },
  { label: "Google Chat webhook", re: /chat\.googleapis\.com\/v1\/spaces\/[A-Za-z0-9_-]+\/messages\?key=/g },
];

/** Past this, the bundle is still made, but the preview says so. */
const LARGE_BYTES = 50 * 1024 * 1024;

/**
 * The largest file that can be handed over: the import route takes it in one
 * request, and index.ts sets the server's request limit to this.
 */
export const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

const utf8 = new TextDecoder("utf-8", { fatal: true });

/**
 * A file's text, or null for binary. Whatever reads as text, whatever its name
 * (.yaml, .log, .env, none), is scanned for credentials on export and has its
 * paths rewritten on import.
 */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return utf8.decode(bytes);
  } catch {
    return null;
  }
}

export type Manifest = {
  title: string | null;
  sessionId: string;
  exportedAt: string;
  exportedBy: string;
  cliVersion: string | null;
  cwd: string | null;
  home: string;
  profile: string;
  sessionDir: string;
  messages: number;
  mcpServers: string[];
};

type Bundle = {
  format: typeof FORMAT;
  version: number;
  manifest: Manifest;
  transcript: string;
  /** Relative to the session's own folder, e.g. `tool-results/x.png`. Base64. */
  files: Record<string, string>;
};

export type ExportPreview = {
  /** Names the exact file this preview describes; Save and Send use that file, never a newer one. */
  token: string;
  title: string | null;
  messages: number;
  mcpServers: string[];
  files: number;
  bytes: number;
  large: boolean;
  /** Over MAX_BUNDLE_BYTES: it could not be imported, so it is not offered. */
  tooLarge: boolean;
  secrets: { label: string; count: number }[];
};

/** Claude Code's folder name for a cwd: every character outside [A-Za-z0-9] becomes `-`. */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

function findTranscript(sessionId: string): string | null {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId)) return null;
  let dirs: string[];
  try {
    dirs = readdirSync(PROJECTS_DIR);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = join(PROJECTS_DIR, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

function stripJsonl(text: string): string {
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let o: { type?: string; uuid?: string };
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.uuid || (o.type && KEEP_WITHOUT_UUID.has(o.type))) out.push(line);
  }
  return out.join("\n") + "\n";
}

function walk(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const p = join(dir, name);
    let st;
    try {
      st = lstatSync(p);
    } catch {
      continue; // deleted while we looked
    }
    // Links are skipped: one can point anywhere (~/.ssh) or back up the tree.
    if (st.isSymbolicLink()) continue;
    if (st.isDirectory()) out.push(...walk(p));
    else if (st.isFile()) out.push(p);
  }
  return out;
}

function describe(transcript: string) {
  let title: string | null = null;
  let customTitle: string | null = null;
  let cliVersion: string | null = null;
  let cwd: string | null = null;
  let messages = 0;
  const servers = new Set<string>();
  for (const line of transcript.split("\n")) {
    if (!line) continue;
    let o: Record<string, unknown>;
    try {
      o = JSON.parse(line);
    } catch {
      continue;
    }
    if (o.type === "ai-title" && typeof o.aiTitle === "string") title = o.aiTitle;
    if (o.type === "custom-title" && typeof o.customTitle === "string") customTitle = o.customTitle;
    if (typeof o.version === "string") cliVersion = o.version;
    if (typeof o.cwd === "string") cwd = o.cwd;
    if (o.type === "user" || o.type === "assistant") messages++;
    const content = (o.message as { content?: unknown } | undefined)?.content;
    if (Array.isArray(content)) {
      for (const c of content as { type?: string; name?: string }[]) {
        if (c.type !== "tool_use" || typeof c.name !== "string" || !c.name.startsWith("mcp__")) continue;
        // mcp__claude_ai_Notion__notion-fetch → Notion; mcp__plugin_x_server__tool → server
        const server = c.name.split("__")[1] ?? "";
        servers.add(server.replace(/^claude_ai_/, "").replace(/^plugin_[^_]+_/, "").replace(/_/g, " "));
      }
    }
  }
  return { title: customTitle ?? title, cliVersion, cwd, messages, mcpServers: [...servers].sort() };
}

function scanSecrets(texts: string[]): { label: string; count: number }[] {
  const hits: { label: string; count: number }[] = [];
  for (const { label, re } of SECRET_PATTERNS) {
    let count = 0;
    for (const t of texts) count += t.match(re)?.length ?? 0;
    if (count > 0) hits.push({ label, count });
  }
  return hits;
}

function build(sessionId: string): { bundle: Bundle; texts: string[] } | null {
  const file = findTranscript(sessionId);
  if (!file) return null;
  const transcript = stripJsonl(readFileSync(file, "utf8"));
  const sessionDir = file.slice(0, -".jsonl".length);
  const files: Record<string, string> = {};
  const texts = [transcript];
  for (const p of walk(sessionDir)) {
    const rel = relative(sessionDir, p).split(sep).join("/");
    let bytes: Buffer;
    try {
      bytes = readFileSync(p);
    } catch {
      continue; // unreadable or gone: the session resumes without it
    }
    if (rel.endsWith(".jsonl")) {
      const text = stripJsonl(bytes.toString("utf8"));
      texts.push(text);
      bytes = Buffer.from(text, "utf8");
    } else {
      const text = asText(bytes);
      if (text !== null) texts.push(text);
    }
    files[rel] = bytes.toString("base64");
  }
  const d = describe(transcript);
  return {
    texts,
    bundle: {
      format: FORMAT,
      version: FORMAT_VERSION,
      manifest: {
        title: d.title,
        sessionId,
        exportedAt: new Date().toISOString(),
        exportedBy: userInfo().username,
        cliVersion: d.cliVersion,
        cwd: d.cwd,
        home: homedir(),
        profile: CLAUDE_HOME,
        sessionDir,
        messages: d.messages,
        mcpServers: d.mcpServers,
      },
      transcript,
      files,
    },
  };
}

function fileStem(title: string | null, sessionId: string): string {
  const words = (title ?? "session")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${words || "session"}-${sessionId.slice(0, 8)}`;
}

export type PreparedFile = {
  name: string;
  title: string | null;
  bytes: Uint8Array<ArrayBuffer>;
  /** Credentials the preview found. Sending needs the user's acknowledgement when above zero. */
  secrets: number;
};

/** Why a prepared file cannot be used; `expired` is the only one a fresh preview fixes. */
export class PreparedFileError extends Error {
  constructor(
    message: string,
    readonly reason: "expired" | "needs-ack",
  ) {
    super(message);
  }
}

/**
 * Files made for a preview, by token. The credential check and its
 * acknowledgement are about these exact bytes, so Save and Send use them rather
 * than reading the session again: a live session may have read a secret since.
 */
const prepared = new Map<string, PreparedFile & { at: number }>();
const PREPARED_TTL_MS = 60 * 60_000;
const PREPARED_MAX = 3;

export function previewExport(sessionId: string): ExportPreview | null {
  const b = build(sessionId);
  if (!b) return null;
  const bytes = new Uint8Array(gzipSync(JSON.stringify(b.bundle)));
  const tooLarge = bytes.length > MAX_BUNDLE_BYTES;
  const secrets = scanSecrets(b.texts);
  const title = b.bundle.manifest.title;
  const now = Date.now();
  for (const [k, v] of prepared) if (now - v.at > PREPARED_TTL_MS) prepared.delete(k);
  // A file too large to hand over is described but never kept.
  let token = "";
  if (!tooLarge) {
    token = randomUUID();
    // Bundles can be large; keep only the newest few.
    while (prepared.size >= PREPARED_MAX) prepared.delete(prepared.keys().next().value!);
    const count = secrets.reduce((n, s) => n + s.count, 0);
    prepared.set(token, { name: fileStem(title, sessionId) + EXT, title, bytes, secrets: count, at: now });
  }
  return {
    token,
    title,
    messages: b.bundle.manifest.messages,
    mcpServers: b.bundle.manifest.mcpServers,
    files: Object.keys(b.bundle.files).length,
    bytes: bytes.length,
    large: bytes.length > LARGE_BYTES,
    tooLarge,
    secrets,
  };
}

/**
 * The file a preview made. Throws when it is gone, so nothing unchecked is ever
 * sent, and when it holds credentials the user has not acknowledged: the page
 * asks, but the daemon does not take the page's word for it.
 */
export function preparedFile(token: string, ack: boolean): PreparedFile {
  const f = prepared.get(token);
  if (!f || Date.now() - f.at > PREPARED_TTL_MS)
    throw new PreparedFileError("this preview has expired; close the window and open Send again", "expired");
  if (f.secrets > 0 && !ack)
    throw new PreparedFileError("this session holds what look like credentials; confirm you still want to send it", "needs-ack");
  return f;
}

/**
 * Write the previewed file where a person will look for it (~/Downloads when it
 * exists), then show it in Finder and bring Slack forward, so sending it is one
 * drag. The way to send when the Slack connector cannot upload files.
 */
export function exportSession(token: string, ack: boolean): { path: string } {
  const f = preparedFile(token, ack);
  const downloads = join(homedir(), "Downloads");
  const dir = existsSync(downloads) ? downloads : join(DATA_DIR, "exports");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, f.name);
  writeFileSync(path, f.bytes);
  if (platform() === "darwin") {
    Bun.spawn(["open", "-R", path], { stdout: "ignore", stderr: "ignore" });
    Bun.spawn(["open", "-a", "Slack"], { stdout: "ignore", stderr: "ignore" });
  }
  return { path };
}

function parseBundle(raw: Uint8Array): Bundle {
  let b: Bundle;
  try {
    b = JSON.parse(gunzipSync(raw).toString("utf8"));
  } catch {
    throw new Error(`not a ${EXT} file`);
  }
  if (b?.format !== FORMAT) throw new Error(`not a ${EXT} file`);
  if (b.version > FORMAT_VERSION) throw new Error("this file comes from a newer dashboard — update yours first");
  if (typeof b.transcript !== "string" || !b.manifest?.sessionId) throw new Error("the file is incomplete");
  return b;
}

/**
 * Where a path key may end: at a separator, a quote, a bracket, punctuation or
 * whitespace. So /Users/jan is not the start of /Users/jan.doe or /Users/janet,
 * and ~/.claude not of ~/.claude.json. A dot counts only as a full stop (followed
 * by whitespace, a quote or the end). A space counts unless what follows reads as
 * the rest of a folder name (` dashboard/…`), so ~/Documents/Claude is not the
 * start of ~/Documents/Claude dashboard/; the price is that a path followed by a
 * space and a relative path (`ls ~/x foo/bar`) is left as it was.
 */
const PATH_END = String.raw`(?=$|[/\\"'` + "`" + String.raw`)\]}>,;:|\t\r\n]| (?![^\s"'/\\]+/)|\.(?=$|[\s"'\\]))`;
/** Where a name key (a session id, or the session folder named by it) may end: anything but more of the name, so `<id>.jsonl` matches. */
const NAME_END = "(?![A-Za-z0-9_-])";

export type RewritePair = [from: string, to: string, kind?: "path" | "name"];

/**
 * Every pair in one pass, longest match first, so the session folder wins over the
 * profile it sits in and the profile over the home directory around both. A
 * longer key that fails its boundary falls back to a shorter one that fits.
 *
 * One pass rather than one replace per pair, because the outputs overlap the
 * inputs: ~/.claude → ~/.claude-work run after the session folder has already
 * become ~/.claude-work/… matches again and yields ~/.claude-work-work/….
 */
export function rewriter(pairs: RewritePair[]): (s: string) => string {
  const map = new Map<string, string>();
  const kinds = new Map<string, "path" | "name">();
  for (const [from, to, kind = "path"] of pairs) {
    if (!from || from === to || map.has(from)) continue;
    map.set(from, to);
    kinds.set(from, kind);
  }
  if (map.size === 0) return (s) => s;
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const alts = [...map.keys()]
    .sort((a, b) => b.length - a.length)
    .map((k) => `${escape(k)}${kinds.get(k) === "name" ? NAME_END : PATH_END}`);
  const re = new RegExp(alts.join("|"), "g");
  return (s) => s.replace(re, (hit) => map.get(hit) ?? hit);
}

/**
 * Put a received session where this machine's Claude Code will find it, under a
 * new id so importing the same file twice cannot overwrite the first copy.
 *
 * It runs in a folder of its own under ~/.claude-dashboard/imported unless one is
 * given: most handed-over sessions are tickets and MCP work rather than code, and
 * a fresh folder keeps whatever the session writes next out of anything else.
 */
export function importSession(raw: Uint8Array, folder?: string): { sessionId: string; cwd: string; title: string | null } {
  const b = parseBundle(raw);
  const m = b.manifest;
  const newId = randomUUID();
  const cwd = folder?.trim() || join(DATA_DIR, "imported", fileStem(m.title, newId));
  mkdirSync(cwd, { recursive: true });
  const slugDir = join(PROJECTS_DIR, projectSlug(cwd));
  const sessionDir = join(slugDir, newId);

  // The old cwd is rewritten as text only when it is a folder of its own. A session
  // started in the home directory would otherwise move every ~/… path it mentions
  // into the import folder; the `cwd` fields are set directly below instead.
  const ownCwd: RewritePair[] = m.cwd && m.cwd !== m.home ? [[m.cwd, cwd]] : [];
  const rewrite = rewriter([
    [m.sessionDir, sessionDir, "name"],
    ...ownCwd,
    [m.profile, CLAUDE_HOME],
    [m.home, homedir()],
    [m.sessionId, newId, "name"],
  ]);
  const withCwd = (text: string) =>
    text
      .split("\n")
      .map((line) => {
        if (!line.includes('"cwd"')) return line;
        try {
          const o = JSON.parse(line) as { cwd?: unknown };
          if (typeof o.cwd !== "string") return line;
          o.cwd = cwd;
          return JSON.stringify(o);
        } catch {
          return line;
        }
      })
      .join("\n");

  mkdirSync(slugDir, { recursive: true });
  writeFileSync(join(slugDir, `${newId}.jsonl`), withCwd(rewrite(b.transcript)));
  for (const [rel, b64] of Object.entries(b.files ?? {})) {
    // A bundle is someone else's file: nothing in it may name a path outside the
    // session's own folder.
    if (rel.startsWith("/") || rel.split("/").includes("..")) continue;
    const dest = join(sessionDir, ...rel.split("/"));
    mkdirSync(join(dest, ".."), { recursive: true });
    let bytes = Buffer.from(b64, "base64");
    if (/\.jsonl$/i.test(rel)) bytes = Buffer.from(withCwd(rewrite(bytes.toString("utf8"))), "utf8");
    else {
      const text = asText(bytes);
      if (text !== null) bytes = Buffer.from(rewrite(text), "utf8");
    }
    writeFileSync(dest, bytes);
  }
  return { sessionId: newId, cwd, title: m.title ? `${m.title} (from ${m.exportedBy})` : `From ${m.exportedBy}` };
}
