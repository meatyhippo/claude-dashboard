import { readFileSync } from "node:fs";
import { transcriptPath } from "./baDataShaper.ts";

export type SessionDraft = { ts: number | null; conversationId: string | null; preview: string; update: boolean };

const DRAFT = /Front__(create|update)_draft$/;

/**
 * The Front drafts a session created, read from its transcript: the indexed turns
 * leave tool calls out, so after a restart the chat would lose its draft links.
 */
export function sessionDrafts(sessionId: string): SessionDraft[] {
  const file = transcriptPath(sessionId);
  if (!file) return [];
  let text = "";
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const calls = new Map<string, SessionDraft>();
  const done: SessionDraft[] = [];
  for (const line of text.split("\n")) {
    if (!line.includes("_draft") && !(calls.size && line.includes("tool_result"))) continue;
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (row.isSidechain) continue;
    const content = row.message?.content;
    if (!Array.isArray(content)) continue;
    const ts = row.timestamp ? Date.parse(row.timestamp) : null;
    for (const b of content) {
      if (b?.type === "tool_use" && DRAFT.test(String(b.name))) {
        const input = b.input ?? {};
        calls.set(String(b.id), {
          ts,
          conversationId: typeof input.conversationId === "string" ? input.conversationId : null,
          preview: String(input.body ?? "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 160),
          update: /update_draft$/.test(String(b.name)),
        });
      } else if (b?.type === "tool_result" && calls.has(String(b.tool_use_id)) && !b.is_error) {
        const d = calls.get(String(b.tool_use_id))!;
        const res = typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "");
        done.push({ ...d, ts: ts ?? d.ts, conversationId: d.conversationId ?? res.match(/cnv_[A-Za-z0-9]+/)?.[0] ?? null });
      }
    }
  }
  return done;
}
