import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";
import { DRAWING_EXT, isDrawingSlug } from "../shared/drawings.ts";
import { getBaFlags } from "./baEdition.ts";
import { projectFolderHolding, projectFolderOf } from "./paths.ts";

/**
 * BA edition: where a session keeps what it makes, so it lands on the customer page.
 *
 * The customer page's Drawings box reads one flat folder, `<customer folder>/drawings/`.
 * A session started in a workspace (a subfolder of the customer folder) otherwise
 * writes its diagram next to its own work, where the page never looks.
 */
const drawingsOn = () => {
  const f = getBaFlags();
  return f.enabled && f.diagrams;
};

/** Extra system-prompt text for a session started in `cwd`; empty when nothing applies. */
export function baSessionRules(cwd: string | undefined): string {
  if (!cwd || !drawingsOn()) return "";
  const folder = projectFolderHolding(cwd);
  if (!folder) return "";
  return (
    `\n\nWhen you make an Excalidraw drawing, save it as ${join(folder, "drawings")}/<kebab-case-name>.excalidraw ` +
    "(that exact folder, no subfolders, even when you work in a subfolder of the customer folder), so it shows in the customer's Drawings on the dashboard."
  );
}

// ── drawings left elsewhere in a customer folder ─────────────────────────────

const SKIP = new Set(["node_modules", "drawings"]);
const MAX_DEPTH = 4;

export type StrayDrawing = { path: string; rel: string; modified: number; size: number };

/** `.excalidraw` files in the customer folder outside its `drawings/`, newest first. */
export function strayDrawings(projectId: number): StrayDrawing[] {
  if (!drawingsOn()) return [];
  const root = projectFolderOf(projectId);
  if (!root) return [];
  const out: StrayDrawing[] = [];
  const walk = (dir: string, depth: number) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".")) continue;
      const p = join(dir, n);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) {
        // Only the customer folder's own drawings/ is the page's; a workspace's drawings/ is not.
        if (depth < MAX_DEPTH && !(dir === root && SKIP.has(n)) && n !== "node_modules") walk(p, depth + 1);
      } else if (st.isFile() && n.toLowerCase().endsWith(DRAWING_EXT)) {
        out.push({ path: p, rel: relative(root, p), modified: Math.floor(st.mtimeMs), size: st.size });
      }
    }
  };
  walk(root, 1);
  return out.sort((a, b) => b.modified - a.modified);
}

/** A name in `dir` not taken yet, kept to the characters a drawing slug allows. */
function freeName(dir: string, wanted: string): string {
  let base = wanted.replace(/[^A-Za-z0-9 ._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/\.+$/, "").slice(0, 100) || "drawing";
  if (!isDrawingSlug(base)) base = "drawing";
  for (let i = 1; ; i++) {
    const name = i === 1 ? base : `${base}-${i}`;
    if (!existsSync(join(dir, `${name}${DRAWING_EXT}`))) return name;
  }
}

/**
 * Move one of those files into `<customer folder>/drawings/`, with its `.svg` preview
 * when one sits beside it. Only a file the listing above would show is accepted.
 */
export function adoptStrayDrawing(projectId: number, path: string): { ok: true; name: string } | { ok: false; error: string } {
  if (!drawingsOn()) return { ok: false, error: "Qargo diagrams is off" };
  const root = projectFolderOf(projectId);
  if (!root || typeof path !== "string") return { ok: false, error: "unknown customer" };
  const abs = resolve(path);
  const target = resolve(root, "drawings");
  if (!abs.startsWith(resolve(root) + sep) || abs.startsWith(target + sep)) return { ok: false, error: "not in this customer's folder" };
  if (!abs.toLowerCase().endsWith(DRAWING_EXT)) return { ok: false, error: "not an .excalidraw file" };
  if (!strayDrawings(projectId).some((s) => resolve(s.path) === abs)) return { ok: false, error: "file not found" };
  mkdirSync(target, { recursive: true });
  const name = freeName(target, basename(abs).slice(0, -DRAWING_EXT.length));
  renameSync(abs, join(target, `${name}${DRAWING_EXT}`));
  const svg = abs.slice(0, -DRAWING_EXT.length) + ".svg";
  if (existsSync(svg)) {
    try {
      renameSync(svg, join(target, `${name}.svg`));
    } catch {
      /* the preview is redrawn on the next save */
    }
  }
  return { ok: true, name };
}
