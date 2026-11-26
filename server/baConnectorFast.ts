import { query, type SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { claudeEnv, DATA_DIR, SCRATCH_DIR } from "./paths.ts";

/**
 * Two faster ways to make one connector call than a fresh Claude session each time.
 *
 * 1. Warm sessions (always on): a few Claude Code sessions stay open and each call is
 *    the next message in one of them. Start-up and connector loading are paid once;
 *    a call costs one short model turn. A session is replaced after a number of calls
 *    or once its history gets large, so turns stay quick.
 * 2. Direct calls (BA flag `directConnectors`, off by default): the call goes straight
 *    to the claude.ai connector over MCP, with Claude Code's own claude.ai sign-in and
 *    no model at all. This uses the same undocumented connection Claude Code uses, so
 *    any failure falls back to the warm sessions.
 *
 * Both return the tool's raw result text, or throw; `connectorCall` falls back to a
 * cold session when they do.
 */

const LOCAL_TOOLS = ["Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "NotebookEdit", "Glob", "Grep", "Task", "WebFetch", "WebSearch"];

// ── the BA flag, read from ba-edition.json (no import of baEdition: it pulls in agents.ts) ──
let flagAt = 0;
let flagOn = false;
export function directEnabled(): boolean {
  if (Date.now() - flagAt > 10_000) {
    flagAt = Date.now();
    try {
      const m = JSON.parse(readFileSync(join(DATA_DIR, "ba-edition.json"), "utf8"));
      flagOn = m?.flags?.enabled === true && m?.flags?.directConnectors === true;
    } catch {
      flagOn = false;
    }
  }
  return flagOn;
}

// ── 1. warm sessions ──────────────────────────────────────────────────────────
type Waiter = { seq: number; tool: string; resolve: (text: string) => void; reject: (e: Error) => void; ids: Set<string>; timer: ReturnType<typeof setTimeout> };
const POOL_SIZE = 3;
const MAX_CALLS = 25;
const MAX_BYTES = 250_000;

class Warm {
  calls = 0;
  bytes = 0;
  dead = false;
  /** Messages sent and turns finished: a new call may queue behind a turn that is only signing off. */
  private sent = 0;
  private turns = 0;
  private push: ((m: SDKUserMessage) => void) | null = null;
  private queued: SDKUserMessage[] = [];
  private cur: Waiter | null = null;
  private stop = new AbortController();
  private q: AsyncIterable<any>;

  constructor() {
    mkdirSync(SCRATCH_DIR, { recursive: true });
    const self = this;
    async function* input(): AsyncGenerator<SDKUserMessage> {
      while (!self.dead) {
        const next = self.queued.shift() ?? (await new Promise<SDKUserMessage>((r) => (self.push = r)));
        self.push = null;
        yield next;
      }
    }
    this.q = query({
      prompt: input(),
      options: {
        env: claudeEnv(),
        cwd: SCRATCH_DIR,
        model: "haiku",
        persistSession: false,
        settingSources: ["user"],
        skills: [],
        disallowedTools: LOCAL_TOOLS,
        abortController: this.stop,
        systemPrompt: {
          type: "preset" as const,
          preset: "claude_code" as const,
          append: "You are a tool-call relay. Each message names one tool and one JSON input: call exactly that tool once with exactly that input (load it with ToolSearch first if needed), call nothing else, then reply with the single word: done. Never summarise or repeat a result.",
        },
        // Only the tool the current call names (and ToolSearch to load it) may run.
        canUseTool: async (name: string, input: Record<string, unknown>) =>
          name === "ToolSearch" || name === this.cur?.tool ? { behavior: "allow" as const, updatedInput: input } : { behavior: "deny" as const, message: "Only the requested tool may be called." },
      },
    }) as AsyncIterable<any>;
    void this.loop();
  }

  private async loop() {
    try {
      for await (const msg of this.q) {
        const w = this.cur;
        if (msg.type === "assistant" && w) {
          for (const c of msg.message?.content ?? []) if (c.type === "tool_use" && c.name === w.tool) w.ids.add(c.id);
        } else if (msg.type === "user" && w) {
          for (const c of Array.isArray(msg.message?.content) ? msg.message.content : []) {
            if (c.type !== "tool_result" || !w.ids.has(c.tool_use_id)) continue;
            const text = typeof c.content === "string" ? c.content : (c.content ?? []).map((p: any) => p.text ?? "").join("");
            this.bytes += text.length;
            if (c.is_error) this.settle(null, Object.assign(new Error(text.slice(0, 500) || "tool error"), { toolError: true }));
            else this.settle(text, null);
            // Got the result: end the turn now instead of paying for the model's "done".
            void (this.q as any).interrupt?.().catch(() => {});
          }
        } else if (msg.type === "result") {
          // A turn is over; if it was the current call's turn and the call never came, that call failed.
          this.turns++;
          if (this.cur && this.cur.seq <= this.turns) this.settle(null, new Error("the connector call did not happen"));
          pump();
        }
      }
    } catch {
      /* aborted or crashed */
    }
    this.kill(new Error("warm session ended"));
  }

  private settle(text: string | null, err: Error | null) {
    const w = this.cur;
    if (!w) return;
    this.cur = null;
    clearTimeout(w.timer);
    if (err) w.reject(err);
    else w.resolve(text!);
    pump();
  }

  get free() {
    return !this.dead && !this.cur;
  }
  get idle() {
    return this.free && this.sent === this.turns;
  }

  call(tool: string, input: unknown, reason: string): Promise<string> {
    this.calls++;
    const seq = ++this.sent;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.kill(new Error("connector call timed out")), 90_000);
      this.cur = { seq, tool, resolve, reject, ids: new Set(), timer };
      const msg = {
        type: "user",
        message: { role: "user", content: `Call the tool ${tool} once with exactly this JSON input, unchanged:\n\n${JSON.stringify(input)}\n\nThen reply: done. (Purpose: ${reason})` },
        parent_tool_use_id: null,
      } as SDKUserMessage;
      if (this.push) this.push(msg);
      else this.queued.push(msg);
    });
  }

  worn() {
    return this.calls >= MAX_CALLS || this.bytes >= MAX_BYTES;
  }

  kill(err: Error) {
    if (this.dead) return;
    this.dead = true;
    this.settle(null, err);
    this.stop.abort();
    pool.splice(pool.indexOf(this), 1);
    pump();
  }
}

const pool: Warm[] = [];
const queue: { tool: string; input: unknown; reason: string; resolve: (t: string) => void; reject: (e: Error) => void }[] = [];

function pump() {
  while (queue.length) {
    // A session that has done its share is retired once idle, and replaced.
    for (const w of [...pool]) if (w.idle && w.worn()) w.kill(new Error("retired"));
    let w = pool.find((x) => x.free && !x.worn());
    if (!w && pool.length < POOL_SIZE) pool.push((w = new Warm()));
    if (!w) return;
    const job = queue.shift()!;
    w.call(job.tool, job.input, job.reason).then(job.resolve, job.reject);
  }
}

/** Start one session ahead, so the first call after start-up is warm too. */
export function prewarm(n = 2) {
  while (pool.length < Math.min(n, POOL_SIZE)) pool.push(new Warm());
}

export function warmCall(tool: string, input: unknown, reason: string): Promise<string> {
  return new Promise((resolve, reject) => {
    queue.push({ tool, input, reason, resolve, reject });
    pump();
  });
}

// ── 2. direct calls through the claude.ai connector proxy ─────────────────────
const API = "https://api.anthropic.com";
const PROXY = "https://mcp-proxy.anthropic.com/v1/mcp/";

/** Claude Code's claude.ai sign-in: the macOS Keychain, or ~/.claude/.credentials.json elsewhere. */
function claudeToken(): string | null {
  try {
    let raw = "";
    if (process.platform === "darwin") raw = Bun.spawnSync(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]).stdout.toString().trim();
    const file = join(process.env.CLAUDE_CONFIG_DIR ?? join(process.env.HOME ?? "", ".claude"), ".credentials.json");
    if (!raw && existsSync(file)) raw = readFileSync(file, "utf8");
    const o = JSON.parse(raw)?.claudeAiOauth;
    // An expired token is refreshed by Claude Code itself (any warm session does that); until then, fall back.
    if (!o?.accessToken || (o.expiresAt && o.expiresAt < Date.now() + 60_000)) return null;
    return String(o.accessToken);
  } catch {
    return null;
  }
}

const norm = (s: string) => s.replace(/[^a-z0-9]+/gi, "_").replace(/^_+|_+$/g, "").toLowerCase();
let servers: { at: number; byName: Map<string, string> } | null = null;
const sessions = new Map<string, string | null>(); // server id → MCP session id
let rpcId = 1;

async function serverIds(token: string): Promise<Map<string, string>> {
  if (servers && Date.now() - servers.at < 30 * 60_000) return servers.byName;
  const r = await fetch(`${API}/v1/mcp_servers?limit=1000`, { headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "mcp-servers-2025-12-04", "anthropic-version": "2023-06-01" } });
  if (!r.ok) throw new Error(`connector list: HTTP ${r.status}`);
  const body: any = await r.json();
  const list: any[] = body?.data ?? body?.servers ?? [];
  const byName = new Map<string, string>();
  for (const s of list) if (s?.id) byName.set(norm(String(s.display_name ?? s.name ?? "")), String(s.id));
  servers = { at: Date.now(), byName };
  return byName;
}

/** A JSON-RPC answer, sent as plain JSON or as server-sent events. */
async function rpcBody(r: Response): Promise<any> {
  const text = await r.text();
  if ((r.headers.get("content-type") ?? "").includes("text/event-stream")) {
    const datas = text.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trim());
    for (const d of datas.reverse()) {
      try {
        const j = JSON.parse(d);
        if (j && ("result" in j || "error" in j)) return j;
      } catch {
        /* next */
      }
    }
    return null;
  }
  return text ? JSON.parse(text) : null;
}

const CLIENT_SID = crypto.randomUUID(); // the proxy requires a client session id

async function rpc(token: string, id: string, method: string, params: unknown, notify = false): Promise<any> {
  const sid = sessions.get(id);
  const r = await fetch(PROXY + id, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "X-Mcp-Client-Session-Id": CLIENT_SID, "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(sid ? { "mcp-session-id": sid } : {}) },
    body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: rpcId++, method, params }),
    signal: AbortSignal.timeout(60_000),
  });
  if (method === "initialize") sessions.set(id, r.headers.get("mcp-session-id"));
  if (r.status === 404 && sid) {
    sessions.delete(id); // the proxy dropped our session: start a new one next time
    throw new Error("connector session expired");
  }
  if (!r.ok) throw new Error(`connector ${method}: HTTP ${r.status} ${(await r.text().catch(() => "")).slice(0, 300)}`);
  return notify ? null : rpcBody(r);
}

async function ensureSession(token: string, id: string) {
  if (sessions.has(id)) return;
  await rpc(token, id, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "claude-dashboard", version: "1" } });
  await rpc(token, id, "notifications/initialized", {}, true);
}

/** `mcp__claude_ai_<Connector>__<tool>` straight to the connector. Throws on anything unexpected. */
export async function directCall(tool: string, input: unknown): Promise<string> {
  const m = tool.match(/^mcp__claude_ai_(.+?)__(.+)$/);
  if (!m) throw new Error("not a claude.ai connector tool");
  const token = claudeToken();
  if (!token) throw new Error("no usable claude.ai sign-in");
  const id = (await serverIds(token)).get(norm(m[1]!));
  if (!id) throw new Error(`connector ${m[1]} not found`);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await ensureSession(token, id);
      const res = await rpc(token, id, "tools/call", { name: m[2], arguments: input });
      if (res?.error) throw new Error(String(res.error.message ?? "connector error"));
      const out = res?.result;
      const text = (out?.content ?? []).map((c: any) => (c.type === "text" ? c.text : "")).join("");
      if (out?.isError) throw Object.assign(new Error(text.slice(0, 500) || "tool error"), { toolError: true });
      return text;
    } catch (e: any) {
      if (e?.toolError || attempt === 1 || !/expired/.test(String(e?.message))) throw e;
    }
  }
  throw new Error("unreachable");
}
