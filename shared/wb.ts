/**
 * Workbench: Pieter's Integration Workbench on top of the BA edition.
 * The engineering issues assigned to you (Bugs and Feature development, "Me" view), split into
 * Scoping / Tasks / Change requests, each with its setup steps (Workbench Steps database) and a
 * Claude Code session of its own.
 */

export type WbTab = "scoping" | "tasks" | "cr";
export type WbStage = "backlog" | "current" | "test" | "hold";

export type WbStep = {
  url: string;
  name: string;
  order: number;
  phase: string;
  kind: "auto" | "manual";
  state: "pending" | "done" | "needs you" | "blocked" | "running";
  tool: string;
  check: string;
  result: string;
};

export type WbDeal = { url: string; name: string; status: string | null; sandbox: string; prod: string; slack: string; golive: string };

export type WbTicket = {
  url: string;
  id: string;
  task: string;
  type: string;
  status: string;
  priority: string;
  edited: string;
  /** The linked customer request (Customer Tasks). */
  request: string;
  reqKey: string;
  reqTask: string;
  reqType: string;
  reqCategory: string;
  reqStatus: string;
  /** The customer task's own "Priority " (e.g. "Needed for go-live"); empty in old cache. */
  reqPriority?: string;
  committed: string;
  front: string;
  log: string;
  integ: string[];
  customer: string;
  deal: WbDeal | null;
  /** Why a field could not be filled, for the row's tooltip. */
  diag: string;
  tab: WbTab;
  stage: WbStage;
};

/** Where a ticket stands: who has the ball. */
export type WbStateKey = "customer" | "external" | "dev";
export const WB_AWAIT: Record<WbStateKey, string> = { customer: "Awaiting customer", external: "Awaiting external party", dev: "Awaiting development" };

export type WbProposal = { id: string; at: number; note: string; steps: Omit<WbStep, "url" | "order">[]; replace: boolean };

/** The one next action the last status check or step run named, as a button. */
export type WbNext = { label: string; prompt: string; who: "claude" | "you"; at: number };

export type WbRow = WbTicket & {
  next: WbNext | null;
  /** Why the last approved step list did not land in Notion, if it did not. */
  stepsError?: string | null;
  steps: WbStep[];
  pinned: boolean;
  state: { k: WbStateKey; at: number; auto?: boolean } | null;
  answered: { at: number; who: string; ack?: boolean } | null;
  proposal: WbProposal | null;
  /** The ticket's own Claude Code session (agent key), if it has one running. */
  session: { key: string; status: string } | null;
  running: boolean;
  /** The newest email across the ticket's Front threads (Sander's "Last Contact Date"); null until they are read. */
  contact?: WbContact | null;
  /** Newer Front threads the background search found but could not place: the user picks. */
  /** Every Front thread on the ticket (read or not), newest first. */
  frontLinked?: WbLinkedThread[];
  frontAsk?: { at: number; query: string; threads: WbFrontCand[] } | null;
  /** A question to Qai the ticket's chat is waiting on (its answer is fed back automatically). */
  qai?: { at: number; link: string | null } | null;
};

/** A Front thread found for a ticket: how well its subject names the ticket, and whose it is if another ticket's. */
export type WbFrontCand = import("./baCustomers.ts").BaFrontThread & { linked: boolean; score?: number; why?: string[]; other?: string | null };
export type WbLinkedThread = { id: string; subject: string; link: string; at: number | null; fromNotion: boolean };
export type WbContact = { at: number; who: string; inbound: boolean; threads: { id: string; subject: string; link: string; at: number; who: string; inbound: boolean }[] };

export type WbDigestItem = { n: number; title: string; meta: string; text: string; quote: string; who: string; links: { url: string; label: string }[]; ticketUrl: string | null };
export type WbDigest = { title: string; lead: string; mode: string; date: string; time: string; items: WbDigestItem[]; notes: string[]; full: string };

export const WB_PHASES = ["Scope", "Provision", "Configure", "Test", "Go live"] as const;
export const WB_STATUS_OPTS: [string, string[]][] = [
  ["To do", ["Backlog", "Ready to implement", "To design/scope this week", "To implement this week"]],
  ["In progress", ["Designing/scoping", "Implementing", "To test", "Support standby", "Blocked/on hold"]],
  ["Complete", ["PS - Ready to preplan", "Production Ready", "Done", "Duplicate", "Won't do"]],
];

const OPEN_CR = ["Intake Done", "To do", "In progress", "Awaiting Customer", "Awaiting External", "Customer to test", "Production ready", "Contacted", "Received"];
export function tabOf(t: Pick<WbTicket, "type" | "reqType" | "reqCategory" | "reqStatus">): WbTab {
  if (/PS Scoping/i.test(t.type || "")) return "scoping";
  if (/^\s*change request\s*$/i.test(t.reqType || "") && /Mapping change/i.test(t.reqCategory || "") && OPEN_CR.includes(t.reqStatus)) return "cr";
  return "tasks";
}
export const held = (t: Pick<WbTicket, "status" | "reqStatus">) => /block|on hold/i.test(t.status || "") || /on hold/i.test(t.reqStatus || "");
// "To test" has its own tab: those wait on the customer testing, so they stay out of Current.
export const stageOf = (t: Pick<WbTicket, "status" | "reqStatus">): WbStage => (held(t) ? "hold" : /backlog/i.test(t.status || "") ? "backlog" : /^\s*to test\s*$/i.test(t.status || "") ? "test" : "current");
export const prioRank = (p: string) => (/urgent/i.test(p) ? 0 : /high/i.test(p) ? 1 : /medium/i.test(p) ? 2 : /low/i.test(p) ? 3 : 4);
export const dueOf = (t: Pick<WbTicket, "committed" | "deal">) => String(t.committed || t.deal?.golive || "").slice(0, 10);
/**
 * Sander's colour logic for the Commit date and Go-live date columns (#C0CL2BYND4K,
 * 2026-11-23). The first matching row wins; negative days are in the past.
 *   no date                         → "No date yet" (commit: gray, go-live: plain)
 *   < -7 and needed for go-live     → bold red (both)
 *   < -28                           → gray (both)
 *   -28 … -8                        → commit bold red, go-live green
 *   -7 … 13                         → bold red (both)
 *   14 … 28                         → commit bold orange, go-live green
 *   29 … 56                         → commit bold yellow, go-live green
 *   > 56                            → commit bold green, go-live green
 */
export type WbDateTone = "none" | "gray" | "red" | "orange" | "yellow" | "green" | "plain-green";
export function dateTone(iso: string, col: "commit" | "golive", neededForGoLive: boolean, now = new Date()): WbDateTone {
  const d = String(iso || "").slice(0, 10);
  if (!d) return col === "commit" ? "gray" : "none";
  const t0 = Date.UTC(now.getFullYear(), now.getMonth(), now.getDate());
  const days = Math.round((Date.parse(d) - t0) / 86_400_000);
  const g = col === "golive";
  if (days < -7 && neededForGoLive) return "red";
  if (days < -28) return "gray";
  if (days <= -8) return g ? "plain-green" : "red";
  if (days <= 13) return "red";
  if (days <= 28) return g ? "plain-green" : "orange";
  if (days <= 56) return g ? "plain-green" : "yellow";
  return g ? "plain-green" : "green";
}
export const neededForGoLive = (t: Pick<WbTicket, "reqPriority">) => /needed for go-?live/i.test(t.reqPriority || "");
/** For sorting: how urgent a date tone is (red first, no date last). */
export const toneRank = (t: WbDateTone) => ({ red: 0, orange: 1, yellow: 2, green: 3, "plain-green": 3, gray: 4, none: 5 })[t];

export const nextStep = (steps: WbStep[]) => steps.find((s) => s.state !== "done") ?? null;

/** Who has the ball, the way the overview's State column shows it. */
export type WbBlocker = { k: "you" | "run" | "claude" | "others" | "fresh" | "done"; tag: string; tone: "warn" | "info" | "busy" | "neutral" | "good" | "action" | "front"; label: string };
export function blockerOf(r: WbRow): WbBlocker {
  if (r.running || r.session?.status === "thinking") return { k: "claude", tag: "Claude working", tone: "busy", label: nextStep(r.steps)?.name ?? "Claude is working" };
  if (r.session?.status === "awaiting-permission") return { k: "you", tag: "Needs decision", tone: "warn", label: "Claude waits for your Allow or Deny" };
  // A state the ticket is in (Awaiting customer, …) says who has the ball; a pending step list waits under it.
  if (r.proposal && !r.state) return { k: "you", tag: "Approve steps", tone: "warn", label: "Approve the proposed steps" };
  if (r.answered && !r.answered.ack && r.state?.k === "customer") return { k: "you", tag: "Customer answered", tone: "front", label: "Customer answered" + (r.answered.who ? ` (${r.answered.who})` : "") };
  if (r.state) return { k: "others", tag: WB_AWAIT[r.state.k], tone: "info", label: WB_AWAIT[r.state.k] };
  if (r.tab === "scoping") return { k: "fresh", tag: "Scoping", tone: "neutral", label: r.request ? "Run the scoping" : "No customer request linked" };
  const nx = nextStep(r.steps);
  if (!r.steps.length) return { k: "fresh", tag: "Not started", tone: "neutral", label: "No steps yet" };
  if (!nx) return { k: "done", tag: "All done", tone: "good", label: "All steps done" };
  if (nx.state === "blocked") return { k: "others", tag: "Blocked", tone: "neutral", label: nx.name };
  if (nx.kind === "manual") return { k: "you", tag: "Needs manual action", tone: "action", label: nx.name };
  // A Claude step Claude flagged earlier stays Claude's: run it again and it picks up its own note.
  if (nx.state === "needs you") return { k: "run", tag: "Claude flagged it", tone: "warn", label: nx.result ? `${nx.name}. Last run: ${nx.result}` : nx.name };
  return { k: "run", tag: "Ready to run", tone: "info", label: nx.name };
}
