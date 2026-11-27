import { DEFAULT_BA_FLAGS, type BaFlags } from "../shared/baCustomers.ts";

/**
 * BA-edition switches on the page.
 *
 * Read at import time, before anything renders, so labels and page lists that are
 * computed once (the dock, the palette) already know them. Changing a switch in
 * Settings saves it and reloads, so every part of the page agrees.
 */
const KEY = "ba-flags";

function readLocal(): BaFlags {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? { ...DEFAULT_BA_FLAGS, ...(JSON.parse(raw) as Partial<BaFlags>) } : DEFAULT_BA_FLAGS;
  } catch {
    return DEFAULT_BA_FLAGS;
  }
}

function store(f: BaFlags) {
  try {
    localStorage.setItem(KEY, JSON.stringify(f));
  } catch {
    /* private window: the daemon's copy is read on every load anyway */
  }
}

/**
 * The daemon's copy, asked synchronously before anything renders: one small
 * request to this machine, so labels and page lists are right on the first paint.
 * Falls back to the last copy seen when the daemon cannot be reached.
 */
function readDaemon(): BaFlags | null {
  try {
    const xhr = new XMLHttpRequest();
    xhr.open("GET", "/api/ba/flags", false);
    xhr.send();
    if (xhr.status !== 200) return null;
    const flags = { ...DEFAULT_BA_FLAGS, ...(JSON.parse(xhr.responseText) as { flags: Partial<BaFlags> }).flags };
    store(flags);
    return flags;
  } catch {
    return null;
  }
}

const raw = readDaemon() ?? readLocal();
/** Effective switches: each one needs the master switch too. */
export const baFlags: BaFlags = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, k === "enabled" ? v : raw.enabled && v])) as BaFlags;
export const baRawFlags: BaFlags = raw;

export async function saveBaFlags(patch: Partial<BaFlags>): Promise<void> {
  const r = await fetch("/api/ba/flags", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  const { flags } = (await r.json()) as { flags: BaFlags };
  store(flags);
  location.reload();
}

/** Words that change with the "Customers from Notion" switch. */
export const T = baFlags.customers
  ? { Projects: "Customers", Project: "Customer", projects: "customers", project: "customer", newProject: "New customer" }
  : { Projects: "Projects", Project: "Project", projects: "projects", project: "project", newProject: "New project" };

/** Pages that only exist with their switch on. */
export const BA_PAGE_FLAG: Record<string, keyof BaFlags> = { inbox: "inbox", delivery: "delivery", workbench: "workbench", qai: "qai" };
export const baPageOn = (key: string) => !(key in BA_PAGE_FLAG) || baFlags[BA_PAGE_FLAG[key]!];
