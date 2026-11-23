/**
 * BA edition: a dashboard project as a customer, linked to one or more deals in
 * Notion's Deals Extract, with its requirements (Customer Tasks), Front threads
 * and published artifacts. Shared by the daemon and the page.
 */

export type BaRole = "Presales SA" | "Responsible Integrations" | "Responsible onboarding" | "Secondary onboarding" | "Account Manager";

export type BaDeal = {
  url: string;
  name: string;
  status: string | null;
  dealStatus: string | null;
  country: string | null;
  slackUrl: string | null;
  leadEmail: string | null;
  sandboxUrls: string | null;
  productionUrls: string | null;
  /** Integrations kick-off: the 2-week PS scoping window starts here. ISO date. */
  kickoff: string | null;
  goLive: string | null;
  goLiveStatus: string | null;
  onboardingStage: string | null;
  /** Your roles on this deal; empty for a deal linked by hand that you are not on. */
  roles: BaRole[];
  /** The customer (dashboard project) it belongs to, if any. */
  projectId: number | null;
};

export type BaCustomer = {
  projectId: number;
  name: string;
  deals: BaDeal[];
  /** What Front is searched for on the customer's page; the customer name unless set. */
  frontQuery: string;
  /** Email domains that mean "this customer", from deal leads and IR requesters, plus any set by hand. */
  domains: string[];
};

export type BaRequirement = {
  url: string;
  title: string;
  type: string | null;
  status: string | null;
  priority: string | null;
  billableStatus: string | null;
  billableAmount: number | null;
  /** How many building blocks are set in 🚦 Integration. */
  blocks: number;
  frontLink: string | null;
  requestedBy: string | null;
  team: string | null;
  createdAt: string | null;
  /** Deals Extract page ids in its Company relation. */
  dealIds: string[];
  intakeDone: string | null;
  readyToInvoiceAt: string | null;
  hasScopingIssue: boolean;
  effortSpent: number | null;
};

export type BaTicket = {
  url: string;
  title: string;
  markdown: string;
  gate: { onboardingFound: boolean; onboardingFilled: boolean; alreadyScoped: boolean };
};

export type BaFrontThread = {
  id: string;
  subject: string;
  status: string | null;
  from: string | null;
  /** Every email address seen on the conversation: what domain matching runs on. */
  emails: string[];
  assignee: string | null;
  tags: string[];
  snippet: string | null;
  updatedAt: number | null;
  link: string;
  /** Who wrote the last message: "us" (replied, waiting on them) or "them" (needs a reply). Known once the timeline is read. */
  lastBy?: "us" | "them" | null;
};

export type BaSuggestion = { projectId: number; irUrl: string | null; irTitle: string | null; reason: string; score: number };

export type BaThreadLink = { threadId: string; projectId: number; irUrl: string | null; source: "manual" | "accepted" | "auto"; linkedAt: number };

/** A deal in the directory (not a customer yet) that the mail seems to come from. */
export type BaCreateSuggestion = { group: string; dealUrls: string[]; status: string | null; reason: string };

export type BaTriageThread = BaFrontThread & { link_: BaThreadLink | null; suggestion: BaSuggestion | null; create?: BaCreateSuggestion | null };

/** What placement has learned, and the tenants that name a customer. Built on the daemon from your placements and the deals. */
export type MatchExtra = {
  /** Address → customer, from threads you placed or accepted. */
  addresses: Record<string, number>;
  /** Domain → customer, where every learned address on it points at one customer. */
  domains: Record<string, number>;
  /** Qargo tenant slug (app.qargo.com/<slug>) → customer, from the deals' production and sandbox URLs. */
  tenants: Record<string, number>;
  /** Message bodies already read, for tenant links that are not in the preview. */
  bodies?: Record<string, string>;
};

/** "https://app.qargo.com/acme-sandbox/orders/…" → "acme-sandbox". */
export const TENANT_RE = /app\.qargo\.com\/([a-z0-9][a-z0-9-]{1,60})/gi;
export const tenantsIn = (text: string | null | undefined): string[] => [...new Set([...(text ?? "").matchAll(TENANT_RE)].map((m) => m[1]!.toLowerCase()))];

export type BaIrSession = { id: number; irUrl: string; projectId: number | null; key: string; kind: string; title: string; startedAt: number };

export type BaPublished = {
  url: string;
  title: string;
  owner: "mine" | "shared";
  updated: string | null;
  /** The file it was published from, when a transcript recorded it. */
  localPath: string | null;
  /** The matching artifact on the dashboard's Artifacts page, by path or title. */
  localSlug: string | null;
  /** Customers whose name appears in the title. */
  projectIds: number[];
  /** "html" for a page of its own; "slides", "docs", "design", "motion" for one built on a claude.ai type, which only opens there. */
  kind: string;
};

export type Cached<T> = { data: T | null; error: string | null; fetchedAt: number; stale: boolean };

export type BaTenant = "test" | "prod";

export type BaActionKind =
  | "scope"
  | "ballpark"
  | "fill-blocks"
  | "update-ticket"
  | "draw"
  | "briefing"
  | "ir-from-front"
  | "draft-reply"
  | "build-integration"
  | "build-mapping"
  | "build-visibility"
  | "mail-session"
  | "slack-session"
  | "topic-session"
  | "prompt";

export type BaAction = {
  kind: BaActionKind;
  projectId?: number | null;
  /** The IR (Notion ticket) or Front conversation the action is about. */
  url?: string;
  label?: string;
  /** Free text: what to change on the ticket, or what to build. */
  prompt?: string;
  tenant?: BaTenant;
  /** Several IRs at once (scope, draw), or the items of one topic. */
  urls?: string[];
  /** Plain-text material for the session: a Slack post, or the items of a topic. */
  material?: string;
};

/** Mode A gate, as the scoping skill states it: a ticket link, and the onboarding section filled. */
export function gateLabel(t: BaTicket | null): { ok: boolean; text: string } {
  if (!t) return { ok: false, text: "Open to check" };
  if (t.gate.alreadyScoped) return { ok: true, text: "Scoped" };
  if (!t.gate.onboardingFound) return { ok: false, text: "No onboarding section" };
  if (!t.gate.onboardingFilled) return { ok: false, text: "Onboarding empty" };
  return { ok: true, text: "Ready to scope" };
}

// ── matching mail to customers and IRs ───────────────────────────────────────

/** Domains that never identify a customer. */
const GENERIC_DOMAINS = new Set([
  "qargo.com", "gmail.com", "googlemail.com", "outlook.com", "hotmail.com", "live.com", "yahoo.com", "icloud.com", "me.com",
  "msn.com", "proton.me", "protonmail.com", "telenet.be", "skynet.be", "orange.fr", "wanadoo.fr", "free.fr", "frontapp.com",
]);

export const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

export function domainOf(email: string): string | null {
  const d = email.split("@")[1]?.toLowerCase().trim();
  return d && !GENERIC_DOMAINS.has(d) ? d : null;
}

export const domainsIn = (text: string | null | undefined): string[] => [...new Set((text ?? "").match(EMAIL_RE)?.map(domainOf).filter((d): d is string => !!d) ?? [])];

/** "Depot Connect International - Houston 581" → "Depot Connect International". */
export const groupName = (dealName: string) => dealName.split(/\s+[-–]\s+/)[0]!.replace(/\s*\(.*\)\s*$/, "").trim();

const norm = (s: string) =>
  s
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();

/** Words in an IR title that say nothing about which partner or system it is. */
const IR_STOPWORDS = new Set([
  "setup", "set", "integration", "integrations", "request", "import", "export", "order", "orders", "api", "qargo", "edi", "sftp",
  "with", "from", "into", "for", "the", "and", "via", "new", "data", "file", "files", "status", "update", "updates", "mapping", "visibility",
]);

const irKeywords = (title: string) => norm(title).split(" ").filter((w) => w.length >= 4 && !IR_STOPWORDS.has(w));

export type MatchCustomer = { projectId: number; names: string[]; domains: string[] };

/** Where a thread most likely belongs, from Notion: IR Front links, deal and requester domains, names. */
export function suggestFor(t: BaFrontThread, customers: MatchCustomer[], tasks: (BaRequirement & { projectId: number | null })[], extra?: MatchExtra): BaSuggestion | null {
  const frontId = t.id.toLowerCase();
  const bare = frontId.replace(/^cnv_/, "");
  /** Whole ids in a Front link: cnv_… tokens and path segments, never substrings. */
  const idsIn = (link: string) => new Set(link.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean));
  for (const task of tasks) {
    const ids = task.frontLink ? idsIn(task.frontLink) : null;
    if (task.projectId && ids && (ids.has(frontId) || ids.has(bare) || ids.has(`cnv_${bare}`))) {
      return { projectId: task.projectId, irUrl: task.url, irTitle: task.title, reason: `Front link on “${task.title}”`, score: 100 };
    }
  }

  const threadDomains = new Set(t.emails.map(domainOf).filter((d): d is string => !!d));
  const text = norm(`${t.subject} ${t.snippet ?? ""} ${t.from ?? ""}`);
  let best: { c: MatchCustomer; reason: string; score: number } | null = null;
  const byId = new Map(customers.map((c) => [c.projectId, c]));
  const take = (pid: number | undefined, reason: string, score: number) => {
    const c = pid !== undefined ? byId.get(pid) : undefined;
    if (c && (!best || best.score < score)) best = { c, reason, score };
  };
  if (extra) {
    // A Qargo tenant link names the customer exactly, even in an internal mail.
    for (const slug of tenantsIn(`${t.subject} ${t.snippet ?? ""} ${extra.bodies?.[t.id] ?? ""}`)) {
      take(extra.tenants[slug] ?? extra.tenants[slug.replace(/-(sandbox|test|staging|demo)$/, "")], `Qargo tenant ${slug}`, 95);
    }
    for (const e of t.emails) take(extra.addresses[e.toLowerCase()], `known contact ${e.toLowerCase()}`, 90);
    for (const d of threadDomains) take(extra.domains[d], `learned from your placements: ${d}`, 85);
  }
  for (const c of customers) {
    const dom = c.domains.find((d) => threadDomains.has(d) || [...threadDomains].some((td) => td.endsWith(`.${d}`)));
    if (dom && (!best || best.score < 80)) best = { c, reason: `from ${dom}`, score: 80 };
    if (best?.score === 80) continue;
    const name = c.names.map(norm).find((n) => n.length >= 4 && ` ${text} `.includes(` ${n} `));
    if (name && (!best || best.score < 60)) best = { c, reason: `“${name}” in the mail`, score: 60 };
  }
  if (!best) return null;

  // Within the customer, the IR whose partner name appears in the mail. Words are
  // weighted by how rare they are across this customer's IRs: "Macropoint" names
  // one IR, "Houston" or "depot" name dozens. The customer's own name never counts,
  // and capacity placeholders are not IRs.
  const own = tasks.filter((x) => x.projectId === best!.c.projectId && x.type !== "Feature request" && !/capacity placeholder/i.test(x.title));
  const nameWords = new Set(best.c.names.flatMap((n) => norm(n).split(" ")));
  const words = new Map(own.map((x) => [x.url, [...new Set(irKeywords(x.title).filter((w) => !nameWords.has(w)))]]));
  const df = new Map<string, number>();
  for (const ws of words.values()) for (const w of ws) df.set(w, (df.get(w) ?? 0) + 1);
  let ir: (typeof own)[number] | null = null;
  let irScore = 0;
  for (const task of own) {
    const score = (words.get(task.url) ?? []).filter((w) => ` ${text} `.includes(` ${w} `)).reduce((s, w) => s + 1 / (df.get(w) ?? 1), 0);
    if (score > irScore) {
      ir = task;
      irScore = score;
    }
  }
  // A word shared by more than two IRs is not enough on its own to pick one.
  if (irScore < 0.5) ir = null;
  return {
    projectId: best.c.projectId,
    irUrl: ir?.url ?? null,
    irTitle: ir?.title ?? null,
    reason: ir ? `${best.reason} · mentions “${ir.title}”` : best.reason,
    score: best.score,
  };
}

// ── Qai (#ps_troubleshooting) ────────────────────────────────────────────────

export type BaQaiMessage = { author: string; text: string; at: string | null; fromQai: boolean };

export type BaQaiQuestion = {
  id: number;
  projectId: number | null;
  irUrl: string | null;
  question: string;
  /** The exact text posted to Slack. */
  message: string;
  permalink: string | null;
  askedAt: number;
  replies: BaQaiMessage[] | null;
  repliesAt: number | null;
};

// ── feature flags ────────────────────────────────────────────────────────────

/**
 * Every BA-edition addition sits behind one of these, switched in Settings → BA
 * edition. With `enabled` off the dashboard is Rein's original, page for page.
 */
export type BaFlags = {
  /** Master switch. Off by default, so a fresh install is Rein's original dashboard. */
  enabled: boolean;
  /** Feedback mode: pin notes to any element of the page, for the next round of changes. */
  feedback: boolean;
  /** "Customers" wording, My deals, and the Requirements / Front tabs on a customer. */
  customers: boolean;
  /** The Inbox page: Front triage to customers and IRs. */
  inbox: boolean;
  /** The Delivery page for IDMs: meetings, scoping window, billable pipeline, go-live, change requests. */
  delivery: boolean;
  /** The Qai page and Qai boxes on customers and IRs (#ps_troubleshooting). */
  qai: boolean;
  /** Qargo Excalidraw styleguide: landscape template, library, style check, customer export. */
  diagrams: boolean;
  /** Published claude.ai artifacts on the Artifacts page and customer pages. */
  published: boolean;
  /** Build actions on the Qargo MCP inside an IR workspace. */
  qargoMcp: boolean;
  /** Your Google Calendar through the claude.ai connector, on the Calendar page, Home and Delivery. */
  calendar: boolean;
  /** BA session buttons start a cloud session (claude.ai/code) in a terminal instead of a session on this Mac. */
  cloudSessions: boolean;
};

export const DEFAULT_BA_FLAGS: BaFlags = { enabled: false, feedback: false, customers: true, inbox: true, delivery: true, qai: true, diagrams: true, published: true, qargoMcp: true, calendar: true, cloudSessions: false };

export const BA_FLAG_INFO: { key: Exclude<keyof BaFlags, "enabled">; label: string; hint: string }[] = [
  { key: "customers", label: "Customers from Notion", hint: "Projects become customers: My deals, Requirements and Front tabs, IR workspaces" },
  { key: "inbox", label: "Inbox triage", hint: "Front conversations placed at customers and IRs from Notion" },
  { key: "delivery", label: "Delivery (IDM)", hint: "Today's customer meetings, the 2-week scoping window, billable pipeline, go-live watch, change requests" },
  { key: "qai", label: "Qai", hint: "Ask Qai in #ps_troubleshooting, from its own page, a customer or an IR" },
  { key: "calendar", label: "Calendar via Claude", hint: "Your Google Calendar through the claude.ai connector, on the Calendar page, Home and Delivery (read-only, no Google Cloud setup)" },
  { key: "cloudSessions", label: "Run BA sessions in the cloud", hint: "Session buttons start a claude.ai/code cloud session (in a terminal tile) that keeps running without this Mac. The cloud has your connectors, not this Mac's files" },
  { key: "qargoMcp", label: "Build on the Qargo MCP", hint: "Create integration / mapping / visibility from an IR (test tenant by default)" },
  { key: "diagrams", label: "Qargo diagrams", hint: "Excalidraw styleguide: landscape template, shape library, style check, customer export" },
  { key: "published", label: "Published artifacts", hint: "Your claude.ai artifacts beside the local ones and on customer pages" },
  { key: "feedback", label: "Feedback mode", hint: "A Feedback button that pins notes to any part of the page, saved for the next round of changes" },
];

/**
 * Slack's markup as people read it: <@U123|Name> → @Name, <#C123|chan> → #chan,
 * <url|label> → label, and Slack's HTML escapes undone. Joins and leaves are noise.
 */
export function slackText(t: string): string {
  return t
    .replace(/<@[UW][A-Z0-9]+\|([^>]+)>/g, "@$1")
    .replace(/<@[UW][A-Z0-9]+>/g, "@someone")
    .replace(/<#C[A-Z0-9]+\|([^>]*)>/g, (_, n: string) => `#${n || "channel"}`)
    .replace(/<!(here|channel|everyone)(\|[^>]*)?>/g, "@$1")
    .replace(/<(https?:\/\/[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<(https?:\/\/[^>]+)>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}
export const isSlackNoise = (t: string) => /^\s*<@[^>]+>\s+has (joined|left) the channel\s*$/i.test(t) || /^\s*\S+ has (joined|left) the channel\s*$/i.test(t);

// ── mailbox ──────────────────────────────────────────────────────────────────

export type BaMailView = "inbox" | "mentions" | "following" | "placed";

export type BaMailEntry = {
  kind: "message" | "comment" | "activity";
  id: string | null;
  author: string;
  /** Inbound mail from outside, as opposed to a teammate's reply or comment. */
  inbound: boolean;
  at: number | null;
  text: string;
  to: string[];
  /** Attachment file names, when the message has any. */
  attachments?: string[];
  /** The attachments themselves (Front ids), for saving them into the customer's folder. */
  files?: { id: string; name: string; size: number | null; type: string | null }[];
  /** The sender's address, from the message itself. */
  fromAddress?: string | null;
};

export type BaMailThread = { id: string; subject: string; status: string | null; assignee: string | null; inboxes: string[]; entries: BaMailEntry[]; link: string };

export type BaReply = { mode: "draft" | "send" | "comment"; body: string; draftId?: string; format?: "html" | "plain" };

// ── agenda (Google Calendar connector) ───────────────────────────────────────

export type BaAgendaEvent = {
  id: string;
  title: string;
  start: number | null;
  end: number | null;
  allDay: boolean;
  location: string | null;
  meetLink: string | null;
  link: string | null;
  description: string | null;
  attendees: { email: string | null; name: string | null; response: string | null; self: boolean }[];
  declined: boolean;
  /** The customer it is with, by attendee domain or name. */
  projectId: number | null;
};

// ── suggestions for adding customers ─────────────────────────────────────────

export type BaSuggestedDeal = { group: string; deals: BaDeal[]; reasons: string[]; score: number };
export type BaDealSuggestions = { suggested: BaSuggestedDeal[]; unknownDomains: { domain: string; mails: number }[] };

export type BaSavedFiles = { dir: string; saved: string[]; skipped: number } | null;

// ── Slack, on the customer page ──────────────────────────────────────────────

export type BaSlackPost = { author: string; text: string; at: string | null; fromQai: boolean };

/** Which model each kind of background work uses, and how often the mailbox refreshes. */
export type BaModel = "haiku" | "sonnet" | "opus";
export type BaModels = {
  /** Connector reads (Notion, Front, Slack, Calendar): one exact tool call each. */
  sync: BaModel;
  /** Retry a failed read once on Sonnet. */
  syncFallback: boolean;
  /** Key points of a mail thread. */
  keyPoints: BaModel;
  /** "Draft with Claude" replies in the Inbox. */
  drafts: BaModel;
  /** Sessions started from BA buttons; "default" uses your Claude Code default. */
  sessions: BaModel | "default";
  /** Minutes between background mailbox refreshes; 0 is only when you open the Inbox. */
  refreshMinutes: number;
};
export const DEFAULT_BA_MODELS: BaModels = { sync: "haiku", syncFallback: true, keyPoints: "haiku", drafts: "sonnet", sessions: "default", refreshMinutes: 10 };
export const BA_REFRESH_CHOICES = [0, 5, 10, 30, 60];
