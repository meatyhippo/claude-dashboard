import { useEffect, useMemo, useState } from "react";
import type { DsChange, DsLeaf, DsOutcome, DsReport, DsTest } from "../../shared/baDataShaper.ts";
import { baApi } from "../api.ts";
import { Markdown } from "./Markdown.tsx";
import { toast } from "./Toasts.tsx";
import { CopyIcon, DiffIcon } from "./Icons.tsx";

/**
 * BA edition: a session's DataShaper work at a glance. Each mapping change with
 * the reasoning behind it, every attempt (blocked, waiting for Qargo's approval,
 * rejected, created), the changed expressions before → after, and the test runs
 * that back it up. Copy it as Markdown, or add it to the integration request the
 * session belongs to.
 */

type Report = DsReport & { irUrl?: string | null; irTitle?: string | null; projectId?: number | null };

const OUTCOME: Record<DsOutcome, { label: string; tone: string }> = {
  ok: { label: "Done", tone: "ok" },
  blocked: { label: "Blocked by auto mode", tone: "warn" },
  approval: { label: "Waiting for Qargo approval", tone: "warn" },
  error: { label: "Failed", tone: "bad" },
  pending: { label: "Running", tone: "idle" },
};

const leafText = (l: DsLeaf | null | undefined): string =>
  !l ? "" : l.raw ?? [l.value ?? "", l.variables ? `\n// variables\n${l.variables}` : ""].join("").trim();

/** A line diff (LCS): small expressions, so the simple table is plenty. */
function lineDiff(a: string, b: string): { kind: "ctx" | "add" | "del"; text: string }[] {
  const x = a ? a.split("\n") : [];
  const y = b ? b.split("\n") : [];
  if (x.length * y.length > 250_000) return [...x.map((t) => ({ kind: "del" as const, text: t })), ...y.map((t) => ({ kind: "add" as const, text: t }))];
  const m = x.length, n = y.length;
  const L = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i--) for (let j = n - 1; j >= 0; j--) L[i]![j] = x[i] === y[j] ? L[i + 1]![j + 1]! + 1 : Math.max(L[i + 1]![j]!, L[i]![j + 1]!);
  const out: { kind: "ctx" | "add" | "del"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < m && j < n) {
    if (x[i] === y[j]) (out.push({ kind: "ctx", text: x[i]! }), i++, j++);
    else if (L[i + 1]![j]! >= L[i]![j + 1]!) out.push({ kind: "del", text: x[i++]! });
    else out.push({ kind: "add", text: y[j++]! });
  }
  while (i < m) out.push({ kind: "del", text: x[i++]! });
  while (j < n) out.push({ kind: "add", text: y[j++]! });
  return out;
}

const pretty = (s: string | null) => {
  if (!s) return "";
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
};

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { weekday: "short", hour: "2-digit", minute: "2-digit" }) : "");

/** The report as Markdown: for Notion, Slack or a ticket. */
export function reportMarkdown(r: Report, before: Record<string, Record<string, DsLeaf | null>>): string {
  const out: string[] = ["## DataShaper changes"];
  for (const c of r.changes) {
    out.push(
      `### ${c.name ?? `Mapping ${c.baseRowId?.slice(0, 8) ?? ""}`} · ${c.prod ? "PRODUCTION" : "test"}${c.tenant ? ` (${c.tenant})` : ""}`,
      `**Status:** ${OUTCOME[c.outcome].label}${c.attempts.length > 1 ? ` after ${c.attempts.length} attempts` : ""}${c.at ? ` · ${time(c.at)}` : ""}`,
    );
    if (c.versionDescription) out.push(`**Version note:** ${c.versionDescription}`);
    const created = c.attempts.find((a) => a.rowId)?.rowId;
    if (created) out.push(`**New version:** \`${created}\`${c.baseRowId ? ` (based on \`${c.baseRowId}\`)` : ""}`);
    out.push("", "**Changed fields**");
    for (const f of c.fields) {
      const b = before[c.id]?.[f.path];
      out.push(`- \`${f.path}\`${b === undefined ? "" : b ? " (changed)" : " (new)"}`, "```", leafText(f), "```");
    }
    if (c.analysis) out.push("", "**Why**", c.analysis);
  }
  const tests = r.tests.filter((t) => t.outcome !== "pending");
  if (tests.length) {
    out.push("### Tests");
    for (const t of tests) {
      out.push(`- ${t.outcome === "ok" ? "✅" : "❌"} ${t.expressions.map((e) => `\`${e.path}\``).join(", ") || "transform"}${t.errors.length ? `: ${t.errors.join("; ")}` : ""}`);
      if (t.output) out.push("  ```json", ...pretty(t.output).split("\n").map((l) => `  ${l}`), "  ```");
    }
  }
  if (r.conclusion) out.push("### Conclusion", r.conclusion);
  return out.join("\n");
}

/** Word-level diff for expressions that live on one long line: which part changed, not just that it did. */
function tokenDiff(a: string, b: string): { kind: "ctx" | "add" | "del"; text: string }[] {
  const split = (t: string) => t.split(/(\s+|[(){}\[\],;:&|?=<>!+*/-])/).filter((x) => x !== "");
  return lineDiff(split(a).join("\n"), split(b).join("\n"));
}

function Diff({ before, after, loading }: { before: DsLeaf | null | undefined; after: DsLeaf; loading: boolean }) {
  const rows = useMemo(() => lineDiff(leafText(before), leafText(after)), [before, after]);
  if (before === undefined)
    return (
      <pre className="ds-code">
        {leafText(after)}
        {loading && <span className="ba-muted">{"\n"}(reading the version it was based on…)</span>}
      </pre>
    );
  if (before && leafText(before) === leafText(after)) return <pre className="ds-code">{leafText(after)}<span className="ba-muted">{"\n"}(unchanged)</span></pre>;
  const oldText = leafText(before), newText = leafText(after);
  if (before && oldText.split("\n").length <= 6 && newText.split("\n").length <= 6) {
    const toks = tokenDiff(oldText, newText);
    return (
      <div className="ds-words">
        <pre className="ds-code">
          <span className="ds-side">before</span>
          {toks.filter((t) => t.kind !== "add").map((t, i) => (t.kind === "del" ? <del key={i}>{t.text}</del> : <span key={i}>{t.text}</span>))}
        </pre>
        <pre className="ds-code">
          <span className="ds-side">after</span>
          {toks.filter((t) => t.kind !== "del").map((t, i) => (t.kind === "add" ? <ins key={i}>{t.text}</ins> : <span key={i}>{t.text}</span>))}
        </pre>
      </div>
    );
  }
  return (
    <pre className="ds-code ds-diff">
      {rows.map((r, i) => (
        <div key={i} className={`ds-line ${r.kind}`}>
          <span className="ds-sign">{r.kind === "add" ? "+" : r.kind === "del" ? "−" : " "}</span>
          {r.text || " "}
        </div>
      ))}
    </pre>
  );
}

function ChangeCard({ c, before, loading, baseError }: { c: DsChange; before: Record<string, DsLeaf | null> | undefined; loading: boolean; baseError: string | null }) {
  const [why, setWhy] = useState(false);
  const created = c.attempts.find((a) => a.rowId)?.rowId;
  const approval = [...c.attempts].reverse().find((a) => a.approvalUrl)?.approvalUrl;
  return (
    <div className={`ds-card ${c.prod ? "prod" : ""}`}>
      <div className="ds-card-head">
        <strong>{c.name ?? `Mapping ${c.baseRowId?.slice(0, 8) ?? ""}`}</strong>
        <span className={`ds-env ${c.prod ? "prod" : "test"}`}>{c.prod ? "PROD" : "TEST"}</span>
        {c.tenant && <span className="ba-muted">{c.tenant}</span>}
        <span className={`ds-pill ${OUTCOME[c.outcome].tone}`}>{OUTCOME[c.outcome].label}</span>
        <span className="ba-muted ds-when">{time(c.at)}</span>
      </div>
      {c.versionDescription && <div className="ds-note">“{c.versionDescription}”</div>}
      {c.attempts.length > 1 && (
        <div className="ds-attempts">
          {c.attempts.map((a, i) => (
            <span key={i} className={`ds-step ${OUTCOME[a.outcome].tone}`} title={a.message ?? ""}>
              {i + 1}. {a.outcome === "ok" ? "Created" : a.outcome === "approval" ? "Approval" : a.outcome === "blocked" ? "Blocked" : a.outcome === "pending" ? "Running" : "Error"}
            </span>
          ))}
        </div>
      )}
      {c.outcome === "approval" && approval && (
        <div className="mcp-warn">
          Production write protection: approve it in Qargo within 5 minutes of the request.
          <a className="icon-btn primary" href={approval} target="_blank" rel="noreferrer">
            Approve in Qargo ↗
          </a>
        </div>
      )}
      {c.outcome === "error" && <div className="chat-error">{c.attempts[c.attempts.length - 1]?.message}</div>}
      {created && (
        <div className="ba-muted ds-ids">
          New version <code>{created}</code>
          {c.baseRowId ? (
            <>
              {" "}· based on <code>{c.baseRowId}</code>
            </>
          ) : null}
        </div>
      )}
      {c.analysis && (
        <div className={`ds-why ${why ? "open" : ""}`}>
          <button className="ds-why-toggle" onClick={() => setWhy(!why)}>
            {why ? "▾" : "▸"} Why — Claude's analysis
          </button>
          <div className="ds-why-body">
            <Markdown text={c.analysis} />
          </div>
        </div>
      )}
      <div className="ds-fields">
        {(() => {
          // With the base version read, what really changed comes first and the rest folds away.
          const same = (f: DsLeaf) => !!before && !!before[f.path] && leafText(before[f.path]) === leafText(f);
          const changed = c.fields.filter((f) => !same(f));
          const unchanged = c.fields.filter(same);
          const row = (f: DsLeaf) => (
            <div key={f.path} className="ds-field">
              <code className="ds-path">
                {f.path}
                {before && before[f.path] === null && <span className="ds-new">new</span>}
              </code>
              <Diff before={before ? before[f.path] : undefined} after={f} loading={loading} />
            </div>
          );
          return (
            <>
              <div className="ds-fields-head">
                <DiffIcon /> {before ? `${changed.length} of ${c.fields.length} field${c.fields.length === 1 ? "" : "s"} changed` : `${c.fields.length} field${c.fields.length === 1 ? "" : "s"} set`}
                {baseError && <span className="ba-muted"> · before not available: {baseError}</span>}
              </div>
              {changed.map(row)}
              {unchanged.length > 0 && (
                <details className="ds-same">
                  <summary>
                    {unchanged.length} field{unchanged.length === 1 ? "" : "s"} set but unchanged
                  </summary>
                  {unchanged.map(row)}
                </details>
              )}
            </>
          );
        })()}
      </div>
    </div>
  );
}

function TestRow({ t }: { t: DsTest }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`ds-test ${t.outcome}`}>
      <button className="ds-test-head" onClick={() => setOpen(!open)}>
        <span className={`ds-pill ${OUTCOME[t.outcome].tone}`}>{t.outcome === "ok" ? "Passed" : t.outcome === "pending" ? "Running" : "Failed"}</span>
        <span>{t.expressions.map((e) => e.path).join(", ") || "transform"}</span>
        <span className="ba-muted ds-when">{time(t.at)}</span>
      </button>
      {t.errors.length > 0 && <div className="chat-error">{t.errors.join("; ")}</div>}
      {open && (
        <div className="ds-io">
          <div>
            <h5>Input</h5>
            <pre className="ds-code">{t.input}</pre>
          </div>
          <div>
            <h5>Output</h5>
            <pre className="ds-code">{pretty(t.output) || "—"}</pre>
          </div>
          {t.expressions.length > 0 && (
            <div className="ds-io-wide">
              <h5>Expressions tested</h5>
              {t.expressions.map((e) => (
                <div key={e.path}>
                  <code className="ds-path">{e.path}</code>
                  <pre className="ds-code">{leafText(e)}</pre>
                </div>
              ))}
            </div>
          )}
          {t.analysis && (
            <div className="ds-io-wide">
              <h5>What Claude expected</h5>
              <Markdown text={t.analysis} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default function DataShaperPanel({ sessionId, agentKey, live, compact }: { sessionId: string; agentKey?: string | null; live?: boolean; compact?: boolean }) {
  const [report, setReport] = useState<Report | null>(null);
  const [before, setBefore] = useState<Record<string, Record<string, DsLeaf | null>>>({});
  const [baseErr, setBaseErr] = useState<Record<string, string>>({});
  const [loadingBase, setLoadingBase] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState(!compact);
  const [irDraft, setIrDraft] = useState<string | null>(null);
  const [posting, setPosting] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = () =>
      baApi
        .datashaper(sessionId, agentKey)
        .then((r) => alive && setReport(r))
        .catch(() => {});
    load();
    const t = live ? setInterval(load, 15_000) : null;
    return () => {
      alive = false;
      if (t) clearInterval(t);
    };
  }, [sessionId, agentKey, live]);

  // The "before" side: read each base version once, when the changes are on screen.
  useEffect(() => {
    if (!report || !open) return;
    for (const c of report.changes) {
      if (!c.baseRowId || !c.tenant || before[c.id] || baseErr[c.id] || loadingBase.has(c.id)) continue;
      setLoadingBase((s) => new Set(s).add(c.id));
      baApi
        .datashaperBase({ server: c.server, tenant: c.tenant, rowId: c.baseRowId, paths: c.fields.map((f) => f.path) })
        .then((r) => setBefore((b) => ({ ...b, [c.id]: r.fields })))
        .catch((e) => setBaseErr((b) => ({ ...b, [c.id]: String(e?.message ?? e).slice(0, 120) })))
        .finally(() => setLoadingBase((s) => (s.delete(c.id), new Set(s))));
    }
  }, [report, open]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!report || (report.changes.length === 0 && report.tests.length === 0)) return null;
  const md = () => reportMarkdown(report, before);
  const copy = () =>
    void navigator.clipboard.writeText(md()).then(
      () => toast({ title: "Copied as Markdown", tone: "success", duration: 3000 }),
      () => toast({ title: "Could not copy", tone: "error" }),
    );
  const addToIr = () => {
    if (!report.irUrl || !irDraft) return;
    setPosting(true);
    baApi
      .action({
        kind: "prompt",
        projectId: report.projectId ?? null,
        url: report.irUrl,
        label: report.irTitle ?? "Integration request",
        prompt:
          "Add the DataShaper change report below to this integration request in Notion. Append it as a new section at the end of the page " +
          "(heading “DataShaper changes · <today's date>”), keeping the text as it is and leaving every other part of the page untouched. " +
          "Show me the section you'll add before you write it.\n\n<report>\n" +
          irDraft +
          "\n</report>",
      })
      .then((r) => {
        setIrDraft(null);
        if (r.url) window.open(r.url, "_blank", "noopener");
        toast({ title: "Adding it to the integration request", description: "A session shows the section before it writes.", tone: "success", duration: 8000, action: r.url ? undefined : { label: "Open", run: () => void (window.location.hash = `#/session/${encodeURIComponent(r.key)}`) } });
      })
      .catch((e) => toast({ title: "Could not start it", description: String(e?.message ?? e), tone: "error" }))
      .finally(() => setPosting(false));
  };
  const done = report.changes.filter((c) => c.outcome === "ok").length;
  const waiting = report.changes.filter((c) => c.outcome === "approval" || c.outcome === "blocked").length;

  return (
    <div className={`panel ds-panel ${compact ? "compact" : ""}`}>
      <div className="ds-head">
        <button className="ds-title" onClick={() => setOpen(!open)}>
          {compact && (open ? "▾ " : "▸ ")}
          <strong>DataShaper</strong>
          <span className="ba-muted">
            {report.changes.length} change{report.changes.length === 1 ? "" : "s"}
            {done ? ` · ${done} done` : ""}
            {waiting ? ` · ${waiting} waiting` : ""} · {report.tests.length} test{report.tests.length === 1 ? "" : "s"}
          </span>
        </button>
        <span className="ds-actions">
          <button className="icon-btn ghost" onClick={copy} title="Copy the changes, tests and analysis as Markdown">
            <CopyIcon /> Markdown
          </button>
          {report.irUrl && (
            <button className="icon-btn" onClick={() => setIrDraft(irDraft === null ? md() : null)} title={`Add this report to ${report.irTitle ?? "the integration request"} in Notion`}>
              Add to integration request
            </button>
          )}
        </span>
      </div>
      {irDraft !== null && (
        <div className="ds-ir">
          <span className="ba-muted">
            Added as a new section at the end of <a href={report.irUrl!} target="_blank" rel="noreferrer">{report.irTitle ?? "the integration request"}</a>. Edit it first if you like:
          </span>
          <textarea className="ba-prompt" rows={10} value={irDraft} onChange={(e) => setIrDraft(e.target.value)} />
          <div className="ba-row">
            <button className="icon-btn primary" disabled={posting || !irDraft.trim()} onClick={addToIr}>
              {posting ? "Starting…" : "Add to Notion"}
            </button>
            <button className="icon-btn ghost" onClick={() => setIrDraft(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="ds-body">
          {report.changes.map((c) => (
            <ChangeCard key={c.id} c={c} before={before[c.id]} loading={loadingBase.has(c.id)} baseError={baseErr[c.id] ?? null} />
          ))}
          {report.tests.length > 0 && (
            <div className="ds-tests">
              <h4>Test runs</h4>
              {report.tests.map((t) => (
                <TestRow key={t.id} t={t} />
              ))}
            </div>
          )}
          {report.conclusion && (
            <details className="ds-conclusion">
              <summary>Claude's conclusion</summary>
              <Markdown text={report.conclusion} />
            </details>
          )}
        </div>
      )}
    </div>
  );
}
