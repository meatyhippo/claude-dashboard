import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { findLeaf, flattenTree, type DsAttempt, type DsChange, type DsLeaf, type DsOutcome, type DsReport, type DsTest } from "../shared/baDataShaper.ts";
import { cached, connectorCall, parseJson } from "./baConnector.ts";
import { PROJECTS_DIR } from "./paths.ts";

/**
 * BA edition: DataShaper work in a session, read from its transcript (live or
 * finished): mapping changes with every attempt, test runs, and Claude's
 * analysis around them. The "before" side of a change is the mapping version it
 * was based on, read once through the same Qargo MCP and kept (versions never change).
 */

const CHANGE = /__(?:internal_)?(?:datafetchershaper_(?:create|update)_(?:global_)?transformation_mapping|integrations_upsert_(?:global_)?transformation_mapping)$/;
const TEST = /__(?:internal_)?datafetchershaper_transform_document$/;
const READ = /__(?:internal_)?datafetchershaper_(?:get|list)_(?:global_)?transformation_mappings?$/;
const serverOf = (tool: string) => tool.match(/^mcp__(?:claude_ai_)?(.+?)__/)?.[1] ?? "qargo-mcp";

export function transcriptPath(sessionId: string): string | null {
  if (!/^[\w-]{8,}$/.test(sessionId)) return null;
  const root = PROJECTS_DIR;
  for (const d of readdirSync(root)) {
    const f = join(root, d, `${sessionId}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

const resultText = (c: unknown): string =>
  typeof c === "string" ? c : Array.isArray(c) ? c.map((b) => (b && typeof b === "object" && "text" in b ? String((b as { text: unknown }).text) : "")).join("\n") : "";

function outcomeOf(text: string, isError: boolean): { outcome: DsOutcome; message: string | null; approvalUrl: string | null } {
  if (/auto mode classifier/i.test(text)) return { outcome: "blocked", message: "Blocked by auto mode's safety check", approvalUrl: null };
  const approval = text.match(/https:\/\/[^\s"')]+write-protection[^\s"')]*/)?.[0] ?? null;
  if (/requires explicit approval|write access/i.test(text) && approval) return { outcome: "approval", message: "Waiting for approval in Qargo (production write protection)", approvalUrl: approval };
  if (/doesn't want to proceed|rejected/i.test(text)) return { outcome: "error", message: "You declined this step", approvalUrl: null };
  const j = parseJson(text);
  if (!isError && j && typeof j === "object" && !Array.isArray(j) && !/error/i.test(Object.keys(j).join(" "))) return { outcome: "ok", message: null, approvalUrl: null };
  if (!isError && j && Array.isArray(j.errors) && j.errors.length === 0) return { outcome: "ok", message: null, approvalUrl: null };
  return { outcome: "error", message: text.replace(/\s+/g, " ").trim().slice(0, 300) || "Failed", approvalUrl: null };
}

const trimText = (t: string) => t.trim().slice(0, 4000) || null;

export function sessionDataShaper(sessionId: string): DsReport | null {
  const file = transcriptPath(sessionId);
  if (!file) return null;
  const changes = new Map<string, DsChange>();
  const tests: DsTest[] = [];
  const pending = new Map<string, { kind: "change"; key: string; at: string | null } | { kind: "test"; test: DsTest } | { kind: "read" }>();
  const names = new Map<string, string>();
  let reads = 0;
  let textSince = "";
  let lastText: string | null = null;

  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    let d: any;
    try {
      d = JSON.parse(line);
    } catch {
      continue;
    }
    if (d.isSidechain) continue;
    const content = d.message?.content;
    if (!Array.isArray(content)) {
      if (d.type === "user" && typeof content === "string") textSince = ""; // a new prompt starts a new thought
      continue;
    }
    const at: string | null = d.timestamp ?? null;
    for (const b of content) {
      if (d.type === "assistant" && b.type === "text" && b.text?.trim()) {
        textSince += `${b.text.trim()}\n\n`;
        lastText = b.text.trim();
      }
      if (d.type === "assistant" && b.type === "tool_use" && typeof b.name === "string") {
        const input = (b.input ?? {}) as Record<string, any>;
        if (CHANGE.test(b.name)) {
          const base = input.from_row_id ?? input.row_id ?? input.transformation_mapping_id ?? null;
          const key = `${serverOf(b.name)}:${input.tenant_slug ?? ""}:${base ?? input.name ?? b.id}`;
          const tree = input.transformation_overrides ?? input.transformation ?? input.mapping ?? null;
          const prev = changes.get(key);
          const c: DsChange = prev ?? {
            id: b.id,
            tool: b.name.replace(/^mcp__.+?__/, ""),
            server: serverOf(b.name),
            tenant: input.tenant_slug ?? null,
            prod: !/test/i.test(serverOf(b.name)),
            baseRowId: base,
            name: input.name ?? null,
            versionDescription: null,
            contextUrl: null,
            fields: [],
            attempts: [],
            outcome: "pending",
            analysis: null,
            at,
          };
          c.versionDescription = input.version_description ?? c.versionDescription;
          c.contextUrl = input.context_url ?? c.contextUrl;
          if (tree) c.fields = flattenTree(tree);
          // The reasoning is what came before the first attempt; what is said before a retry belongs to that retry.
          const said = trimText(textSince);
          if (!prev) c.analysis = said;
          c.attempts.push({ at, outcome: "pending", message: null, approvalUrl: null, rowId: null, note: prev ? said : null });
          changes.set(key, c);
          pending.set(b.id, { kind: "change", key, at });
          textSince = "";
        } else if (TEST.test(b.name)) {
          const t: DsTest = {
            id: b.id,
            server: serverOf(b.name),
            tenant: input.tenant_slug ?? null,
            input: JSON.stringify(input.input_data ?? input.input ?? null, null, 2),
            expressions: flattenTree(input.transformation ?? null),
            output: null,
            errors: [],
            outcome: "pending",
            analysis: trimText(textSince),
            at,
          };
          tests.push(t);
          pending.set(b.id, { kind: "test", test: t });
          textSince = "";
        } else if (READ.test(b.name)) {
          reads++;
          pending.set(b.id, { kind: "read" });
        }
      }
      if (d.type === "user" && b.type === "tool_result" && pending.has(b.tool_use_id)) {
        const p = pending.get(b.tool_use_id)!;
        const text = resultText(b.content);
        if (p.kind === "read") {
          const j = parseJson(text);
          for (const m of j?.mappings ?? []) if (m?.row_id && m?.name) names.set(m.row_id, m.name);
          if (j?.row_id && j?.name) names.set(j.row_id, j.name);
        } else if (p.kind === "change") {
          const c = changes.get(p.key)!;
          const o = outcomeOf(text, !!b.is_error);
          const a: DsAttempt = c.attempts[c.attempts.length - 1]!;
          Object.assign(a, o, { rowId: parseJson(text)?.row_id ?? null });
          c.outcome = o.outcome;
        } else {
          const o = outcomeOf(text, !!b.is_error);
          const j = parseJson(text);
          p.test.output = typeof j?.content === "string" ? j.content : o.outcome === "ok" ? text : null;
          p.test.errors = Array.isArray(j?.errors) ? j.errors.map((e: unknown) => (typeof e === "string" ? e : JSON.stringify(e))) : o.outcome === "error" && o.message ? [o.message] : [];
          p.test.outcome = p.test.errors.length ? "error" : o.outcome;
        }
      }
    }
  }
  const list = [...changes.values()].map((c) => ({ ...c, name: c.name ?? (c.baseRowId ? (names.get(c.baseRowId) ?? null) : null) }));
  return { sessionId, changes: list, tests, reads, conclusion: lastText, updatedAt: statSync(file).mtimeMs };
}

/** The fields of the mapping version a change starts from, at the change's paths. */
export async function baseFields(server: string, tenant: string, rowId: string, paths: string[]): Promise<Record<string, DsLeaf | null>> {
  if (!/^qargo-mcp(-test|-prod)?$/.test(server) || !/^[\w-]+$/.test(tenant) || !/^[\w-]+$/.test(rowId)) throw new Error("bad mapping reference");
  const res = await cached(
    `ds:${server}:${tenant}:${rowId}`,
    false,
    async () => {
      const raw = await connectorCall(
        `mcp__claude_ai_${server}__internal_datafetchershaper_get_transformation_mapping`,
        { tenant_slug: tenant, row_id: rowId },
        "Read the mapping version a DataShaper change was based on, to show the user what changed (read-only).",
      );
      const j = parseJson(raw);
      if (j?.signed_url) {
        const r = await fetch(j.signed_url);
        if (!r.ok) throw new Error(`download failed (${r.status})`);
        return (await r.json()) as unknown;
      }
      if (!j) throw new Error(raw.slice(0, 200) || "empty answer");
      return j as unknown;
    },
    365 * 24 * 3600_000,
  );
  if (res.error && !res.data) throw new Error(res.error);
  return Object.fromEntries(paths.map((p) => [p, findLeaf(res.data, p)]));
}
