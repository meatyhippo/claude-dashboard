import type { Database } from "bun:sqlite";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import type { Cached } from "../shared/baCustomers.ts";
import { claudeEnv, SCRATCH_DIR } from "./paths.ts";

/**
 * Reading Notion and Front through the user's claude.ai connectors.
 *
 * The dashboard has no credentials of its own. A small model makes exactly one
 * tool call with an input written here, and the tool's raw result is parsed: the
 * model never retypes the data, so what is shown is what Notion or Front sent.
 * Results are cached, since each read costs a model call.
 */

export const NOTION_QUERY = "mcp__claude_ai_Notion__notion-query-data-sources";
export const NOTION_FETCH = "mcp__claude_ai_Notion__notion-fetch";
export const NOTION_SELF = "mcp__claude_ai_Notion__notion-get-self";
export const FRONT_SEARCH = "mcp__claude_ai_Front__search_conversations";

/** Cached reads stay fresh this long before the page offers a refresh. */
export const CACHE_TTL_MS = 30 * 60_000;

const LOCAL_TOOLS = ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "Task", "WebFetch", "WebSearch"];

let db: Database;

export function initConnector(database: Database) {
  db = database;
  db.exec(`CREATE TABLE IF NOT EXISTS ba_cache (key TEXT PRIMARY KEY, json TEXT, error TEXT, fetched_at INTEGER NOT NULL);`);
}

/** One exact tool call; Haiku first, Sonnet if that fails. Returns the tool's raw result text. */
export async function connectorCall(tool: string, input: unknown, reason: string): Promise<string> {
  mkdirSync(SCRATCH_DIR, { recursive: true });
  let lastError = "no result";
  for (const model of ["haiku", "sonnet"]) {
    try {
      const out = await oneCall(model, tool, input, reason);
      if (out !== null) return out;
      lastError = `${model}: the connector call did not happen`;
    } catch (e) {
      lastError = `${model}: ${e instanceof Error ? e.message : String(e)}`;
    }
  }
  throw new Error(lastError);
}

async function oneCall(model: string, tool: string, input: unknown, reason: string): Promise<string | null> {
  // Stopping to read is not enough to end the CLI process behind a query: abort it once the result is in,
  // or on any error, so background calls never pile up as idle processes.
  const stop = new AbortController();
  // A connector that never answers would otherwise hold the process forever: a hard limit ends it.
  const limit = setTimeout(() => stop.abort(), 90_000);
  try {
    return await oneCallInner(model, tool, input, reason, stop);
  } finally {
    clearTimeout(limit);
    stop.abort();
  }
}

async function oneCallInner(model: string, tool: string, input: unknown, reason: string, stop: AbortController): Promise<string | null> {
  const q = query({
    prompt:
      `Call the tool ${tool} exactly once, with exactly this JSON input, unchanged:\n\n${JSON.stringify(input)}\n\n` +
      `If the tool is not loaded yet, load it with ToolSearch first ("select:${tool}"). ` +
      `Do not call any other tool. After the call, reply with the single word: done. (Purpose: ${reason})`,
    options: {
      env: claudeEnv(),
      cwd: SCRATCH_DIR,
      model,
      maxTurns: 4,
      persistSession: false,
      settingSources: ["user"],
      skills: [],
      disallowedTools: LOCAL_TOOLS,
      allowedTools: [tool, "ToolSearch"],
      permissionMode: "dontAsk",
      abortController: stop,
    },
  });
  const pending = new Set<string>();
  let result: string | null = null;
  let toolError: string | null = null;
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === "assistant") {
      for (const c of msg.message?.content ?? []) if (c.type === "tool_use" && c.name === tool) pending.add(c.id);
    } else if (msg.type === "user") {
      const content = Array.isArray(msg.message?.content) ? msg.message.content : [];
      for (const c of content) {
        if (c.type !== "tool_result" || !pending.has(c.tool_use_id)) continue;
        const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((p: any) => p.text ?? "").join("");
        if (c.is_error) toolError = text;
        else result = text;
      }
      if (result !== null) {
        // Got what we came for: stop rather than pay for the model's sign-off.
        await (q as any).interrupt?.().catch(() => {});
        break;
      }
    }
  }
  if (result === null && toolError) throw new Error(toolError.slice(0, 500));
  return result === null ? null : unpersist(result);
}

/**
 * Claude Code moves a large tool result to a file and hands back a pointer
 * ("<persisted-output> … Full output saved to: /path"). Read the file instead.
 */
function unpersist(text: string): string {
  if (!text.includes("<persisted-output>")) return text;
  const path = text.match(/saved to:\s*(\S+\.(?:txt|json))/)?.[1];
  if (!path || !existsSync(path)) return text;
  const body = readFileSync(path, "utf8");
  // Saved MCP results may be the content blocks rather than the text in them.
  const parsed = parseJson(body);
  if (Array.isArray(parsed) && parsed.every((b) => b && typeof b === "object" && "text" in b)) return parsed.map((b) => b.text).join("");
  return body;
}

/**
 * Several calls of one tool in a single model session (the model makes them in
 * parallel): one start-up instead of one per call. Returns raw results by key.
 */
export async function connectorBatch<I>(tool: string, inputs: I[], keyOf: (input: I) => string, reason: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (!inputs.length) return out;
  mkdirSync(SCRATCH_DIR, { recursive: true });
  const wanted = new Set(inputs.map(keyOf));
  const stop = new AbortController();
  const limit = setTimeout(() => stop.abort(), 180_000);
  try {
    return await batchInner(tool, inputs, keyOf, reason, wanted, out, stop);
  } catch {
    return out; // timed out or failed: whatever came back so far
  } finally {
    clearTimeout(limit);
    stop.abort();
  }
}

async function batchInner<I>(tool: string, inputs: I[], keyOf: (input: I) => string, reason: string, wanted: Set<string>, out: Map<string, string>, stop: AbortController): Promise<Map<string, string>> {
  const q = query({
    prompt:
      `Call the tool ${tool} once for each of these ${inputs.length} inputs, exactly as given, all in parallel in one turn:\n\n` +
      inputs.map((i) => JSON.stringify(i)).join("\n") +
      `\n\nIf the tool is not loaded yet, load it with ToolSearch first ("select:${tool}"). Do not call any other tool. Then reply with the single word: done. (Purpose: ${reason})`,
    options: {
      env: claudeEnv(),
      cwd: SCRATCH_DIR,
      model: "haiku",
      maxTurns: 6,
      persistSession: false,
      settingSources: ["user"],
      skills: [],
      disallowedTools: LOCAL_TOOLS,
      allowedTools: [tool, "ToolSearch"],
      permissionMode: "dontAsk",
      abortController: stop,
    },
  });
  const byId = new Map<string, string>();
  for await (const msg of q as AsyncIterable<any>) {
    if (msg.type === "assistant") {
      for (const c of msg.message?.content ?? []) if (c.type === "tool_use" && c.name === tool) byId.set(c.id, keyOf(c.input as I));
    } else if (msg.type === "user") {
      for (const c of Array.isArray(msg.message?.content) ? msg.message.content : []) {
        if (c.type !== "tool_result" || !byId.has(c.tool_use_id) || c.is_error) continue;
        const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((p: any) => p.text ?? "").join("");
        out.set(byId.get(c.tool_use_id)!, unpersist(text));
      }
      if ([...wanted].every((k) => out.has(k))) {
        await (q as any).interrupt?.().catch(() => {});
        break;
      }
    }
  }
  return out;
}

/** A tool result is usually JSON, sometimes wrapped in a text envelope. */
export function parseJson(text: string): any {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.search(/[[{]/);
    if (start >= 0) {
      try {
        return JSON.parse(text.slice(start));
      } catch {
        /* fall through */
      }
    }
    return null;
  }
}

export async function notionSql(dataSource: string, sql: string, params: unknown[], reason: string): Promise<Record<string, any>[]> {
  const raw = await connectorCall(NOTION_QUERY, { data: { mode: "sql", data_source_urls: [dataSource], query: sql, params } }, reason);
  const parsed = parseJson(raw);
  if (!parsed || !Array.isArray(parsed.results)) throw new Error(`Notion returned something unexpected: ${raw.slice(0, 300)}`);
  return parsed.results;
}

/** Background refreshes in flight, so a stale key is reloaded once, not once per request. */
const revalidating = new Map<string, Promise<unknown>>();

/**
 * A cached read. With `swr` (stale-while-revalidate), stale data is returned at
 * once and refreshed in the background, so a page never waits on a connector call
 * for something it has seen before.
 */
export async function cached<T>(key: string, refresh: boolean, load: () => Promise<T>, ttl = CACHE_TTL_MS, opts: { swr?: boolean } = {}): Promise<Cached<T>> {
  const row = db.query<{ json: string | null; error: string | null; fetched_at: number }, [string]>("SELECT json, error, fetched_at FROM ba_cache WHERE key = ?").get(key);
  if (row?.json && !refresh) {
    const stale = Date.now() - row.fetched_at > ttl;
    if (stale && opts.swr && !revalidating.has(key)) {
      const p = cached(key, true, load, ttl).finally(() => revalidating.delete(key));
      revalidating.set(key, p);
    }
    return { data: JSON.parse(row.json) as T, error: row.error, fetchedAt: row.fetched_at, stale };
  }
  if (revalidating.has(key) && !refresh) await revalidating.get(key);
  try {
    const data = await load();
    const now = Date.now();
    db.query("INSERT OR REPLACE INTO ba_cache (key, json, error, fetched_at) VALUES (?, ?, NULL, ?)").run(key, JSON.stringify(data), now);
    return { data, error: null, fetchedAt: now, stale: false };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // Keep the last good data; record the failure beside it.
    db.query("INSERT INTO ba_cache (key, json, error, fetched_at) VALUES (?, NULL, ?, ?) ON CONFLICT(key) DO UPDATE SET error = excluded.error").run(key, error, Date.now());
    return { data: row?.json ? (JSON.parse(row.json) as T) : null, error, fetchedAt: row?.fetched_at ?? Date.now(), stale: true };
  }
}

export const peekCache = <T>(key: string): T | null => {
  const row = db.query<{ json: string | null }, [string]>("SELECT json FROM ba_cache WHERE key = ?").get(key);
  return row?.json ? (JSON.parse(row.json) as T) : null;
};

export const dropCache = (likePattern: string) => db.query("DELETE FROM ba_cache WHERE key LIKE ?").run(likePattern);

/** Mark entries outdated without dropping them: a stale-while-revalidate read still serves them at once. */
export const markStale = (likePattern: string) => db.query("UPDATE ba_cache SET fetched_at = 0 WHERE key LIKE ?").run(likePattern);

/**
 * The structure of a tool result with every value replaced by its type: field
 * names, nesting and array lengths, never content. Kept for diagnosing a parser
 * that finds nothing, without storing anyone's mail.
 */
export function shapeOf(v: unknown, depth = 0): unknown {
  if (depth > 6) return "…";
  if (Array.isArray(v)) {
    if (!v.length) return [];
    // The union of the first 30 elements' fields, and the values of a "kind" field (an enum, not content).
    const objs = v.slice(0, 30).filter((x) => x && typeof x === "object" && !Array.isArray(x)) as Record<string, unknown>[];
    if (!objs.length) return [`${v.length} ×`, shapeOf(v[0], depth + 1)];
    const merged: Record<string, unknown> = {};
    for (const o of objs) for (const [k, x] of Object.entries(o)) if (!(k in merged)) merged[k] = x;
    const kinds = [...new Set(objs.map((o) => o.kind).filter((k) => typeof k === "string"))];
    return [`${v.length} ×`, kinds.length ? { kinds, ...(shapeOf(merged, depth + 1) as object) } : shapeOf(merged, depth + 1)];
  }
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).slice(0, 40).map(([k, x]) => [k, shapeOf(x, depth + 1)]));
  return v === null ? "null" : typeof v;
}

export const recordShape = (name: string, raw: string) => {
  const parsed = parseJson(raw);
  db.query("INSERT OR REPLACE INTO ba_cache (key, json, error, fetched_at) VALUES (?, ?, NULL, ?)").run(`debug:shape:${name}`, JSON.stringify(parsed ? shapeOf(parsed) : { notJson: raw.length }), Date.now());
};
