import { cached, connectorCall, connectorTools, parseJson } from "./baConnector.ts";
import { preparedFile } from "./sessionTransfer.ts";

/**
 * Send a session file to a colleague through the Slack connector on the user's
 * claude.ai account.
 *
 * Every step is one `connectorCall`: a small model makes exactly one tool call
 * with an input written here, and the tool's raw result is parsed. So the user
 * ids, the DM and the signed upload URL the daemon acts on are what Slack sent,
 * never something the model retyped.
 *
 * The file itself never passes through the model. Slack's upload is two-step: a
 * tool call returns a signed URL, the daemon POSTs the bytes to it, and a second
 * call shares the uploaded file in the DM. The recipient is always picked by the
 * user from a search first, because a shared file cannot be unshared from here.
 *
 * Not every Slack connector offers the upload tools, so `slackStatus` checks
 * first, and the page offers Save file instead when they are missing.
 */

const SLACK = "mcp__claude_ai_Slack__";
const T = {
  searchUsers: `${SLACK}slack_search_users`,
  openDm: `${SLACK}slack_create_conversation`,
  uploadUrl: `${SLACK}slack_get_file_upload_url`,
  complete: `${SLACK}slack_complete_file_upload`,
};

export type SlackPerson = { id: string; name: string; email: string; title: string };
export type SlackStatus = {
  /** Can find people. */
  search: boolean;
  /** Can open a DM and upload a file into it, so Send works. */
  upload: boolean;
  /** The tools Send needs that this connector lacks, by short name. */
  missing: string[];
};

const USER_ID = /^[UW][A-Z0-9]{6,}$/;
const short = (tool: string) => tool.slice(SLACK.length);

/** Which of the tools Send needs the user's Slack connector has. Checked once an hour. */
export async function slackStatus(refresh = false): Promise<SlackStatus> {
  const r = await cached("connector:tools", refresh, connectorTools, 60 * 60_000);
  if (!r.data) throw new Error(r.error ?? "could not list the connector's tools");
  const has = new Set(r.data);
  const missing = Object.values(T).filter((t) => !has.has(t));
  return { search: has.has(T.searchUsers), upload: missing.length === 0, missing: missing.map(short) };
}

async function requireTools(tools: string[]): Promise<void> {
  const s = await slackStatus();
  const missing = tools.map(short).filter((t) => s.missing.includes(t));
  if (missing.length) throw new Error(`your Slack connector has no ${missing.join(", ")}; save the file and send it yourself`);
}

/** The text of a result: `results` or `result` when it is a JSON envelope, else the text itself. */
function body(raw: string): string {
  const j = parseJson(raw);
  if (typeof j?.results === "string") return j.results;
  if (typeof j?.result === "string") return j.result;
  return raw;
}

/**
 * A refusal Slack reported in the result itself. A tool that fails outright comes
 * back as an error, which connectorCall throws. This looks only at structured
 * fields and at how the text begins, never for words anywhere in it: a result can
 * echo the session's title ("Fix failed EDI import") and still be a success.
 */
function refused(raw: string): string | null {
  const j = parseJson(raw);
  if (j && typeof j === "object" && !Array.isArray(j)) {
    if (j.ok === false) return String(j.error ?? "not ok").slice(0, 300);
    if (typeof j.error === "string" && j.error) return j.error.slice(0, 300);
  }
  const t = body(raw).trimStart();
  return /^(error|failed)\b/i.test(t) ? t.slice(0, 300) : null;
}

/**
 * People matching a name or email, for the user to pick from.
 *
 * The concise result is one line per person — `1. Name - U0123 - mail@x - Title`
 * — so it parses without the model in between. The email comes along when the
 * profile shows it, because a first name alone is rarely unique.
 */
export async function findSlackPeople(name: string): Promise<SlackPerson[]> {
  const q = name.trim().slice(0, 80);
  if (!q) return [];
  await requireTools([T.searchUsers]);
  const raw = await connectorCall(T.searchUsers, { query: q, limit: 8, response_format: "concise" }, "find a colleague to send a session to");
  const people: SlackPerson[] = [];
  for (const line of body(raw).split("\n")) {
    const m = /^\s*\d+\.\s+(.+?)\s+-\s+([UW][A-Z0-9]{6,})(?:\s+-\s+(\S+@\S+))?(?:\s+-\s+(.*))?\s*$/.exec(line);
    if (m) people.push({ name: m[1]!, id: m[2]!, email: m[3] ?? "", title: (m[4] ?? "").trim() });
  }
  return people;
}

/** Upload the previewed file and share it in a DM with one person. */
export async function sendViaSlack(
  token: string,
  userId: string,
  comment: string,
): Promise<{ to: string; channel: string; link: string | null; name: string }> {
  if (!USER_ID.test(userId)) throw new Error("that is not a Slack user id");
  const file = preparedFile(token);
  await requireTools([T.openDm, T.uploadUrl, T.complete]);

  // 1. The DM. Opening one that already exists returns it.
  const dmRaw = await connectorCall(T.openDm, { user_ids: [userId] }, "open a DM to send a session file in");
  const dmError = refused(dmRaw);
  if (dmError) throw new Error(`Slack would not open the DM: ${dmError}`);
  const dmJson = parseJson(dmRaw);
  const channel: string | undefined =
    (typeof dmJson?.channel_id === "string" ? dmJson.channel_id : undefined) ??
    /Channel ID:\s*([DG][A-Z0-9]+)/.exec(body(dmRaw))?.[1];
  if (!channel || !/^[DG][A-Z0-9]+$/.test(channel)) throw new Error("Slack did not return a DM; nothing was sent");

  // 2. A signed upload URL for exactly this many bytes.
  const upRaw = await connectorCall(
    T.uploadUrl,
    { filename: file.name, content_length: file.bytes.length },
    "get an upload URL for a session file",
  );
  const upError = refused(upRaw);
  if (upError) throw new Error(`Slack refused the upload: ${upError}`);
  const upJson = parseJson(upRaw);
  const upText = body(upRaw).replace(/\\\//g, "/");
  const fileId: string | undefined =
    (typeof upJson?.file_id === "string" ? upJson.file_id : undefined) ?? /File ID:\s*(F[A-Z0-9]+)/.exec(upText)?.[1];
  const uploadUrl: string | undefined =
    (typeof upJson?.upload_url === "string" ? upJson.upload_url : undefined) ??
    /Upload URL:\s*(https:\/\/files\.slack\.com\/\S+)/.exec(upText)?.[1];
  if (!fileId || !uploadUrl) throw new Error("Slack did not return an upload URL; nothing was sent");
  if (!uploadUrl.startsWith("https://files.slack.com/")) throw new Error("unexpected upload address; nothing was sent");

  // 3. The bytes, straight from the daemon.
  const res = await fetch(uploadUrl, { method: "POST", headers: { "content-type": "application/gzip" }, body: file.bytes });
  if (!res.ok) throw new Error(`the upload failed (${res.status}); nothing was shared`);

  // 4. Share it in the DM the user picked.
  const doneRaw = await connectorCall(
    T.complete,
    { file_id: fileId, channel_id: channel, title: file.title ?? file.name, initial_comment: comment.slice(0, 2000) },
    "share a session file in the DM the user confirmed",
  );
  const doneError = refused(doneRaw);
  if (doneError) throw new Error(`the file was uploaded but Slack would not share it: ${doneError}`);
  const link = /(https:\/\/[^\s"'<>)]*slack\.com\/files\/[^\s"'<>)]+)/.exec(body(doneRaw).replace(/\\\//g, "/"))?.[1] ?? null;
  return { to: userId, channel, link, name: file.name };
}
