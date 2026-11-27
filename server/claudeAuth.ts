import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { claudeBin } from "./mcp.ts";
import { claudeEnv } from "./paths.ts";

/**
 * Signing in to Claude from the dashboard, without a terminal.
 *
 * The sessions run on the Claude Code bundled with the app, signed in as the
 * person's own Claude account. A colleague who never used Claude Code has no login,
 * so the page offers "Sign in with Claude": the daemon runs `claude auth login`,
 * hands the page the claude.ai link it prints, and passes back the code that page
 * shows. `claude auth status --json` says who is signed in.
 */

/** The Claude Code inside the app (the Agent SDK's own binary), else the one on this Mac. */
export function bundledClaude(): string {
  try {
    const req = createRequire(import.meta.url);
    const pkg = req.resolve("@anthropic-ai/claude-agent-sdk-darwin-arm64/package.json");
    const bin = join(dirname(pkg), "claude");
    if (existsSync(bin)) return bin;
  } catch {
    /* not installed for this platform */
  }
  return claudeBin();
}

export type ClaudeAuthStatus = { loggedIn: boolean; email: string | null; orgName: string | null; subscription: string | null; method: string | null; error?: string | null };

export async function claudeAuthStatus(): Promise<ClaudeAuthStatus> {
  try {
    const out = await run([bundledClaude(), "auth", "status", "--json"], 20_000);
    const j = JSON.parse(out.slice(out.indexOf("{")));
    return { loggedIn: !!j.loggedIn, email: j.email ?? null, orgName: j.orgName ?? null, subscription: j.subscriptionType ?? null, method: j.authMethod ?? null };
  } catch (e) {
    return { loggedIn: false, email: null, orgName: null, subscription: null, method: null, error: e instanceof Error ? e.message : String(e) };
  }
}

function run(cmd: string[], ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd[0]!, cmd.slice(1), { env: claudeEnv({ NO_COLOR: "1", CI: "1" }) as NodeJS.ProcessEnv, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (out += d));
    const t = setTimeout(() => p.kill(), ms);
    p.on("error", reject);
    p.on("close", () => {
      clearTimeout(t);
      resolve(out);
    });
  });
}

type Login = { proc: ReturnType<typeof Bun.spawn>; url: string | null; output: string; done: boolean; ok: boolean; error: string | null; startedAt: number };
let login: Login | null = null;

export type ClaudeLoginState = { running: boolean; url: string | null; done: boolean; ok: boolean; error: string | null };
export const claudeLoginState = (): ClaudeLoginState | null => (login ? { running: !login.done, url: login.url, done: login.done, ok: login.ok, error: login.error } : null);

/** Terminal colours, links and cursor codes out of the CLI's output. */
const plain = (s: string) => s.replace(/\x1b\][^\x07]*\x07/g, "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\r/g, "");

/**
 * Start `claude auth login` and wait until it prints the sign-in link (a few seconds).
 * It runs in a pseudo-terminal: the CLI only reads the pasted code from a terminal.
 */
export async function startClaudeLogin(opts: { email?: string; sso?: boolean } = {}): Promise<ClaudeLoginState> {
  if (login && !login.done) login.proc.kill();
  const args = ["auth", "login", "--claudeai", ...(opts.sso ? ["--sso"] : []), ...(opts.email ? ["--email", opts.email] : [])];
  const dec = new TextDecoder();
  const l: Login = { proc: null as unknown as Login["proc"], url: null, output: "", done: false, ok: false, error: null, startedAt: Date.now() };
  // BROWSER=true: the page opens the link itself, so the CLI must not open a second tab.
  l.proc = Bun.spawn([bundledClaude(), ...args], {
    env: claudeEnv({ NO_COLOR: "1", BROWSER: "true" }) as Record<string, string>,
    terminal: {
      cols: 400,
      rows: 50,
      data(_t, d) {
        l.output = (l.output + dec.decode(d)).slice(-6000);
        l.url ??= plain(l.output).match(/https:\/\/\S+oauth\/authorize\S+/)?.[0] ?? null;
      },
    },
  });
  login = l;
  const timer = setTimeout(() => l.proc.kill(), 15 * 60_000);
  void l.proc.exited.then((code) => {
    clearTimeout(timer);
    l.done = true;
    l.ok = code === 0;
    if (code !== 0) {
      const last = plain(l.output).trim().split("\n").map((x) => x.trim()).filter(Boolean).pop() ?? "";
      l.error = /failed|error|invalid/i.test(last) ? (/400/.test(last) ? "That code did not work. Copy the whole code from the Claude page and try again, or start again." : last) : `Sign-in stopped (${code}).`;
    }
  });
  for (let i = 0; i < 40 && !l.url && !l.done; i++) await new Promise((r) => setTimeout(r, 250));
  return claudeLoginState()!;
}

/** The code the claude.ai page shows after "Authorize", typed into the waiting CLI. */
export async function submitClaudeCode(code: string): Promise<ClaudeLoginState> {
  if (!login || login.done) return { running: false, url: null, done: true, ok: false, error: "No sign-in is waiting. Start again." };
  login.proc.terminal?.write(`${code.trim()}\r`);
  // The CLI exchanges the code and exits; give it a moment so the page gets the outcome.
  for (let i = 0; i < 80 && !login.done; i++) await new Promise((r) => setTimeout(r, 250));
  return claudeLoginState()!;
}

export function cancelClaudeLogin() {
  if (login && !login.done) login.proc.kill();
  login = null;
}

export async function claudeLogout(): Promise<ClaudeAuthStatus> {
  await run([bundledClaude(), "auth", "logout"], 20_000).catch(() => "");
  return claudeAuthStatus();
}
