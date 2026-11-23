/**
 * Whether the Qargo MCP connectors (qargo-mcp-test, qargo-mcp-prod) can be used
 * from a session. They are claude.ai connectors, each signed in on its own: one
 * can be connected while the other still needs authentication, and a session
 * pointed at an unconnected one only finds its `authenticate` tool.
 *
 * Read from `claude mcp list`, the CLI's own health check, cached for five minutes.
 */
export type McpState = "connected" | "needs-auth" | "failed" | "missing" | "unknown";
export type QargoMcpStatus = { test: McpState; prod: McpState; checkedAt: number };

let last: QargoMcpStatus | null = null;
let running: Promise<QargoMcpStatus> | null = null;

const stateOf = (out: string, name: string): McpState => {
  const line = out.split("\n").find((l) => l.includes(`${name}:`));
  if (!line) return "missing";
  if (/✔|connected/i.test(line) && !/needs auth/i.test(line)) return "connected";
  if (/needs auth/i.test(line)) return "needs-auth";
  return "failed";
};

async function check(): Promise<QargoMcpStatus> {
  try {
    const p = Bun.spawn(["claude", "mcp", "list"], { cwd: process.env.HOME, stdout: "pipe", stderr: "pipe" });
    const kill = setTimeout(() => p.kill(), 60_000);
    const out = await new Response(p.stdout).text();
    clearTimeout(kill);
    return { test: stateOf(out, "qargo-mcp-test"), prod: stateOf(out, "qargo-mcp-prod"), checkedAt: Date.now() };
  } catch {
    return { test: "unknown", prod: "unknown", checkedAt: Date.now() };
  }
}

export async function qargoMcpStatus(refresh = false): Promise<QargoMcpStatus> {
  if (!refresh && last && Date.now() - last.checkedAt < 5 * 60_000) return last;
  running ??= check().then((s) => ((last = s), (running = null), s));
  return running;
}

/** The last status seen, without waiting: for writing a session's first prompt. */
export const lastQargoMcpStatus = () => last;

/**
 * What a session needs to reach the connector: its tools are loaded on demand, and
 * a connector that is not signed in only offers `authenticate`.
 */
export function mcpHowTo(server: string, state: McpState | undefined): string {
  const prefix = `mcp__claude_ai_${server}__`;
  return (
    `\n\nThe ${server} tools are named ${prefix}<tool> and may be deferred: load them with ToolSearch (query "+${server}") before concluding they are missing. ` +
    `If only ${prefix}authenticate is there, the connector is not signed in: call it, give me the sign-in link, wait until I say I've signed in, then call ${prefix}complete_authentication and carry on.` +
    (state === "needs-auth" ? ` (The dashboard saw ${server} as not signed in just now, so expect to do this first.)` : "")
  );
}
