import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DATA_DIR } from "./paths.ts";

/**
 * BA edition: feedback pinned to the page. Each note records the page (route), the
 * element it is about (a readable path and its text) and where it was clicked, so
 * Claude can read `feedback.json` and find exactly what you meant.
 */

export const FEEDBACK_PATH = join(DATA_DIR, "feedback.json");

export type Feedback = { id: string; at: string; route: string; element: string; text: string; note: string; done?: boolean };

const read = (): Feedback[] => {
  try {
    return existsSync(FEEDBACK_PATH) ? (JSON.parse(readFileSync(FEEDBACK_PATH, "utf8")) as Feedback[]) : [];
  } catch {
    return [];
  }
};
const write = (list: Feedback[]) => writeFileSync(FEEDBACK_PATH, JSON.stringify(list, null, 2));

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

export async function handleFeedbackRoute(req: Request, url: URL): Promise<Response | null> {
  if (!url.pathname.startsWith("/api/ba/feedback")) return null;
  const id = url.pathname.split("/")[4];
  if (req.method === "GET") return json({ feedback: read(), file: FEEDBACK_PATH });
  if (req.method === "POST" && !id) {
    const b = (await req.json().catch(() => null)) as Partial<Feedback> | null;
    if (!b?.note?.trim()) return json({ error: "write a note" }, 400);
    const item: Feedback = {
      id: Math.random().toString(36).slice(2, 10),
      at: new Date().toISOString(),
      route: String(b.route ?? "").slice(0, 300),
      element: String(b.element ?? "").slice(0, 400),
      text: String(b.text ?? "").slice(0, 400),
      note: b.note.trim().slice(0, 4000),
    };
    write([...read(), item]);
    return json({ feedback: item });
  }
  if (req.method === "DELETE" && id) {
    write(read().filter((f) => f.id !== id));
    return json({ ok: true });
  }
  return json({ error: "not found" }, 404);
}
