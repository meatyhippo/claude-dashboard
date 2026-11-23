import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_BA_FLAGS, type BaFlags } from "../shared/baCustomers.ts";
import { blankSchedule, blankTemplate, type Template } from "../shared/templates.ts";
import { DATA_DIR } from "./paths.ts";
import { getSettings, updateSettings } from "./settings.ts";

/**
 * BA edition: the dashboard set up for a solution architect / business analyst
 * rather than a developer.
 *
 * Off by default: until Settings → BA edition is switched on, nothing here
 * changes a setting, adds a page or answers a route other than its switches.
 *
 * Kept in its own file so upstream updates merge without touching it. It runs at
 * boot and applies each step once, recorded in `ba-edition.json` beside the
 * settings. A page you turn back on, or a template you delete, stays that way:
 * a step that already ran never runs again.
 */

const MARKER_PATH = join(DATA_DIR, "ba-edition.json");

/** Developer pages a BA does not use. Settings → Pages turns any of them back on. */
export const BA_HIDDEN_PAGES = ["worktrees", "services", "reviews"];

const template = (id: string, fields: Partial<Template>): Template => ({ ...blankTemplate(id), permissionMode: "auto", ...fields });

/**
 * BA session recipes. An empty `cwd` makes Run ask for a folder, which is right
 * for customer work: pick that customer's project folder.
 */
export const BA_TEMPLATES: Template[] = [
  template("ba-scope-ir", {
    name: "Scope IR (Mode A)",
    titlePattern: "Scope IR · {date}",
    prompt:
      "/professional-services:prof-svc-scoping\n\n" +
      "Mode A: scope one integration-request ticket. Ask me for the Notion ticket link first, then follow the skill end to end.",
  }),
  template("ba-presales-ballpark", {
    name: "Pre-sales ballpark (Mode B)",
    titlePattern: "Pre-sales ballpark · {date}",
    prompt:
      "/professional-services:prof-svc-scoping\n\n" +
      "Mode B: pre-sales ballpark for a whole prospect. Ask me for the prospect name and the pre-sales call (Gong link or notes) first.",
  }),
  template("ba-create-ir", {
    name: "Create integration request",
    titlePattern: "New IR · {date}",
    prompt: "/qargo:create-integration-request\n\nAsk me for the customer, the partner and the source (Front thread, Slack thread or notes) first.",
  }),
  template("ba-create-fr", {
    name: "Create feature request",
    titlePattern: "New FR · {date}",
    prompt: "/qargo:create-fr\n\nAsk me for the FR page link (or customer and priority) and a short description first.",
  }),
  template("ba-precall-briefing", {
    name: "Pre-call briefing",
    titlePattern: "Briefing · {date}",
    cwd: "~",
    prompt: "/qargo:pre-call-briefing\n\nBrief me for my next customer call. If it is unclear which call, list today's calls and ask.",
  }),
  template("ba-draw-landscape", {
    name: "Draw integration landscape from IRs",
    titlePattern: "Landscape · {date}",
    prompt:
      "Draw this customer's integration landscape as an Excalidraw diagram.\n\n" +
      "1. Ask me which customer if the folder name does not make it obvious.\n" +
      "2. Read their integration requests in Notion (Customer Tasks, same Company) and list every flow: name/number, direction, transport, confirmed or not, and state (working / in development / tested).\n" +
      "3. Follow the Excalidraw styleguide in the professional-services:prof-svc-scoping skill (references/excalidraw.md) exactly: Qargo (TMS) centred in green #ebfbee; customer stack left, third parties right; rounded rectangles with the name inside; " +
      "fills: out-of-the-box red #ffc9c9 (accounting #ffc9c9, FMS/telematics #ff8787, orders/visibility #fa5252), custom request orange #ffa94d, customer middleware lila #9775fa, customer API/EDI blue #a5d8ff; " +
      "arrows bound to both blocks, labelled 'description\\n(transport)' using the Notion flow names and numbers, solid = confirmed, dotted = unconfirmed, stroke #1e1e1e working / #e8590c in development / #40c057 tested; strokeWidth 1; hand-drawn font.\n" +
      "4. Write it to ./drawings/<Customer name>.excalidraw in this folder (create the folder if needed), so it shows up in the dashboard's Drawings page. Then tell me to run Style check on it.",
  }),
  template("ba-morning-inbox", {
    name: "Morning inbox",
    titlePattern: "Morning inbox · {date}",
    cwd: "~",
    prompt: "/qargo:morning-inbox",
    // Scheduled on weekdays at 08:30, but off until you switch it on in Templates.
    schedule: { ...blankSchedule(), enabled: false, kind: "weekly", days: [1, 2, 3, 4, 5], time: "08:30", skipIfRunning: true },
  }),
];

type Marker = { steps: Record<string, string>; flags?: Partial<BaFlags>; mailStyle?: string };

function readMarker(): Marker {
  try {
    if (existsSync(MARKER_PATH)) return JSON.parse(readFileSync(MARKER_PATH, "utf8")) as Marker;
  } catch {
    // A broken marker only means steps re-check; each one is safe to repeat.
  }
  return { steps: {} };
}

export function applyBaEditionOnce(): void {
  // Off (the default for a fresh install): leave Rein's settings exactly as they are.
  if (!getBaFlags().enabled) return;
  const marker = readMarker();
  const done = (step: string) => !!marker.steps[step];
  const mark = (step: string) => (marker.steps[step] = new Date().toISOString());
  const s = getSettings();

  if (!done("hide-dev-pages")) {
    const hidden = [...new Set([...s.ui.hiddenPages, ...BA_HIDDEN_PAGES])];
    updateSettings({ ui: { hiddenPages: hidden } });
    mark("hide-dev-pages");
  }

  // Per template, so a template added in a later version still arrives.
  const existing = new Set(getSettings().templates.map((t) => t.id));
  const missing = BA_TEMPLATES.filter((t) => !done(`template:${t.id}`) && !existing.has(t.id));
  if (missing.length) updateSettings({ templates: [...getSettings().templates, ...missing] });
  for (const t of BA_TEMPLATES) if (!done(`template:${t.id}`)) mark(`template:${t.id}`);

  writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2));
}

/**
 * How the user's mails read: their own instructions, which every reply draft
 * follows (Claude's quick drafts and drafts written by a session). Kept beside
 * the switches; a personal ~/.claude/CLAUDE.md is added when there is one.
 */
export function getMailStyle(): string {
  return readMarker().mailStyle ?? "";
}

export function setMailStyle(text: string): string {
  const marker = readMarker();
  marker.mailStyle = text.slice(0, 8000);
  writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2));
  return marker.mailStyle;
}

/** The instructions as a block for a prompt, or "" when there are none. */
export function mailStyleBlock(): string {
  const own = getMailStyle().trim();
  let global = "";
  try {
    const p = join(process.env.HOME ?? "", ".claude", "CLAUDE.md");
    if (existsSync(p)) global = readFileSync(p, "utf8").trim().slice(0, 6000);
  } catch {
    /* unreadable: the dashboard's own copy still applies */
  }
  const parts = [
    own && `How I want my emails written (these win over any default):\n${own}`,
    global && `My general instructions for Claude (follow the parts about writing):\n${global}`,
  ].filter(Boolean);
  return parts.length ? `\n\n<my_instructions>\n${parts.join("\n\n")}\n</my_instructions>` : "";
}

/** The BA-edition switches, kept beside the one-time steps. */
export function getBaFlags(): BaFlags {
  return { ...DEFAULT_BA_FLAGS, ...(readMarker().flags ?? {}) };
}

export function setBaFlags(patch: Partial<BaFlags>): BaFlags {
  const marker = readMarker();
  const clean = Object.fromEntries(Object.entries(patch).filter(([k, v]) => k in DEFAULT_BA_FLAGS && typeof v === "boolean"));
  marker.flags = { ...(marker.flags ?? {}), ...clean };
  writeFileSync(MARKER_PATH, JSON.stringify(marker, null, 2));
  // Switched on for the first time: hide the developer pages and add the BA templates now, not at the next boot.
  if (clean.enabled === true) applyBaEditionOnce();
  return getBaFlags();
}
