import { useEffect, useRef, useState } from "react";
import { agentApi, transferApi, type TransferPreview } from "../api.ts";
import { ImportIcon, SendIcon } from "./Icons.tsx";
import { toast } from "./Toasts.tsx";

function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

type Person = { id: string; name: string; email: string; title: string };

const defaultMessage = (title: string | null) =>
  `Here's a Claude session for you to pick up${title ? `: ${title}` : ""}. ` +
  "In the Claude Dashboard, go to History → Import session and pick this file.";

/**
 * Hand a session to a colleague over Slack.
 *
 * The preview comes first and is not skippable, because a session doing ticket
 * work has read customer emails, tenant data and Notion pages, and every word of
 * that is in the file. Naming the connectors it used is the quickest way to make
 * that concrete; a likely secret has to be acknowledged before anything leaves.
 *
 * The recipient is always picked from a search, never guessed: a file shared in
 * Slack cannot be unshared from here.
 */
export function ExportModal({ sessionId, onClose }: { sessionId: string; onClose: () => void }) {
  const [preview, setPreview] = useState<TransferPreview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState(false);

  const [who, setWho] = useState("");
  const [finding, setFinding] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [picked, setPicked] = useState<Person | null>(null);
  const [message, setMessage] = useState("");

  const [sending, setSending] = useState(false);
  const [sent, setSent] = useState<{ to: Person; link: string | null } | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    transferApi
      .preview(sessionId)
      .then((p) => {
        setPreview(p);
        setMessage(defaultMessage(p.title));
      })
      .catch((e: Error) => setError(e.message));
  }, [sessionId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && !sending && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, sending]);

  const secrets = preview?.secrets ?? [];
  const blocked = !preview || (secrets.length > 0 && !ack);
  const done = !!sent || !!saved;

  const find = () => {
    if (!who.trim() || finding) return;
    setFinding(true);
    setError(null);
    setPicked(null);
    transferApi
      .slackPeople(who)
      .then((r) => {
        setPeople(r.people);
        if (r.people.length === 1) setPicked(r.people[0]!);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setFinding(false));
  };

  const send = () => {
    if (!picked) return;
    setSending(true);
    setError(null);
    transferApi
      .slackSend(sessionId, picked.id, message)
      .then((r) => {
        setSent({ to: picked, link: r.link });
        toast({ title: `Sent to ${picked.name} on Slack`, description: preview?.title ?? undefined, tone: "success" });
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setSending(false));
  };

  const saveFile = () => {
    setError(null);
    transferApi
      .export(sessionId)
      .then((r) => setSaved(r.path))
      .catch((e: Error) => setError(e.message));
  };

  return (
    <>
      <div className="scrim" onClick={() => !sending && onClose()} />
      <div className="modal" role="dialog" aria-modal="true" aria-labelledby="transfer-title">
        <div className="modal-head">
          <div>
            <h3 id="transfer-title">Send to a colleague</h3>
            <p className="hint">
              Sends this session as a file in a Slack DM. They import it in their dashboard and carry on with the full
              history, signed in to Notion, Front and the rest as themselves.
            </p>
          </div>
        </div>

        {!preview && !error && <div className="empty">Reading the session…</div>}

        {preview && !done && (
          <>
            <dl className="transfer-facts">
              <dt>Session</dt>
              <dd>{preview.title ?? "Untitled"}</dd>
              <dt>Messages</dt>
              <dd>{preview.messages}</dd>
              <dt>Tools used</dt>
              <dd>{preview.mcpServers.length > 0 ? preview.mcpServers.join(", ") : "No MCP connectors"}</dd>
              <dt>File</dt>
              <dd>
                {fmtBytes(preview.bytes)}
                {preview.files > 0 && `, with ${preview.files} saved tool output${preview.files === 1 ? "" : "s"}`}
              </dd>
            </dl>
            <p className="hint">
              Everything Claude read in this session is in the file, customer data included. Send it only to colleagues.
            </p>
            {preview.large && <p className="hint">This is a large file and may take a while to upload.</p>}
            {secrets.length > 0 && (
              <div className="transfer-warn">
                <b>This looks like it contains credentials:</b>{" "}
                {secrets.map((s) => `${s.label}${s.count > 1 ? ` (${s.count})` : ""}`).join(", ")}. Anyone with the file
                can read them.
                <label className="check">
                  <input type="checkbox" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                  <span>I've checked; send it anyway</span>
                </label>
              </div>
            )}

            <div className="field transfer-field">
              <span id="transfer-to">Send to</span>
              <div className="transfer-find">
                <input
                  value={who}
                  placeholder="Name or email"
                  aria-labelledby="transfer-to"
                  disabled={sending}
                  onChange={(e) => setWho(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      find();
                    }
                  }}
                />
                <button className="icon-btn" disabled={!who.trim() || finding || sending} onClick={find}>
                  {finding ? "Searching…" : "Find"}
                </button>
              </div>
            </div>
            {people && people.length === 0 && <p className="hint">Nobody in Slack matched “{who}”.</p>}
            {people && people.length > 0 && (
              <div className="transfer-people" role="radiogroup" aria-label="Recipient">
                {people.map((p) => (
                  <label key={p.id} className={`transfer-person ${picked?.id === p.id ? "on" : ""}`}>
                    <input
                      type="radio"
                      name="transfer-person"
                      checked={picked?.id === p.id}
                      disabled={sending}
                      onChange={() => setPicked(p)}
                    />
                    <span className="transfer-person-name">{p.name}</span>
                    <span className="transfer-person-title">{[p.email, p.title].filter(Boolean).join(" · ")}</span>
                  </label>
                ))}
              </div>
            )}
            {picked && (
              <label className="field transfer-field">
                <span>Message</span>
                <textarea rows={3} value={message} disabled={sending} onChange={(e) => setMessage(e.target.value)} />
              </label>
            )}
            {sending && <p className="hint">Uploading and sharing in Slack; this takes about half a minute.</p>}
          </>
        )}

        {error && <p className="transfer-error">{error}</p>}

        {sent && (
          <p className="hint">
            Sent to <b>{sent.to.name}</b> in a Slack DM.{" "}
            {sent.link && (
              <a href={sent.link} target="_blank" rel="noreferrer">
                Open in Slack
              </a>
            )}
          </p>
        )}
        {saved && (
          <p className="hint">
            Saved to <code>{saved}</code>. It is selected in Finder and Slack is open: drag it into a message to your
            colleague.
          </p>
        )}

        <div className="modal-actions">
          {!done && (
            <button
              className="link-btn transfer-save"
              disabled={blocked || sending}
              title="Save the file to Downloads and send it yourself"
              onClick={saveFile}
            >
              Save file instead
            </button>
          )}
          <button className="icon-btn" disabled={sending} onClick={onClose}>
            {done ? "Done" : "Cancel"}
          </button>
          {!done && (
            <button className="icon-btn primary" disabled={blocked || !picked || sending} onClick={send}>
              <SendIcon /> {sending ? "Sending…" : picked ? `Send to ${picked.name.split(" ")[0]}` : "Send on Slack"}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/**
 * Take in a session a colleague sent. The file lands in this machine's Claude Code
 * profile under a new id and is resumed straight away, the way Resume on a History
 * row starts one, so it opens ready for the next message.
 */
export function ImportSessionButton({ onOpen }: { onOpen: (id: string, opts?: { full?: boolean }) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);

  const take = (file: File) => {
    setBusy(true);
    transferApi
      .import(file)
      .then(async (r) => {
        await agentApi.start({ cwd: r.cwd, resume: r.sessionId, title: r.title ?? undefined });
        toast({ title: "Session imported", description: r.title ?? undefined, tone: "success" });
        onOpen(r.sessionId, { full: true });
      })
      .catch((e: Error) => toast({ title: "Could not import that file", description: e.message, tone: "error" }))
      .finally(() => {
        setBusy(false);
        if (input.current) input.current.value = "";
      });
  };

  return (
    <>
      <input
        ref={input}
        type="file"
        accept=".claudesession"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) take(f);
        }}
      />
      <button
        className="icon-btn"
        disabled={busy}
        title="Open a .claudesession file a colleague sent you"
        onClick={() => input.current?.click()}
      >
        <ImportIcon /> {busy ? "Importing…" : "Import session"}
      </button>
    </>
  );
}
