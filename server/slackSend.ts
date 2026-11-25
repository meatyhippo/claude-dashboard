import { connectorCall, connectorState, parseJson } from "./baConnector.ts";
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
  /** The connector's state: `connected`, `needs-auth`, `failed`, `disabled`, `pending` or `missing`. */
  state: string;
  /** Can find people. */
  search: boolean;
  /** Can open a DM and upload a file into it, so Send works. */
  upload: boolean;
  /** The tools Send needs that this connector lacks, by short name. */
  missing: string[];
};

const SLACK_SERVER = "claude.ai Slack";
const USER_ID = /^[UW][A-Z0-9]{6,}$/;
const short = (tool: string) => tool.slice(SLACK.length);

/**
 * The last check, in memory only: it belongs to this daemon's profile and goes
 * when the daemon does. A connector with everything Send needs is trusted for an
 * hour, one that lacks the upload tools for ten minutes, and anything else (not
 * connected yet, signed out, still connecting) is checked again every time.
 */
let last: { status: SlackStatus; at: number } | null = null;
let checking: Promise<SlackStatus> | null = null;

function freshFor(s: SlackStatus): number {
  if (s.upload) return 60 * 60_000;
  if (s.state === "connected") return 10 * 60_000;
  return 0;
}

async function check(): Promise<SlackStatus> {
  const c = await connectorState(SLACK_SERVER);
  const has = new Set(c.tools.map((t) => SLACK + t));
  const missing = Object.values(T).filter((t) => !has.has(t));
  return { state: c.status, search: has.has(T.searchUsers), upload: missing.length === 0, missing: missing.map(short) };
}

/** Which of the tools Send needs the user's Slack connector has. Takes about 5 s when not known. */
export async function slackStatus(refresh = false): Promise<SlackStatus> {
  if (!refresh && last && Date.now() - last.at < freshFor(last.status)) return last.status;
  checking ??= check()
    .then((status) => {
      last = { status, at: Date.now() };
      return status;
    })
    .finally(() => (checking = null));
  return checking;
}

async function requireTools(tools: string[]): Promise<void> {
  const s = await slackStatus();
  if (s.state !== "connected") throw new Error(`Slack isn't connected (${s.state}); connect it at claude.ai, or save the file and send it yourself`);
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

/** Slack's error codes for these calls, matched as whole tokens anywhere in a text result. */
const SLACK_ERROR =
  /(?<![A-Za-z0-9_])(not_in_channel|channel_not_found|is_archived|not_authed|invalid_auth|account_inactive|token_revoked|missing_scope|no_permission|restricted_action|user_not_found|cannot_dm_bot|file_not_found|file_upload_disabled|file_uploads_disabled|invalid_arguments|ratelimited|rate_limited|too_many_users|access_denied)(?![A-Za-z0-9_])/;

/**
 * A refusal Slack reported in the result itself. A tool that fails outright comes
 * back as an error, which connectorCall throws. This looks at structured fields,
 * at how the text begins, and for Slack's own error codes as whole tokens, never
 * for ordinary words: a result can echo the session's title ("Fix failed EDI
 * import") and still be a success. Callers also require their success marker,
 * so a refusal worded some other way still never reads as sent.
 */
function refused(raw: string): string | null {
  const j = parseJson(raw);
  if (j && typeof j === "object" && !Array.isArray(j)) {
    if (j.ok === false) return String(j.error ?? "not ok").slice(0, 300);
    if (typeof j.error === "string" && j.error) return j.error.slice(0, 300);
  }
  const t = body(raw).trimStart();
  if (/^(error|failed|unable|could not|couldn't|cannot|can't)\b/i.test(t)) return t.slice(0, 300);
  const code = SLACK_ERROR.exec(t)?.[1];
  return code ? `${code}: ${t.slice(0, 260)}` : null;
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
  ack: boolean,
  userId: string,
  comment: string,
): Promise<{ to: string; channel: string; link: string | null; name: string }> {
  if (!USER_ID.test(userId)) throw new Error("that is not a Slack user id");
  const file = preparedFile(token, ack);
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
  // Success is what the tool promises to return: the file id and a link to it.
  const doneText = body(doneRaw).replace(/\\\//g, "/");
  const link = /(https:\/\/[^\s"'<>)]*slack\.com\/files\/[^\s"'<>)]+)/.exec(doneText)?.[1] ?? null;
  if (!link && !doneText.includes(fileId))
    throw new Error("Slack did not confirm the share; look in the DM before sending again");
  return { to: userId, channel, link, name: file.name };
}
