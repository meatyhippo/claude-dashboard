import type { Database } from "bun:sqlite";
import { isSlackNoise, type BaQaiMessage, type BaQaiQuestion } from "../shared/baCustomers.ts";
import { cached, connectorCall, parseJson } from "./baConnector.ts";

/**
 * Qai in #ps_troubleshooting: Qargo's Slack bot with access to the codebase.
 *
 * Asking posts one message as the user — "@Qai question" plus the customer's
 * tenant, the IR and Front links — exactly as previewed on the page. Replies are
 * read back from the thread on demand. Both go through the Slack connector as a
 * single exact tool call; the dashboard writes the message text, not a model.
 */

export const QAI_CHANNEL = "C0BN21C5JLB";
export const QAI_USER = "U0C0Y7E5SQ4";
const SEND = "mcp__claude_ai_Slack__slack_send_message";
const READ_THREAD = "mcp__claude_ai_Slack__slack_read_thread";

let db: Database;

export function initQai(database: Database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ba_qai (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id  INTEGER,
      ir_url      TEXT,
      question    TEXT NOT NULL,
      message     TEXT NOT NULL,
      ts          TEXT,
      permalink   TEXT,
      asked_at    INTEGER NOT NULL,
      replies     TEXT,
      replies_at  INTEGER
    );
  `);
}

/** The exact Slack text: the mention, the question, then context lines. */
export function composeQai(question: string, context: string[]): string {
  const ctx = context.filter(Boolean);
  return `<@${QAI_USER}> ${question.trim()}${ctx.length ? `\n\n${ctx.map((l) => `• ${l}`).join("\n")}` : ""}`;
}

type Row = { id: number; project_id: number | null; ir_url: string | null; question: string; message: string; ts: string | null; permalink: string | null; asked_at: number; replies: string | null; replies_at: number | null };
const toQuestion = (r: Row): BaQaiQuestion => ({
  id: r.id,
  projectId: r.project_id,
  irUrl: r.ir_url,
  question: r.question,
  message: r.message,
  permalink: r.permalink,
  askedAt: r.asked_at,
  replies: r.replies ? (JSON.parse(r.replies) as BaQaiMessage[]) : null,
  repliesAt: r.replies_at,
});

export const listQai = (projectId?: number | null): BaQaiQuestion[] =>
  (projectId
    ? db.query<Row, [number]>("SELECT * FROM ba_qai WHERE project_id = ? ORDER BY asked_at DESC LIMIT 100").all(projectId)
    : db.query<Row, []>("SELECT * FROM ba_qai ORDER BY asked_at DESC LIMIT 200").all()
  ).map(toQuestion);

export async function askQai(q: { question: string; message: string; projectId?: number | null; irUrl?: string | null }): Promise<BaQaiQuestion> {
  // "@Qai" as typed or shown in the preview becomes the real mention; a message without one gets it in front.
  q = { ...q, message: q.message.replace(/(^|\s)@qai\b/gi, `$1<@${QAI_USER}>`) };
  if (!q.message.includes(`<@${QAI_USER}>`)) q = { ...q, message: `<@${QAI_USER}> ${q.message.trim()}` };
  const raw = await connectorCall(SEND, { channel_id: QAI_CHANNEL, message: q.message }, "Post the user's previewed question to Qai in #ps_troubleshooting.");
  const parsed = parseJson(raw);
  const permalink: string | null = (typeof parsed?.permalink === "string" && parsed.permalink) || raw.match(/https:\/\/[\w.-]+\.slack\.com\/archives\/[\w/]+p\d+[^\s"')]*/)?.[0] || null;
  const ts: string | null =
    (typeof parsed?.ts === "string" && parsed.ts) ||
    (typeof parsed?.message_ts === "string" && parsed.message_ts) ||
    (permalink?.match(/p(\d{10})(\d{6})/) ? permalink.replace(/.*p(\d{10})(\d{6}).*/, "$1.$2") : null) ||
    raw.match(/\b(\d{10}\.\d{6})\b/)?.[1] ||
    null;
  const id = Number(
    db
      .query("INSERT INTO ba_qai (project_id, ir_url, question, message, ts, permalink, asked_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(q.projectId ?? null, q.irUrl ?? null, q.question, q.message, ts, permalink, Date.now()).lastInsertRowid,
  );
  return toQuestion(db.query<Row, [number]>("SELECT * FROM ba_qai WHERE id = ?").get(id)!);
}

/** "Name <email>: text [2026-11-20 15:29:45 CET]" blocks, as the concise thread format gives them. */
export function parseThread(raw: string): BaQaiMessage[] {
  const parsed = parseJson(raw);
  const text: string = typeof parsed?.messages === "string" ? parsed.messages : typeof parsed === "string" ? parsed : raw;
  const blocks = text.split(/\n\n(?=[^\n:]{1,80}?(?: <[^>]+>)?: )/);
  const out: BaQaiMessage[] = [];
  for (const b of blocks) {
    const m = b.match(/^([^\n:]{1,80}?)(?: <([^>]+)>)?: ([\s\S]*?)(?: \[(\d{4}-\d\d-\d\d [\d:]+[^\]]*)\])?\s*$/);
    if (!m || /^Channel$|^Thread$/i.test(m[1]!.trim())) continue;
    out.push({ author: m[1]!.trim(), text: m[3]!.trim(), at: m[4] ?? null, fromQai: /qai/i.test(m[1]!) || /qai/i.test(m[2] ?? "") });
  }
  return out;
}

export async function qaiReplies(id: number): Promise<BaQaiQuestion> {
  const row = db.query<Row, [number]>("SELECT * FROM ba_qai WHERE id = ?").get(id);
  if (!row) throw new Error("no such question");
  if (!row.ts) throw new Error("Slack did not return the message timestamp, so the thread cannot be read. Open it in Slack.");
  const raw = await connectorCall(READ_THREAD, { channel_id: QAI_CHANNEL, message_ts: row.ts, response_format: "concise" }, "Read Qai's replies to the user's question.");
  const messages = parseThread(raw).slice(1); // the first block is the question itself
  db.query("UPDATE ba_qai SET replies = ?, replies_at = ? WHERE id = ?").run(JSON.stringify(messages), Date.now(), id);
  return toQuestion(db.query<Row, [number]>("SELECT * FROM ba_qai WHERE id = ?").get(id)!);
}

/** Today's questions to Qai in #ps_troubleshooting, by anyone: read from the channel, cached for five minutes. */
export async function qaiToday(refresh: boolean): Promise<{ data: BaQaiMessage[]; error: string | null }> {
  const res = await cached(
    "qai:channel",
    refresh,
    async () => parseThread(await connectorCall("mcp__claude_ai_Slack__slack_read_channel", { channel_id: QAI_CHANNEL, limit: 40, response_format: "concise" }, "Show today's questions to Qai on the user's dashboard.")),
    5 * 60_000,
    { swr: true },
  );
  const today = new Date().toISOString().slice(0, 10);
  const local = new Date().toLocaleDateString("sv-SE"); // YYYY-MM-DD in local time
  const data = (res.data ?? []).filter((m) => (m.at ?? "").startsWith(local) || (m.at ?? "").startsWith(today)).filter((m) => !isSlackNoise(m.text)).filter((m) => /qai/i.test(m.text) || m.fromQai);
  return { data, error: res.error };
}
