import { useEffect, useState } from "react";
import { artifactKey } from "../../shared/artifacts.ts";
import type { BaCustomer, BaPublished } from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";

/**
 * BA edition: your artifacts published on claude.ai, and those shared with you,
 * linked to their local copy on this page and to the customers they are about.
 * Built from session transcripts plus a snapshot any Claude Code session can refresh.
 */
export default function PublishedArtifacts({ onOpen }: { onOpen: (key: string) => void }) {
  const [items, setItems] = useState<BaPublished[] | null>(null);
  const [customers, setCustomers] = useState<BaCustomer[]>([]);
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  useEffect(() => {
    void baApi.published().then((r) => setItems(r.published)).catch(() => setItems([]));
    void baApi.customers().then((r) => setCustomers(r.customers)).catch(() => {});
  }, []);
  if (!items?.length) return null;
  const nameOf = (pid: number) => customers.find((c) => c.projectId === pid)?.name;
  const shown = items.filter((p) => !q || p.title.toLowerCase().includes(q.toLowerCase()));
  return (
    <div className="ba-card ba-published">
      <div className="ba-panel-head">
        <h3>Published on claude.ai</h3>
        <span className="ba-muted">
          {items.filter((p) => p.owner === "mine").length} yours · {items.filter((p) => p.owner === "shared").length} shared with you · {items.filter((p) => p.localSlug).length} with a local copy
        </span>
        <button className="icon-btn ghost ba-fresh" onClick={() => setOpen(!open)}>
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open && (
        <>
          <input className="drawings-search" type="search" placeholder="Filter" value={q} onChange={(e) => setQ(e.target.value)} />
          {shown.map((p) => (
            <div key={p.url} className="ba-line ba-pub">
              <span className="ba-title">{p.title}</span>
              <a className="icon-btn ghost" href={p.url} target="_blank" rel="noreferrer">
                claude.ai ↗
              </a>
              <span className="ba-muted">{[p.owner === "shared" ? "shared with you" : null, p.updated].filter(Boolean).join(" · ")}</span>
              {p.projectIds.map((pid) => nameOf(pid) && (
                <a key={pid} className="ba-chip" href={`#/project/${pid}`}>
                  {nameOf(pid)}
                </a>
              ))}
              {p.kind !== "html" && <span className="ba-chip ghost" title="Built on a claude.ai artifact type: it only opens on claude.ai">{p.kind}</span>}
              {p.localSlug ? (
                <button className="icon-btn" onClick={() => onOpen(artifactKey(p.localSlug!))} title={p.localPath ?? ""}>
                  Open
                </button>
              ) : p.kind === "html" && p.owner === "mine" ? (
                <span className="ba-muted" title="Ask any Claude Code session: “download my published artifacts for the dashboard”">not downloaded yet</span>
              ) : null}
            </div>
          ))}
          <p className="ba-muted">
            Local copies live in your artifacts folder, so you can open and edit them here. To pick up newly published pages, ask any Claude Code session to “download my published artifacts for the dashboard” (the dashboard itself has no access to claude.ai artifacts).
          </p>
        </>
      )}
    </div>
  );
}
