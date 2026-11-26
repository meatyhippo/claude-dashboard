import { BoltIcon, SparkIcon } from "./BaIcons.tsx";
import { ClipIcon, DocIcon } from "./Icons.tsx";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BaCustomer, BaMailThread, BaMailView, BaTriageThread, Cached } from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";
import { baFlags } from "../baFlags.ts";
import { ago, IrPicker, useAction } from "./CustomerPanels.tsx";
import { MailComposer, type ComposerHandle } from "./MailComposer.tsx";
import { RunWhere } from "./RunWhere.tsx";
import { cleanMail } from "../../shared/mailClean.ts";

/**
 * BA edition: Front as a mailbox.
 *
 * Folders on the left (your inbox, mail you are mentioned in, mail you follow,
 * what is placed at customers, and each customer), the list in the middle, the
 * conversation on the right with placement, actions and a reply box. Mentioned and
 * followed mail is placed at a customer automatically when Notion is sure (IR Front
 * Link or email domain). Replies are drafted first, their recipients shown, and only
 * sent on a second click.
 */

type View = BaMailView;
type Mail = Cached<BaTriageThread[]> & { seenIds: string[]; pending?: number };
const VIEWS: { key: View; label: string; hint: string; sub?: boolean }[] = [
  { key: "inbox", label: "Open", hint: "Open conversations assigned to you or in your inboxes" },
  { key: "assigned", label: "Assigned to me", hint: "Open conversations assigned to you (Front: assignee:me)", sub: true },
  { key: "subscribed", label: "Subscribed", hint: "Open conversations you are subscribed to (Front: is:subscribed)", sub: true },
  { key: "mentions", label: "Mentions", hint: "Conversations where you are @mentioned (open, last 14 days)" },
  { key: "drafts", label: "Drafts", hint: "Your unsent Front drafts, including the ones Claude wrote in a chat" },
  { key: "placed", label: "Placed at customers", hint: "Everything already placed at one of your customers" },
];

function when(at: number | null): string {
  if (!at) return "";
  const d = new Date(at);
  const today = new Date();
  return d.toDateString() === today.toDateString() ? d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** The message without images, quoted history, disclaimers and tracking; its useful links as chips; the original one click away. */
function MessageBody({ text }: { text: string }) {
  const [original, setOriginal] = useState(false);
  const clean = useMemo(() => cleanMail(text), [text]);
  if (!text) return <div className="mb-msg-body ba-muted">(no text; open in Front for attachments)</div>;
  return (
    <>
      <div className="mb-msg-body">{original ? text : clean.text || <span className="ba-muted">(only quoted text)</span>}</div>
      {!original && clean.links.length > 0 && (
        <div className="mb-links">
          {clean.links.map((l, li) => (
            <a key={`${li}-${l.url}`} className={`mb-link ${l.kind}`} href={l.url} target="_blank" rel="noreferrer" title={l.url}>
              {l.kind === "qargo" ? "◆ " : l.kind === "notion" ? "▣ " : l.kind === "doc" ? <DocIcon /> : "↗ "}
              {l.label}
            </a>
          ))}
        </div>
      )}
      {clean.trimmed && (
        <button className="mb-original" onClick={() => setOriginal(!original)}>
          {original ? "Show cleaned" : "Show original"}
        </button>
      )}
    </>
  );
}

/** Your unsent Front draft on this conversation: read it here, send it after seeing who gets it, or edit it in Front. */
function DraftBox({ t, onSent }: { t: BaTriageThread; onSent: () => void }) {
  const d = t.draft!;
  const [full, setFull] = useState<{ text: string; to: string[] } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [more, setMore] = useState(true);
  const box = useRef<HTMLDivElement>(null);
  // The full text arrives after the thread: put the draft's start in view again once it has its height.
  useEffect(() => {
    if (full) box.current?.scrollIntoView({ block: "start" });
  }, [full]);
  useEffect(() => {
    setFull(null);
    setConfirm(false);
    setState("idle");
    void baApi.draft(d.id).then(setFull).catch((e) => setErr(String(e?.message ?? e)));
  }, [d.id]);
  const send = async () => {
    setState("sending");
    try {
      await baApi.reply(t.id, { mode: "send", body: "", draftId: d.id });
      setState("sent");
      onSent();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setState("idle");
    }
  };
  return (
    <div className="mb-draftbox" ref={box}>
      <div className="mb-draftbox-head">
        <span className="mb-draft-tag">Your draft</span>
        {full?.to.length ? <span className="ba-muted">to {full.to.join(", ")}</span> : null}
        <a className="mb-draftbox-link front-btn" href={t.link} target="_blank" rel="noreferrer">Edit in Front ↗</a>
      </div>
      <div className={`mb-draftbox-text ${more ? "" : "clamp"}`}>{full ? cleanMail(full.text).text : d.preview}</div>
      {!full && !err && (
        <div className="mb-draftbox-loading" role="status">
          <span className="mb-spin" aria-hidden="true" /> Loading the full draft…
        </div>
      )}
      {full && cleanMail(full.text).text.length > 400 && (
        <button className="link-btn" onClick={() => setMore(!more)}>{more ? "Show less" : "Show the whole draft"}</button>
      )}
      {err && <p className="ba-error">{err}</p>}
      {state === "sent" ? (
        <p className="ba-muted">Sent.</p>
      ) : confirm ? (
        <div className="ba-row">
          <span>Send to {full?.to.join(", ") || "the original recipients"}?</span>
          <button className="icon-btn wb-next" disabled={state === "sending"} onClick={() => void send()}>{state === "sending" ? "Sending…" : "Yes, send"}</button>
          <button className="icon-btn ghost" onClick={() => setConfirm(false)}>Cancel</button>
        </div>
      ) : (
        <div className="ba-row">
          <button className="icon-btn" disabled={!full} onClick={() => setConfirm(true)}>Send this draft…</button>
        </div>
      )}
    </div>
  );
}

export function Reader({
  t,
  customers,
  onPlaced,
  onOpen,
  session,
}: {
  t: BaTriageThread;
  customers: BaCustomer[];
  onPlaced: (t: BaTriageThread, projectId: number | null, irUrl: string | null) => Promise<{ offerFrontLink?: boolean } | void> | void;
  onOpen: (key: string) => void;
  /** In a session's context pane: the session writes the reply from its own investigation. */
  session?: { ask: (instructions: string) => void; asking: boolean; draft: { text: string; at: number } | null };
}) {
  const [thread, setThread] = useState<Cached<BaMailThread> | null>(null);
  const [busy, setBusy] = useState(false);
  const [mode, setMode] = useState<"reply" | "comment">("reply");
  // A thread with a Front draft: the reply box folds to one line so the thread and the whole draft get the room.
  const [composeOpen, setComposeOpen] = useState(false);
  useEffect(() => setComposeOpen(false), [t.id]);
  const folded = !!t.draft && !composeOpen;
  const composer = useRef<ComposerHandle>(null);
  const [empty, setEmpty] = useState(true);
  const [draft, setDraft] = useState<{ id: string; to: string[] } | null>(null);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState<number | null>(null);
  const [offer, setOffer] = useState<{ irUrl: string; projectId: number } | null>(null);
  const [creating, setCreating] = useState(false);
  const [drafting, setDrafting] = useState(false);
  const [ask, setAsk] = useState("");
  /** Claude writes the reply into the composer; nothing is sent or saved until you do. */
  const draftWithClaude = async () => {
    setDrafting(true);
    setError(null);
    try {
      const { text } = await baApi.suggestReply(t.id, projectId, ask);
      setMode("reply");
      // Wait a tick so the composer for "reply" is mounted before filling it.
      setTimeout(() => composer.current?.setText(text), 0);
      setNote("Draft from Claude: edit it, then Review & send.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setDrafting(false);
    }
  };
  // A draft the session wrote lands in the composer, as Claude's own drafts do.
  useEffect(() => {
    if (!session?.draft) return;
    setMode("reply");
    setTimeout(() => composer.current?.setText(session.draft!.text), 0);
    setNote("Draft from this session: edit it, then Review & send.");
  }, [session?.draft?.at]); // eslint-disable-line react-hooks/exhaustive-deps
  const { run, error: actionError } = useAction(onOpen);
  /** Place, and when the IR has no Front Link yet, offer to write this thread to it. */
  const placeAt = async (projectId: number | null, irUrl: string | null) => {
    const r = await onPlaced(t, projectId, irUrl);
    setOffer(r && r.offerFrontLink && irUrl && projectId ? { irUrl, projectId } : null);
  };
  const placedAt = t.link_?.projectId ?? null;
  const projectId = placedAt ?? pick ?? t.suggestion?.projectId ?? null;

  const load = useCallback(
    (refresh: boolean) => {
      setBusy(true);
      return baApi
        .thread(t.id, refresh)
        .then(setThread)
        .catch((e) => setThread({ data: null, error: String(e?.message ?? e), fetchedAt: Date.now(), stale: true }))
        .finally(() => setBusy(false));
    },
    [t.id],
  );
  useEffect(() => {
    composer.current?.clear();
    setDraft(null);
    setNote(null);
    setError(null);
    setPick(null);
    setOffer(null);
    void load(false);
  }, [load]);
  const [key, setKey] = useState<{ ask: string; details: string[]; needed: string } | null>(null);
  const [showActivity, setShowActivity] = useState(false);
  useEffect(() => {
    setKey(null);
    if (!thread?.data?.entries.some((e) => e.kind === "message")) return;
    let stale = false;
    void baApi.keyPoints(t.id).then((k) => !stale && setKey(k)).catch(() => {});
    return () => {
      stale = true;
    };
  }, [t.id, thread]);
  const [saved, setSaved] = useState<{ rel: string | null; files: string[]; error?: string | null } | null>(null);
  const [saving, setSaving] = useState(false);
  const hasFiles = (thread?.data?.entries ?? []).some((e) => (e.files ?? []).length > 0);
  useEffect(() => {
    setSaved(null);
    if (!placedAt) return;
    // Saving runs in the background after placing; look again shortly so the result shows.
    const look = () => void baApi.threadFiles(t.id).then(setSaved).catch(() => {});
    look();
    const id = setTimeout(look, 15_000);
    return () => clearTimeout(id);
  }, [t.id, placedAt, thread]);
  const bottom = useRef<HTMLDivElement>(null);
  // Braces matter: scrollIntoView returns a Promise in current browsers, and an effect must not return one.
  // With a draft, land on the draft's first line (the last email sits right above it), not on its end.
  useEffect(() => {
    const d = bottom.current?.parentElement?.querySelector(".mb-draftbox");
    if (d) d.scrollIntoView({ block: "start" });
    else bottom.current?.scrollIntoView({ block: "end" });
  }, [thread]);

  const submit = async (kind: "draft" | "review" | "comment") => {
    setSending(true);
    setError(null);
    try {
      if (kind === "comment") {
        await baApi.reply(t.id, { mode: "comment", body: composer.current?.text() ?? "" });
        setNote("Comment added.");
        composer.current?.clear();
        void load(true);
      } else {
        const r = await baApi.reply(t.id, { mode: "draft", body: composer.current?.html() ?? "", format: "html" });
        if (!r.draftId) throw new Error("Front did not return the draft; find it in Front.");
        if (kind === "draft") {
          setNote("Saved as a draft in Front.");
          composer.current?.clear();
        } else setDraft({ id: r.draftId, to: r.to ?? [] });
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };
  const send = async () => {
    if (!draft) return;
    setSending(true);
    try {
      await baApi.reply(t.id, { mode: "send", body: "", draftId: draft.id });
      setNote("Sent.");
      setDraft(null);
      composer.current?.clear();
      void load(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const th = thread?.data;
  // Who a reply-all reaches: the people on the last message, minus nobody we can know better here.
  const lastMsg = [...(th?.entries ?? [])].reverse().find((e) => e.kind === "message");
  const replyTo = [...new Set([...(lastMsg?.inbound ? [lastMsg.author] : []), ...(lastMsg?.to ?? [])])].filter(Boolean);
  const nameOf = (pid: number | null) => customers.find((c) => c.projectId === pid)?.name ?? "";
  return (
    <div className="mb-reader">
      <div className="mb-reader-head">
        <h2>{th?.subject ?? t.subject}</h2>
        <div className="ba-muted">{[t.from, th?.assignee ? `assigned to ${th.assignee}` : t.assignee, ...(th?.inboxes ?? [])].filter(Boolean).join(" · ")}</div>
        <div className="mb-actions">
          <a className="icon-btn ghost front-btn" href={t.link} target="_blank" rel="noreferrer">
            Open in Front ↗
          </a>
          <button className="icon-btn ghost" onClick={() => void load(true)} disabled={busy}>
            {busy ? "Loading…" : "Refresh"}
          </button>
          <button className="icon-btn" disabled={!projectId} title={projectId ? "" : "Place it at a customer first"} onClick={() => void run("ir-from-front", { projectId, url: t.link, label: t.subject })}>
            Create IR
          </button>
          <button className="icon-btn" onClick={() => void run("mail-session", { projectId, url: t.link, label: t.subject })} title="A session in this customer's folder with the mail, the customer and its IRs already loaded">
            Work on this in a session
          </button>
          <RunWhere compact />
        </div>
        <div className="mb-place">
          {placedAt ? (
            <>
              <span>
                At <a href={`#/project/${placedAt}`}>{nameOf(placedAt)}</a>
                {t.link_?.source === "auto" && <span className="ba-muted"> (placed automatically)</span>}
              </span>
              <IrPicker projectId={placedAt} value={t.link_?.irUrl ?? null} onChange={(u) => void placeAt(placedAt, u)} />
              <button className="icon-btn ghost" onClick={() => void placeAt(null, null)}>
                Unplace
              </button>
            </>
          ) : (
            <>
              {t.suggestion && (
                <span className="ba-suggest">
                  → <strong>{nameOf(t.suggestion.projectId)}</strong>
                  {t.suggestion.irTitle && <> · {t.suggestion.irTitle}</>} <span className="ba-muted">({t.suggestion.reason})</span>
                  <button className="icon-btn primary" onClick={() => void placeAt(t.suggestion!.projectId, t.suggestion!.irUrl)}>
                    Accept
                  </button>
                </span>
              )}
              <select className="icon-btn ba-select" value={pick ?? ""} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : null)}>
                <option value="">{t.suggestion ? "Somewhere else…" : "Place at customer…"}</option>
                {customers.map((c) => (
                  <option key={c.projectId} value={c.projectId}>
                    {c.name}
                  </option>
                ))}
              </select>
              {pick !== null && (
                <>
                  <IrPicker projectId={pick} value={null} onChange={(u) => void placeAt(pick, u)} />
                  <button className="icon-btn" onClick={() => void placeAt(pick, null)}>
                    Place
                  </button>
                </>
              )}
            </>
          )}
        </div>
        {!placedAt && t.create && (
          <div className="mb-create">
            <span>
              Not a customer yet: <strong>{t.create.group}</strong>
              {t.create.status && <span className="ba-muted"> · {t.create.status}</span>} <span className="ba-muted">({t.create.reason})</span>
            </span>
            <button
              className="icon-btn primary"
              disabled={creating}
              onClick={async () => {
                setCreating(true);
                try {
                  const { customer } = await baApi.createCustomer(t.create!.dealUrls, t.create!.group);
                  await placeAt(customer.projectId, null);
                } finally {
                  setCreating(false);
                }
              }}
            >
              {creating ? "Adding…" : "Add as customer & place here"}
            </button>
          </div>
        )}
        {offer && (
          <div className="mb-confirm">
            <span>This IR has no Front Link yet. Set this conversation as its Front Link in Notion?</span>
            <button
              className="icon-btn primary"
              onClick={() =>
                void baApi
                  .setFrontLink(offer.irUrl, t.link, offer.projectId)
                  .then(() => (setOffer(null), setNote("Front Link set on the IR.")))
                  .catch((e) => setError(String(e?.message ?? e)))
              }
            >
              Set Front Link
            </button>
            <button className="icon-btn ghost" onClick={() => setOffer(null)}>
              Not now
            </button>
          </div>
        )}
        {placedAt && hasFiles && (
          <div className="mb-saved">
            <ClipIcon />{" "}
            {saved?.files.length ? (
              <>
                {saved.files.length} attachment{saved.files.length > 1 ? "s" : ""} saved in <code>{saved.rel}</code>
                <button className="icon-btn ghost" onClick={() => void baApi.openFolder(placedAt, "finder", saved.rel ?? undefined)}>
                  Show in Finder
                </button>
              </>
            ) : (
              <span className="ba-muted">Attachments are saved to this customer's folder when the mail is placed.</span>
            )}
            {saved?.error && <span className="chat-error mb-saved-error">{saved.error}</span>}
            <button
              className="icon-btn ghost"
              disabled={saving}
              onClick={() => {
                setSaving(true);
                void baApi
                  .threadFiles(t.id, true)
                  .then(setSaved)
                  .finally(() => setSaving(false));
              }}
            >
              {saving ? "Saving…" : saved?.files.length ? "Check for new" : "Save attachments"}
            </button>
          </div>
        )}
        {actionError && <div className="chat-error">{actionError}</div>}
      </div>

      <div className="mb-thread">
        {thread?.error && <div className="chat-error">{thread.error}</div>}
        {!th && !thread?.error && <div className="empty">Opening the conversation… (a few seconds the first time)</div>}
        <div className="mb-col">
        {key && (
          <div className="mb-key">
            <div className="mb-key-ask">{key.ask}</div>
            {key.details.length > 0 && (
              <ul>
                {key.details.map((d, i) => (
                  <li key={i}>{d}</li>
                ))}
              </ul>
            )}
            {key.needed && !/^nothing\.?$/i.test(key.needed) && (
              <div className="mb-key-needed">
                <strong>Needed from us:</strong> {key.needed}
              </div>
            )}
          </div>
        )}
        {(th?.entries.filter((e) => e.kind === "activity").length ?? 0) > 0 && (
          <button className="mb-activity-toggle" onClick={() => setShowActivity(!showActivity)}>
            {showActivity ? "Hide" : "Show"} {th!.entries.filter((e) => e.kind === "activity").length} status changes
          </button>
        )}
        {th?.entries.map((e, i) =>
          e.kind === "activity" ? (
            showActivity ? (
              <div key={i} className="mb-activity">
                {e.text} {e.at ? `· ${ago(e.at)}` : ""}
              </div>
            ) : null
          ) : (
            <div key={i} className={`mb-msg ${e.kind} ${e.inbound ? "in" : "out"}`}>
              <div className="mb-msg-head">
                <strong>{e.author}</strong>
                {e.kind === "comment" && <span className="ba-chip ghost">internal comment</span>}
                {e.to.length > 0 && <span className="ba-muted">to {e.to.join(", ")}</span>}
                <span className="ba-muted mb-msg-time">{e.at ? new Date(e.at).toLocaleString() : ""}</span>
              </div>
              <MessageBody text={e.text} />
              {(() => {
                // Inline signature images (image001.png, logos) are noise; each real file once.
                const files = [...new Set((e.attachments ?? []).filter((f) => !/^(image|outlook|logo)[-_ ]?\d*\.(png|jpe?g|gif|bmp)$/i.test(f)))];
                return files.length > 0 ? (
                  <div className="mb-files">
                    {files.map((f, fi) => (
                      <a key={`${fi}-${f}`} className="ba-chip ghost" href={t.link} target="_blank" rel="noreferrer" title="Open in Front to download">
                        <ClipIcon /> {f}
                      </a>
                    ))}
                  </div>
                ) : null;
              })()}
            </div>
          ),
        )}
        {t.draft && <DraftBox t={t} onSent={() => void load(true)} />}
        <div ref={bottom} />
        </div>
      </div>

      {folded ? (
        <div className="mb-compose folded">
          <button className="icon-btn ghost" onClick={() => setComposeOpen(true)}>Write a different reply or a comment</button>
        </div>
      ) : (
      <div className={`mb-compose ${mode}`}>
        <div className="ba-seg" role="tablist">
          <button role="tab" aria-selected={mode === "reply"} className={mode === "reply" ? "on" : ""} onClick={() => setMode("reply")}>
            Reply
          </button>
          <button role="tab" aria-selected={mode === "comment"} className={mode === "comment" ? "on" : ""} onClick={() => setMode("comment")}>
            Internal comment
          </button>
        </div>
        {mode === "reply" && (
          <div className="mc-claude">
            <input className="drawings-search" placeholder="Optional: what should the reply say? (e.g. confirm Thursday, ask for a sample file)" value={ask} onChange={(e) => setAsk(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !drafting && void draftWithClaude()} />
            {session ? (
              <button className="icon-btn primary" disabled={session.asking || !!draft} onClick={() => session.ask(ask)} title="The session writes the reply from what it found, and it lands here to edit">
                {session.asking ? "The session is writing…" : <><SparkIcon /> Draft from this session</>}
              </button>
            ) : (
              <button className="icon-btn" disabled={drafting || !!draft} onClick={() => void draftWithClaude()} title="Claude reads the conversation and what Notion knows about the customer, and writes the reply here">
                {drafting ? "Drafting…" : <><SparkIcon /> Draft with Claude</>}
              </button>
            )}
          </div>
        )}
        {mode === "reply" && replyTo.length > 0 && <div className="mc-to ba-muted">Reply-all to {replyTo.join(", ")}</div>}
        <MailComposer
          key={mode}
          ref={composer}
          plain={mode === "comment"}
          disabled={!!draft}
          onChange={setEmpty}
          onSubmit={() => !empty && !draft && void submit(mode === "reply" ? "review" : "comment")}
          placeholder={mode === "reply" ? "Write your reply… the last message is quoted below it." : "Internal note for teammates — @mention someone to notify them."}
        />
        {draft ? (
          <div className="mb-confirm">
            <span>
              Send to <strong>{draft.to.length ? draft.to.join(", ") : "the original recipients"}</strong>?
            </span>
            <button className="icon-btn primary" disabled={sending} onClick={() => void send()}>
              {sending ? "Sending…" : "Send now"}
            </button>
            <button className="icon-btn ghost" onClick={() => setDraft(null)} title="The draft stays in Front">
              Keep as draft
            </button>
          </div>
        ) : (
          <div className="ba-row">
            {mode === "reply" ? (
              <>
                <button className="icon-btn primary" disabled={empty || sending} onClick={() => void submit("review")}>
                  {sending ? "Preparing…" : "Review & send ⌘↵"}
                </button>
                <button className="icon-btn ghost" disabled={empty || sending} onClick={() => void submit("draft")}>
                  Save as draft
                </button>
              </>
            ) : (
              <button className="icon-btn primary" disabled={empty || sending} onClick={() => void submit("comment")}>
                {sending ? "Adding…" : "Add comment ⌘↵"}
              </button>
            )}
            {note && <span className="ba-muted">{note}</span>}
          </div>
        )}
        {error && <div className="chat-error">{error}</div>}
      </div>
      )}
    </div>
  );
}

export default function InboxView({ onOpen }: { onOpen: (key: string) => void }) {
  const [view, setView] = useState<View>("inbox");
  const [byView, setByView] = useState<Partial<Record<View, Mail>>>({});
  const [busy, setBusy] = useState<View | null>(null);
  const [customers, setCustomers] = useState<BaCustomer[]>([]);
  const [customerFilter, setCustomerFilter] = useState<number | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [q, setQ] = useState("");
  const [onlyTodo, setOnlyTodo] = useState(false);
  const [onlyAuto, setOnlyAuto] = useState(false);

  const load = useCallback((v: View, refresh: boolean) => {
    setBusy(v);
    return baApi
      .mail(v, refresh)
      .then((r) => setByView((m) => ({ ...m, [v]: r })))
      .catch((e) => setByView((m) => ({ ...m, [v]: { data: null, error: String(e?.message ?? e), fetchedAt: Date.now(), stale: true, seenIds: [] } })))
      .finally(() => setBusy(null));
  }, []);
  useEffect(() => {
    void baApi.customers().then((r) => setCustomers(r.customers)).catch(() => {});
  }, []);
  useEffect(() => {
    if (!byView[view]) void load(view, false);
  }, [view, byView, load]);
  // Front shows a count on every folder at once; read the other folders' lists quietly.
  useEffect(() => {
    for (const v of ["assigned", "subscribed", "mentions", "drafts"] as View[])
      void baApi
        .mail(v, false)
        .then((r) => setByView((m) => (m[v] ? m : { ...m, [v]: r })))
        .catch(() => {});
  }, []);
  // While conversations are still being read in the background, check back so senders and placements fill in.
  useEffect(() => {
    if (!byView[view]?.pending) return;
    const id = setTimeout(() => void load(view, false), 20_000);
    return () => clearTimeout(id);
  }, [view, byView, load]);

  // "Open draft in Inbox" from a chat: jump to Drafts with that conversation selected.
  useEffect(() => {
    const take = () => {
      let want: { view?: View; id?: string } | null = null;
      try {
        want = JSON.parse(sessionStorage.getItem("inbox-open") || "null");
        sessionStorage.removeItem("inbox-open");
      } catch {
        /* storage blocked */
      }
      if (!want?.id) return;
      setCustomerFilter(null);
      setQ("");
      if (want.view) {
        setView(want.view);
        void load(want.view, true);
      }
      setSelected(want.id);
    };
    take();
    window.addEventListener("inbox-open", take);
    return () => window.removeEventListener("inbox-open", take);
  }, [load]);

  const mail = byView[view];
  const seen = new Set(mail?.seenIds ?? []);
  const list = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (mail?.data ?? [])
      .filter((t) => customerFilter === null || t.link_?.projectId === customerFilter || (!t.link_ && t.suggestion?.projectId === customerFilter))
      .filter((t) => !onlyTodo || !t.link_)
      .filter((t) => !onlyAuto || t.link_?.source === "auto")
      .filter((t) => !needle || `${t.subject} ${t.from ?? ""} ${t.snippet ?? ""}`.toLowerCase().includes(needle))
      .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  }, [mail, customerFilter, onlyTodo, onlyAuto, q]);
  const current = list.find((t) => t.id === selected) ?? null;

  // Up/down (or j/k) move through the list, like a mail client.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.closest("textarea, input, select, [contenteditable]")) return;
      if (!["ArrowDown", "ArrowUp", "j", "k"].includes(e.key) || !list.length) return;
      e.preventDefault();
      const i = list.findIndex((t) => t.id === selected);
      const next = e.key === "ArrowDown" || e.key === "j" ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
      setSelected(list[next]!.id);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [list, selected]);

  const place = (t: BaTriageThread, projectId: number | null, irUrl: string | null) => {
    if (projectId !== null && !customers.some((c) => c.projectId === projectId)) void baApi.customers().then((r) => setCustomers(r.customers));
    const done = projectId === null ? baApi.untriage(t.id).then(() => ({})) : baApi.triage(t, projectId, irUrl, t.suggestion?.projectId === projectId ? "accepted" : "manual");
    return done.then((result) => {
      update(t, projectId, irUrl);
      return result;
    });
  };
  const update = (t: BaTriageThread, projectId: number | null, irUrl: string | null) =>
      setByView((m) => {
        const next: typeof m = {};
        for (const [k, v] of Object.entries(m) as [View, Mail][]) {
          next[k] = {
            ...v,
            data: (v.data ?? []).map((x) => (x.id === t.id ? { ...x, link_: projectId === null ? null : { threadId: t.id, projectId, irUrl, source: "manual" as const, linkedAt: Date.now() }, suggestion: projectId === null ? x.suggestion : null, create: null } : x)),
          };
        }
        return next;
      });

  const nameOf = (pid: number | null | undefined) => customers.find((c) => c.projectId === pid)?.name ?? "";
  const counts = (v: View) => byView[v]?.data?.length;
  const todo = (mail?.data ?? []).filter((t) => !t.link_).length;

  if (!baFlags.inbox) return null;
  return (
    <div className="page mb">
      <aside className="mb-folders">
        {VIEWS.map((v) => (
          <button key={v.key} className={`mb-folder ${v.sub ? "sub" : ""} ${view === v.key && customerFilter === null ? "on" : ""}`} title={v.hint} onClick={() => (setView(v.key), setCustomerFilter(null))}>
            <span>{v.label}</span>
            {counts(v.key) !== undefined && <em>{counts(v.key)}</em>}
          </button>
        ))}
        {customers.length > 0 && <div className="mb-folders-label">Customers</div>}
        {customers.map((c) => (
          <button key={c.projectId} className={`mb-folder ${customerFilter === c.projectId ? "on" : ""}`} onClick={() => setCustomerFilter(customerFilter === c.projectId ? null : c.projectId)}>
            <span>{c.name}</span>
          </button>
        ))}
      </aside>

      <section className="mb-list">
        <div className="mb-list-head">
          <input className="drawings-search" type="search" placeholder="Search mail" value={q} onChange={(e) => setQ(e.target.value)} />
          <button className="icon-btn ghost" onClick={() => void load(view, true)} disabled={busy === view} title="Read Front again">
            {busy === view ? "…" : "↻"}
          </button>
        </div>
        <div className="mb-list-sub ba-muted">
          <span>
            {VIEWS.find((v) => v.key === view)?.label}
            {customerFilter !== null ? ` · ${nameOf(customerFilter)}` : ""} · {mail ? `updated ${ago(mail.fetchedAt)}` : "loading…"}
            {mail?.pending ? ` · reading ${mail.pending} conversations…` : ""}
          </span>
          {view !== "placed" && (
            <span className="mb-filters">
              <label>
                <input type="checkbox" checked={onlyTodo} onChange={(e) => setOnlyTodo(e.target.checked)} /> To triage ({todo})
              </label>
              <label title="Placed automatically: check them, Unplace teaches the rules">
                <input type="checkbox" checked={onlyAuto} onChange={(e) => setOnlyAuto(e.target.checked)} /> <BoltIcon /> Auto ({(mail?.data ?? []).filter((t) => t.link_?.source === "auto").length})
              </label>
            </span>
          )}
        </div>
        {mail?.error && <div className="chat-error">{mail.error}</div>}
        {busy === view && !mail && <div className="empty">Reading Front… (10–60 s the first time)</div>}
        {mail?.data?.length === 0 && <div className="empty">{view === "inbox" ? "Nothing open. Inbox zero." : "Nothing here."}</div>}
        <div className="mb-rows" role="listbox" aria-label="Conversations">
          {list.map((t) => {
            const isNew = (mail?.seenIds.length ?? 0) > 0 && !seen.has(t.id);
            return (
              <button key={t.id} role="option" aria-selected={selected === t.id} className={`mb-row ${selected === t.id ? "on" : ""} ${isNew ? "new" : ""}`} onClick={() => setSelected(t.id)}>
                <div className="mb-row-top">
                  <span className="mb-from">
                    {isNew && <span className="ba-dot" />}
                    {t.from ?? "Unknown"}
                  </span>
                  <span className="mb-time">{when(t.updatedAt)}</span>
                </div>
                <div className="mb-subject">{t.subject}</div>
                {t.draft ? <div className="mb-snippet"><span className="mb-draft-tag">Draft</span> {t.draft.preview.slice(0, 180)}</div> : t.snippet && <div className="mb-snippet">{cleanMail(t.snippet).text.replace(/\s+/g, " ").slice(0, 180)}</div>}
                <div className="mb-tags">
                  {t.link_ ? (
                    <span className="ba-chip" title={t.link_.source === "auto" ? "Placed automatically" : undefined}>
                      {t.link_.source === "auto" ? <BoltIcon /> : ""}
                      {nameOf(t.link_.projectId) || "customer"}
                    </span>
                  ) : t.create ? (
                    <span className="ba-chip ghost">＋ {t.create.group}?</span>
                  ) : t.suggestion ? (
                    <span className="ba-chip ghost">→ {nameOf(t.suggestion.projectId)}?</span>
                  ) : (
                    <span className="ba-chip ghost">to triage</span>
                  )}
                  {t.tags.slice(0, 2).map((tag) => (
                    <span key={tag} className="ba-chip ghost">
                      {tag}
                    </span>
                  ))}
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {current ? (
        <Reader t={current} customers={customers} onPlaced={place} onOpen={onOpen} />
      ) : (
        <div className="mb-reader mb-empty">
          <div className="empty">Select a conversation. ↑ ↓ move through the list.</div>
        </div>
      )}
    </div>
  );
}
