import type { Database } from "bun:sqlite";
import type { BaFrontThread } from "../shared/baCustomers.ts";
import { workspaceTitle } from "../shared/workspaces.ts";
import { getWorkspace, workspacesOfProject } from "./workspaces.ts";

/**
 * BA edition: a Front conversation placed at a customer can also belong to one of
 * that customer's workspaces. Kept in its own table, so placing the mail again
 * (which rewrites its `ba_thread_links` row) does not lose the workspace, and a
 * link whose workspace moved to another customer is simply not shown.
 */
let db: Database;

export function initMailWorkspace(database: Database) {
  db = database;
  db.exec(`
    CREATE TABLE IF NOT EXISTS ba_thread_workspaces (
      thread_id    TEXT PRIMARY KEY,
      workspace_id INTEGER NOT NULL,
      linked_at    INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_ba_thread_workspaces_ws ON ba_thread_workspaces(workspace_id);
  `);
}

const placedAt = (threadId: string) => db.query<{ project_id: number }, [string]>("SELECT project_id FROM ba_thread_links WHERE thread_id = ?").get(threadId)?.project_id ?? null;

/** The workspace a conversation is linked to, while it still belongs to the customer the mail is placed at. */
export function workspaceOfThread(threadId: string | null | undefined): { id: number; folder: string; projectId: number } | null {
  if (!threadId) return null;
  const r = db.query<{ workspace_id: number }, [string]>("SELECT workspace_id FROM ba_thread_workspaces WHERE thread_id = ?").get(threadId);
  const w = r ? getWorkspace(r.workspace_id) : null;
  if (!w || w.status === "archived" || w.projectId !== placedAt(threadId)) return null;
  return { id: w.id, folder: w.folder, projectId: w.projectId };
}

/** Link (or with null, unlink) a placed conversation to a workspace of the same customer. */
export function setThreadWorkspace(threadId: string, workspaceId: number | null): { ok: true } | { ok: false; error: string } {
  if (workspaceId === null) {
    db.query("DELETE FROM ba_thread_workspaces WHERE thread_id = ?").run(threadId);
    return { ok: true };
  }
  const project = placedAt(threadId);
  if (project === null) return { ok: false, error: "place the conversation at a customer first" };
  const w = getWorkspace(workspaceId);
  if (!w || w.projectId !== project) return { ok: false, error: "that workspace is not one of this customer's" };
  db.query("INSERT OR REPLACE INTO ba_thread_workspaces (thread_id, workspace_id, linked_at) VALUES (?, ?, ?)").run(threadId, workspaceId, Date.now());
  return { ok: true };
}

/** Called when a conversation is unplaced: its workspace link goes with it. */
export function forgetThreadWorkspace(threadId: string) {
  db?.query("DELETE FROM ba_thread_workspaces WHERE thread_id = ?").run(threadId);
}

/** The customer's workspaces a mail can be linked to, the open ones first. */
export function workspaceOptions(projectId: number): { id: number; title: string }[] {
  return workspacesOfProject(projectId)
    .filter((w) => w.status !== "archived")
    .sort((a, b) => Number(a.status !== "active") - Number(b.status !== "active") || b.lastActivityAt - a.lastActivityAt)
    .map((w) => ({ id: w.id, title: workspaceTitle(w) }));
}

/** The conversations linked to one workspace, newest link first. */
export function threadsOfWorkspace(workspaceId: number): { projectId: number; threads: BaFrontThread[] } | null {
  const w = getWorkspace(workspaceId);
  if (!w) return null;
  const rows = db
    .query<{ thread_json: string | null }, [number, number]>(
      `SELECT l.thread_json FROM ba_thread_workspaces tw
         JOIN ba_thread_links l ON l.thread_id = tw.thread_id
        WHERE tw.workspace_id = ? AND l.project_id = ?
        ORDER BY tw.linked_at DESC`,
    )
    .all(workspaceId, w.projectId);
  return { projectId: w.projectId, threads: rows.map((r) => JSON.parse(r.thread_json ?? "{}") as BaFrontThread).filter((t) => !!t.id) };
}
