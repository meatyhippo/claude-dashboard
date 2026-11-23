import { useState } from "react";
import { agentApi, type PermissionMode, type TimelineItem } from "../api.ts";

/**
 * BA edition: when auto mode's safety check refuses a step (a production write on
 * the Qargo MCP, say), the session only sees a tool error and auto mode cannot be
 * asked to approve it. This names the blocked step and offers the way through:
 * switch this session to Ask me and have Claude retry, so you approve that step.
 */
const BLOCKED = /denied by the Claude Code auto mode classifier/i;

/** mcp__claude_ai_qargo-mcp-prod__internal_create_x → "create x (qargo-mcp-prod)". */
function prettyTool(name: string): string {
  const m = name.match(/^mcp__(?:claude_ai_)?(.+?)__(.+)$/);
  if (!m) return name;
  return `${m[2]!.replace(/^internal_/, "").replace(/_/g, " ")} (${m[1]})`;
}

export default function AutoBlocked({ agentKey, timeline, mode, ended }: { agentKey: string; timeline: TimelineItem[]; mode: PermissionMode; ended: boolean }) {
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (ended || mode !== "auto") return null;
  let blocked: Extract<TimelineItem, { kind: "tool" }> | null = null;
  for (let i = timeline.length - 1; i >= 0; i--) {
    const it = timeline[i]!;
    if (it.kind === "user") break; // you have answered since
    if (it.kind === "tool" && BLOCKED.test(it.result ?? "")) {
      blocked = it;
      break;
    }
  }
  if (!blocked || dismissed === blocked.id) return null;
  const retry = async () => {
    setBusy(true);
    try {
      await agentApi.mode(agentKey, "default");
      await agentApi.message(agentKey, "Auto mode's safety check blocked your last step. I've switched this session to Ask me: try that step again and I'll approve it.");
      setDismissed(blocked!.id);
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="auto-blocked">
      <span>
        <strong>Auto mode blocked a step:</strong> {prettyTool(blocked.name)}. Auto mode can't approve it; in Ask me you approve it yourself.
      </span>
      <button className="icon-btn primary" disabled={busy} onClick={() => void retry()}>
        {busy ? "Switching…" : "Ask me and retry"}
      </button>
      <button className="icon-btn ghost" onClick={() => setDismissed(blocked!.id)}>
        Dismiss
      </button>
      {error && <span className="chat-error">{error}</span>}
    </div>
  );
}
