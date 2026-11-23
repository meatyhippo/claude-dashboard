import { useEffect, useMemo, useState } from "react";
import { groupName, type BaCustomer, type BaDeal, type BaDealSuggestions, type Cached } from "../../shared/baCustomers.ts";
import { baApi } from "../api.ts";
import { Freshness } from "./CustomerPanels.tsx";

/**
 * BA edition: the customer directory. Every deal in Notion's Deals Extract worth
 * choosing from (Live and Onboarding customers, and the open pipeline), searchable,
 * with sites of one customer grouped under one name. Nothing becomes a customer in
 * the dashboard until you pick it: "Add as customer", or add it to one you have.
 */

type Tab = "suggested" | "mine" | "customers" | "pipeline";
const TABS: { key: Tab; label: string; hint: string }[] = [
  { key: "suggested", label: "Suggested", hint: "Deals worth adding: your role in Notion, mail you get from their domain, meetings this week" },
  { key: "mine", label: "Mine", hint: "Deals you are on: Presales SA, Responsible Integrations, onboarding or account manager" },
  { key: "customers", label: "Customers", hint: "Live and Onboarding (Closed-Won)" },
  { key: "pipeline", label: "Pipeline", hint: "Open deals (To be closed)" },
];
const PAGE = 60;

const inTab = (d: BaDeal, tab: Tab) =>
  tab === "suggested" ? false : tab === "mine" ? d.roles.length > 0 : tab === "customers" ? /^(live|onboarding)$/i.test(d.status ?? "") : /to be closed/i.test(d.status ?? "");

export default function MyDealsPanel({ onOpenCustomer }: { onOpenCustomer: (projectId: number) => void }) {
  const [all, setAll] = useState<Cached<BaDeal[]> | null>(null);
  const [mine, setMine] = useState<Cached<BaDeal[]> | null>(null);
  const [customers, setCustomers] = useState<BaCustomer[]>([]);
  const [busy, setBusy] = useState<"all" | "mine" | null>(null);
  const [tab, setTab] = useState<Tab>("suggested");
  const [suggest, setSuggest] = useState<BaDealSuggestions | null>(null);
  const loadSuggest = () => baApi.suggestDeals().then(setSuggest).catch(() => {});
  const [q, setQ] = useState("");
  const [shown, setShown] = useState(PAGE);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState<string | null>(null);
  const [open, setOpen] = useState<boolean | null>(null);

  const loadCustomers = () => baApi.customers().then((r) => setCustomers(r.customers));
  const loadMine = (refresh: boolean) => {
    setBusy("mine");
    return baApi
      .myDeals(refresh)
      .then(setMine)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setBusy(null));
  };
  const loadAll = (refresh: boolean) => {
    setBusy("all");
    return baApi
      .allDeals(refresh)
      .then(setAll)
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setBusy(null));
  };
  useEffect(() => {
    void loadCustomers();
    void loadMine(false);
    void loadSuggest();
  }, []);
  useEffect(() => {
    if ((tab === "customers" || tab === "pipeline" || tab === "suggested") && !all && busy !== "all") void loadAll(false);
    setShown(PAGE);
  }, [tab]);

  // One list: the directory plus your own deals, newest copy of each.
  const deals = useMemo(() => {
    const m = new Map<string, BaDeal>();
    for (const d of all?.data ?? []) m.set(d.url, d);
    for (const d of mine?.data ?? []) m.set(d.url, { ...m.get(d.url), ...d });
    return [...m.values()];
  }, [all, mine]);

  const groups = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const out = new Map<string, BaDeal[]>();
    for (const d of deals) {
      if (!inTab(d, tab)) continue;
      if (needle && !`${d.name} ${d.country ?? ""} ${d.dealStatus ?? ""}`.toLowerCase().includes(needle)) continue;
      const g = groupName(d.name);
      out.set(g, [...(out.get(g) ?? []), d]);
    }
    return [...out.entries()].sort(([a], [b]) => a.localeCompare(b));
  }, [deals, tab, q]);

  const nameOf = (pid: number) => customers.find((c) => c.projectId === pid)?.name ?? "a customer";
  const counts = (t: Tab) => (t === "suggested" ? (suggest?.suggested.length ?? 0) : new Set(deals.filter((d) => inTab(d, t)).map((d) => groupName(d.name))).size);
  const state = tab === "mine" ? mine : all;
  // Open by default until you have customers; a search always shows its results.
  const expanded = q.trim() !== "" || (open ?? customers.length === 0);

  const addAsCustomer = (name: string, ds: BaDeal[]) => {
    setAdding(name);
    return baApi
      .createCustomer(
        ds.filter((d) => !d.projectId).map((d) => d.url),
        name,
      )
      .then(async (r) => {
        await Promise.all([loadCustomers(), loadMine(false), all ? loadAll(false) : null, loadSuggest()]);
        onOpenCustomer(r.customer.projectId);
      })
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => setAdding(null));
  };
  const addTo = (ds: BaDeal[], projectId: number) =>
    baApi
      .assignDeals(
        ds.filter((d) => !d.projectId).map((d) => d.url),
        projectId,
      )
      .then(() => Promise.all([loadCustomers(), loadMine(false), all ? loadAll(false) : null, loadSuggest()]))
      .catch((e) => setError(String(e?.message ?? e)));

  return (
    <div className="ba-card ba-mydeals">
      <div className="ba-panel-head">
        <h3>Customer directory</h3>
        <span className="ba-muted">from Notion's Deals Extract · pick the ones you work on</span>
        <Freshness state={state} busy={busy !== null} onRefresh={() => void (tab === "mine" ? loadMine(true) : loadAll(true))} />
        <button className="icon-btn ghost" onClick={() => setOpen(!expanded)}>
          {expanded ? "Collapse" : "Browse"}
        </button>
      </div>
      <div className="ba-row">
        <span className="ba-seg" role="tablist">
          {TABS.map((t) => (
            <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? "on" : ""} title={t.hint} onClick={() => setTab(t.key)}>
              {t.label} {(t.key === "mine" || t.key === "suggested" || all) && <em>{counts(t.key)}</em>}
            </button>
          ))}
        </span>
        <input className="drawings-search" type="search" placeholder="Search deals, countries, stages" value={q} onChange={(e) => (setQ(e.target.value), setShown(PAGE))} />
      </div>
      {(error || state?.error) && <div className="chat-error">{error || state?.error}</div>}
      {tab !== "mine" && busy === "all" && !all && <p className="ba-muted">Reading every deal from Notion… about a minute the first time, then kept for 12 hours.</p>}
      {expanded && tab === "suggested" && (
        <div className="ba-suggested">
          {!suggest && <p className="ba-muted">Working out suggestions…</p>}
          {suggest?.suggested.length === 0 && <p className="ba-muted">No suggestions yet. They come from your roles in Notion, your mail (open the Inbox once) and this week's meetings.</p>}
          {suggest?.suggested
            .filter((s) => !q || s.group.toLowerCase().includes(q.toLowerCase()))
            .map((s) => (
              <div key={s.group} className="ba-sugg-row">
                <div className="ba-sugg-main">
                  <strong>{s.group}</strong>
                  {s.deals.length > 1 && <span className="ba-muted"> · {s.deals.length} deals</span>}
                  <span className="ba-muted"> · {[...new Set(s.deals.map((d) => d.status))].filter(Boolean).join(", ")}</span>
                  <div className="ba-sugg-reasons">
                    {s.reasons.map((r) => (
                      <span key={r} className="ba-chip">
                        {r}
                      </span>
                    ))}
                  </div>
                </div>
                <span className="ba-row">
                  <button className="icon-btn primary" disabled={adding === s.group} onClick={() => void addAsCustomer(s.group, s.deals)}>
                    {adding === s.group ? "Adding…" : "Add as customer"}
                  </button>
                  {customers.length > 0 && (
                    <select className="icon-btn ba-select" value="" onChange={(e) => e.target.value && void addTo(s.deals, Number(e.target.value))}>
                      <option value="">Add to…</option>
                      {customers.map((c) => (
                        <option key={c.projectId} value={c.projectId}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  )}
                </span>
              </div>
            ))}
          {(suggest?.unknownDomains.length ?? 0) > 0 && (
            <div className="ba-sugg-domains">
              <span className="ba-muted">Mail from domains with no deal match yet:</span>
              {suggest!.unknownDomains.map((d) => (
                <button key={d.domain} className="ba-chip ghost" title="Search the directory for it" onClick={() => (setTab("customers"), setQ(d.domain.split(".")[0]!))}>
                  {d.domain} · {d.mails}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {expanded && tab !== "suggested" && groups.length === 0 && state && <p className="ba-muted">{q ? `Nothing matches “${q}”.` : "No deals here."}</p>}
      {expanded && tab !== "suggested" && groups.length > 0 && (
        <table className="ba-table">
          <tbody>
            {groups.slice(0, shown).map(([name, ds]) => {
              const placedAt = [...new Set(ds.map((d) => d.projectId).filter((p): p is number => !!p))];
              const free = ds.filter((d) => !d.projectId);
              const roles = [...new Set(ds.flatMap((d) => d.roles))];
              return (
                <tr key={name} className="ba-dealrow">
                  <td>
                    <strong>{name}</strong>
                    {ds.length > 1 && <span className="ba-muted"> · {ds.length} deals</span>}
                    <div className="ba-muted">{[...new Set(ds.map((d) => d.status))].filter(Boolean).join(", ")} · {[...new Set(ds.map((d) => d.dealStatus))].filter(Boolean).join(", ")}{ds[0]?.country ? ` · ${ds[0].country}` : ""}</div>
                  </td>
                  <td className="ba-muted">{roles.join(", ")}</td>
                  <td className="ba-dealrow-actions">
                    {placedAt.map((p) => (
                      <button key={p} className="icon-btn ghost" onClick={() => onOpenCustomer(p)}>
                        {nameOf(p)} →
                      </button>
                    ))}
                    {free.length > 0 && (
                      <span className="ba-row">
                        <button className="icon-btn" disabled={adding === name} onClick={() => void addAsCustomer(name, free)}>
                          {adding === name ? "Adding…" : placedAt.length ? `Add ${free.length} more as customer` : "Add as customer"}
                        </button>
                        {customers.length > 0 && (
                          <select className="icon-btn ba-select" value="" onChange={(e) => e.target.value && void addTo(free, Number(e.target.value))}>
                            <option value="">Add to…</option>
                            {customers.map((c) => (
                              <option key={c.projectId} value={c.projectId}>
                                {c.name}
                              </option>
                            ))}
                          </select>
                        )}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {expanded && tab !== "suggested" && groups.length > shown && (
        <button className="icon-btn ghost" onClick={() => setShown(shown + PAGE)}>
          Show more ({groups.length - shown} left)
        </button>
      )}
    </div>
  );
}
