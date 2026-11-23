import { useEffect, useState } from "react";
import type { BaCustomer, BaQaiQuestion } from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";
import { ago } from "./CustomerPanels.tsx";
import { Markdown } from "./Markdown.tsx";

/**
 * Qai in #ps_troubleshooting: the Slack bot with codebase access. Ask with the
 * customer's tenant, IR and Front links attached, see the exact message before
 * it is posted (as you), and read Qai's replies back here.
 *
 * Used three ways: the Qai page (all questions), a customer's Qai tab, and the
 * compact box in an IR workspace.
 */

type Known = { text: string; who: string; at: string | null; link?: string | null };
const QAI_ID = "U0C0Y7E5SQ4";
/** The raw Slack mention shown as people read it, and back. */
const showMention = (m: string) => m.replace(new RegExp(`<@${QAI_ID}(\\|[^>]*)?>`, "g"), "@Qai");
const plain = (m: string) => showMention(m).replace(/<https?:\/\/[^|>]+\|([^>]+)>/g, "$1").replace(/<(https?:\/\/[^>]+)>/g, "$1");
const wordsOf = (t: string) => new Set(plain(t).toLowerCase().replace(/@qai/g, "").split(/[^a-z0-9]+/).filter((w) => w.length >= 4));
/** Questions already asked that look like this one: shared words over the smaller question. */
function similar(q: string, known: Known[]): Known[] {
  const a = wordsOf(q);
  if (a.size < 3) return [];
  return known
    .map((k) => {
      const b = wordsOf(k.text);
      const shared = [...a].filter((w) => b.has(w)).length;
      return { k, score: shared / Math.max(1, Math.min(a.size, b.size)) };
    })
    .filter((x) => x.score >= 0.5)
    .sort((x, y) => y.score - x.score)
    .slice(0, 2)
    .map((x) => x.k);
}

export function QaiAsk({ projectId, irUrl, compact, onAsked, known = [] }: { projectId?: number | null; irUrl?: string | null; compact?: boolean; onAsked?: (q: BaQaiQuestion) => void; known?: Known[] }) {
  const [question, setQuestion] = useState("");
  const [preview, setPreview] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const compose = () =>
    baApi
      .composeQai(question, projectId, irUrl)
      .then((r) => setPreview(showMention(r.message)))
      .catch((e) => setError(String(e?.message ?? e)));
  const send = () => {
    if (!preview) return;
    setBusy(true);
    baApi
      .askQai({ question, message: preview, projectId, irUrl })
      .then((r) => {
        setQuestion("");
        setPreview(null);
        setError(null);
        onAsked?.(r.question);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className={`ba-qai-ask ${compact ? "compact" : ""}`}>
      <div className="ba-ask">
        <textarea
          className="ba-prompt"
          rows={compact ? 2 : 3}
          value={question}
          onChange={(e) => {
            setQuestion(e.target.value);
            setPreview(null);
          }}
          placeholder="Ask Qai (codebase access) — e.g. why did this dispatch fail, does this payload work against /v1/webhook/trip-import. Paste order or trip links."
        />
        {!preview ? (
          <button className="icon-btn" disabled={!question.trim()} onClick={() => void compose()}>
            Preview
          </button>
        ) : (
          <button className="icon-btn primary" disabled={busy} onClick={send} title="Posts to #ps_troubleshooting as you">
            {busy ? "Posting…" : "Post to #ps_troubleshooting"}
          </button>
        )}
      </div>
      {question.trim().length > 12 && similar(question, known).length > 0 && (
        <div className="qai-dupe">
          <strong>Already asked:</strong>
          {similar(question, known).map((k, i) => (
            <span key={i}>
              “{plain(k.text).slice(0, 140)}” <span className="ba-muted">— {k.who}{k.at ? `, ${k.at}` : ""}</span>
              {k.link && (
                <a href={k.link} target="_blank" rel="noreferrer">
                  {" "}
                  open ↗
                </a>
              )}
            </span>
          ))}
        </div>
      )}
      {preview && (
        <div className="ba-qai-preview">
          <span className="ba-muted">This is posted to #ps_troubleshooting as you (@Qai is added automatically):</span>
          <textarea className="ba-prompt" rows={Math.min(10, preview.split("\n").length + 1)} value={preview} onChange={(e) => setPreview(e.target.value)} />
        </div>
      )}
      {error && <div className="chat-error">{error}</div>}
    </div>
  );
}

function QaiQuestionView({ q, customers }: { q: BaQaiQuestion; customers: BaCustomer[] }) {
  const [cur, setCur] = useState(q);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setBusy(true);
    baApi
      .qaiReplies(cur.id)
      .then((r) => {
        setCur(r.question);
        setError(null);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setBusy(false));
  };
  const customer = customers.find((c) => c.projectId === cur.projectId)?.name;
  const replies = cur.replies ?? [];
  return (
    <div className="ba-qai-q">
      <div className="ba-ticket-head">
        <strong>{cur.question}</strong>
        <span className="ba-muted">{[customer, ago(cur.askedAt)].filter(Boolean).join(" · ")}</span>
        <span className="ba-fresh">
          {cur.repliesAt ? `${replies.length} repl${replies.length === 1 ? "y" : "ies"} · read ${ago(cur.repliesAt)}` : ""}
          <button className="icon-btn ghost" disabled={busy} onClick={load}>
            {busy ? "Reading…" : "Read replies"}
          </button>
          {cur.permalink && (
            <a className="icon-btn ghost" href={cur.permalink} target="_blank" rel="noreferrer">
              Slack ↗
            </a>
          )}
        </span>
      </div>
      {error && <div className="chat-error">{error}</div>}
      {replies.map((m, i) => (
        <div key={i} className={`ba-qai-reply ${m.fromQai ? "qai" : ""}`}>
          <span className="ba-muted">
            {m.author}
            {m.at ? ` · ${m.at}` : ""}
          </span>
          <Markdown text={m.text} />
        </div>
      ))}
    </div>
  );
}

export function QaiPanel({ projectId, irUrl }: { projectId?: number | null; irUrl?: string | null }) {
  const [questions, setQuestions] = useState<BaQaiQuestion[]>([]);
  const [today, setToday] = useState<{ author: string; text: string; at: string | null; fromQai: boolean }[] | null>(null);
  const [older, setOlder] = useState(false);
  useEffect(() => {
    void baApi.qaiToday().then((r) => setToday(r.data)).catch(() => setToday([]));
  }, []);
  const [customers, setCustomers] = useState<BaCustomer[]>([]);
  const [pick, setPick] = useState<number | null>(projectId ?? null);
  useEffect(() => {
    void baApi.qai(projectId).then((r) => setQuestions(irUrl ? r.questions.filter((q) => q.irUrl === irUrl) : r.questions));
    void baApi.customers().then((r) => setCustomers(r.customers)).catch(() => {});
  }, [projectId, irUrl]);
  return (
    <div className="ba-panel">
      {!projectId && (
        <div className="ba-row">
          <span className="ba-muted">About</span>
          <select className="icon-btn ba-select" value={pick ?? ""} onChange={(e) => setPick(e.target.value ? Number(e.target.value) : null)}>
            <option value="">No customer</option>
            {customers.map((c) => (
              <option key={c.projectId} value={c.projectId}>
                {c.name}
              </option>
            ))}
          </select>
        </div>
      )}
      <QaiAsk
        projectId={projectId ?? pick}
        irUrl={irUrl}
        onAsked={(q) => setQuestions([q, ...questions])}
        known={[
          ...(today ?? []).filter((m) => !m.fromQai).map((m) => ({ text: m.text, who: m.author, at: m.at })),
          ...questions.map((q) => ({ text: q.question, who: "you", at: new Date(q.askedAt).toLocaleDateString(), link: q.permalink })),
        ]}
      />
      {!irUrl && (
        <div className="qai-today">
          <h4>Asked today in #ps_troubleshooting</h4>
          {today === null && <p className="ba-muted">Reading the channel…</p>}
          {today?.length === 0 && <p className="ba-muted">No questions to Qai yet today.</p>}
          {today
            ?.filter((m) => !m.fromQai)
            .map((m, i) => (
              <div key={i} className="qai-today-item">
                <span className="ba-muted">
                  {m.author} · {m.at?.slice(11, 16)}
                </span>
                <span>{plain(m.text).replace(/^@Qai\s*/i, "").slice(0, 300)}</span>
              </div>
            ))}
        </div>
      )}
      <h4 className="qai-mine">Your questions {older ? "" : "today"}</h4>
      {(older ? questions : questions.filter((q) => new Date(q.askedAt).toDateString() === new Date().toDateString())).map((q) => (
        <QaiQuestionView key={q.id} q={q} customers={customers} />
      ))}
      {questions.length > 0 && (
        <button className="icon-btn ghost" onClick={() => setOlder(!older)}>
          {older ? "Only today" : `Show older (${questions.length})`}
        </button>
      )}
      {questions.length === 0 && <p className="ba-muted">No questions asked from here yet.</p>}
    </div>
  );
}

/** The Qai page: every question asked from the dashboard. */
export default function QaiView() {
  return (
    <div className="page ba-inbox">
      <div className="ba-panel-head">
        <h2>Qai</h2>
        <span className="ba-muted">#ps_troubleshooting · Qai has access to the Qargo codebase</span>
      </div>
      <QaiPanel />
    </div>
  );
}
