import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, isAbsolute, join, normalize, relative, resolve } from "node:path";
import { ensureProjectFolder } from "./workspaces.ts";

/**
 * BA edition: files in a customer's folder. Create a file or folder (never outside
 * the folder, never over an existing file), and open the folder in VS Code or Finder.
 */

const STARTERS: Record<string, (name: string) => string> = {
  ".md": (n) => `# ${n.replace(/[-_]+/g, " ")}\n\n`,
  ".html": (n) => `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${n}</title>\n</head>\n<body>\n\n</body>\n</html>\n`,
  ".json": () => "{\n}\n",
  ".jsonata": () => "(\n  /* mapping */\n)\n",
  ".csv": () => "",
};

/** A path inside the customer's folder, or an error. */
function inside(projectId: number, path: string): { folder: string; abs: string; rel: string } {
  const folder = ensureProjectFolder(projectId);
  if (!folder) throw new Error("this customer has no folder");
  const clean = normalize(path.trim().replace(/^\/+/, ""));
  if (!clean || clean === "." || isAbsolute(clean) || clean.startsWith("..")) throw new Error("give a name inside the customer's folder");
  const abs = resolve(folder, clean);
  const rel = relative(folder, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("that is outside the customer's folder");
  return { folder, abs, rel };
}

export function createEntry(projectId: number, path: string, kind: "file" | "folder"): { rel: string } {
  const { abs, rel } = inside(projectId, path);
  if (existsSync(abs)) throw new Error(`${rel} already exists`);
  if (kind === "folder") {
    mkdirSync(abs, { recursive: true });
    return { rel };
  }
  mkdirSync(dirname(abs), { recursive: true });
  const name = basename(abs, extname(abs));
  writeFileSync(abs, (STARTERS[extname(abs).toLowerCase()] ?? (() => ""))(name), { flag: "wx" });
  return { rel };
}

export function openFolder(projectId: number, app: "vscode" | "finder", path?: string): void {
  const folder = ensureProjectFolder(projectId);
  if (!folder) throw new Error("this customer has no folder");
  const target = path ? inside(projectId, path).abs : folder;
  const args = app === "vscode" ? ["-a", "Visual Studio Code", target] : path ? ["-R", target] : [target];
  spawn("open", args, { detached: true, stdio: "ignore" }).unref();
}

export const folderOf = (projectId: number) => ensureProjectFolder(projectId) ?? join("", "");

/**
 * The macOS folder chooser, started at `from`: the native dialog rather than the
 * page's own browser. Resolves to the chosen POSIX path, or null when cancelled.
 */
export function chooseFolderNative(from?: string): Promise<string | null> {
  const start = from && existsSync(from) ? `default location (POSIX file ${JSON.stringify(from)})` : "";
  const script = `try\n  set f to choose folder with prompt "Choose a folder" ${start}\n  return POSIX path of f\non error number -128\n  return ""\nend try`;
  return new Promise((resolve, reject) => {
    const p = spawn("osascript", ["-e", 'tell application "System Events" to activate', "-e", script]);
    let out = "";
    let err = "";
    p.stdout.on("data", (d) => (out += d));
    p.stderr.on("data", (d) => (err += d));
    p.on("close", (code) => (code === 0 ? resolve(out.trim().replace(/\/$/, "") || null) : reject(new Error(err.trim() || "the folder chooser could not open"))));
  });
}
