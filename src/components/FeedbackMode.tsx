import { useEffect, useRef, useState } from "react";

/**
 * BA edition: comment on anything in the dashboard. Switch Feedback on, click an
 * element, write a note. Notes are saved with the page and the element, in a file
 * Claude reads, so feedback lands exactly where it was meant.
 */

type Note = { id: string; at: string; route: string; element: string; text: string; note: string; done?: boolean };

/** A readable path to an element: tag, a few classes, and the nearest headings, enough to find it again. */
function describe(el: Element): { element: string; text: string } {
  const parts: string[] = [];
  let cur: Element | null = el;
  for (let i = 0; cur && i < 5 && cur !== document.body; i++, cur = cur.parentElement) {
    const cls = [...cur.classList].filter((c) => !/^(on|active|open|hot|is-)/.test(c)).slice(0, 2).join(".");
    parts.unshift(`${cur.tagName.toLowerCase()}${cls ? `.${cls}` : ""}`);
  }
  const heading = el.closest("section, .ba-card, .dl-card, .panel, .mb-reader, .ba-panel")?.querySelector("h1, h2, h3, h4, strong")?.textContent?.trim();
  const text = ((el as HTMLElement).innerText || el.getAttribute("placeholder") || el.getAttribute("title") || "").trim().replace(/\s+/g, " ").slice(0, 200);
  return { element: `${parts.join(" > ")}${heading ? `  (in “${heading.slice(0, 60)}”)` : ""}`, text };
}

export default function FeedbackMode() {
  const [on, setOn] = useState(false);
  const [notes, setNotes] = useState<Note[]>([]);
  const [target, setTarget] = useState<{ el: Element; x: number; y: number } | null>(null);
  const [draft, setDraft] = useState("");
  const [list, setList] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const hover = useRef<Element | null>(null);

  const load = () =>
    fetch("/api/ba/feedback")
      .then((r) => r.json())
      .then((r: { feedback: Note[] }) => setNotes(r.feedback))
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    if (!on) return;
    const mark = (el: Element | null) => {
      hover.current?.classList.remove("fb-hover");
      hover.current = el;
      el?.classList.add("fb-hover");
    };
    const ours = (el: Element | null) => !!el?.closest(".fb-ui");
    const move = (e: MouseEvent) => {
      if (target) return;
      const el = document.elementFromPoint(e.clientX, e.clientY);
      if (!ours(el)) mark(el);
    };
    const click = (e: MouseEvent) => {
      const el = e.target as Element;
      if (ours(el)) return;
      e.preventDefault();
      e.stopPropagation();
      setTarget({ el, x: Math.min(e.clientX, window.innerWidth - 340), y: Math.min(e.clientY, window.innerHeight - 200) });
      setDraft("");
    };
    const key = (e: KeyboardEvent) => e.key === "Escape" && (target ? setTarget(null) : setOn(false));
    document.addEventListener("mousemove", move, true);
    document.addEventListener("click", click, true);
    document.addEventListener("keydown", key, true);
    document.body.classList.add("fb-on");
    return () => {
      document.removeEventListener("mousemove", move, true);
      document.removeEventListener("click", click, true);
      document.removeEventListener("keydown", key, true);
      document.body.classList.remove("fb-on");
      mark(null);
    };
  }, [on, target]);

  const save = () => {
    if (!target || !draft.trim()) return;
    const d = describe(target.el);
    void fetch("/api/ba/feedback", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ route: location.hash || "#/", ...d, note: draft }) })
      .then(() => load())
      .then(() => {
        setTarget(null);
        setDraft("");
      });
  };

  return (
    <div className="fb-ui">
      {target && (
        <div ref={box} className="fb-pop" style={{ left: target.x, top: target.y }}>
          <div className="ba-muted fb-what">{describe(target.el).text.slice(0, 90) || describe(target.el).element.slice(-60)}</div>
          <textarea autoFocus rows={3} value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Your feedback on this…" onKeyDown={(e) => e.key === "Enter" && (e.metaKey || e.ctrlKey) && save()} />
          <div className="fb-row">
            <button className="icon-btn primary" disabled={!draft.trim()} onClick={save}>
              Save ⌘↵
            </button>
            <button className="icon-btn ghost" onClick={() => setTarget(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}
      {list && (
        <div className="fb-list">
          <div className="fb-row">
            <strong>Your feedback ({notes.filter((n) => !n.done).length} open)</strong>
            <button className="icon-btn ghost" onClick={() => setList(false)}>
              ✕
            </button>
          </div>
          {notes.length === 0 && <p className="ba-muted">No notes yet. Switch Feedback on and click anything.</p>}
          {notes
            .slice()
            .reverse()
            .map((n) => (
              <div key={n.id} className={`fb-item ${n.done ? "done" : ""}`}>
                <span className="ba-muted">
                  {n.done ? "✓ handled · " : ""}
                  {n.route} · {n.text.slice(0, 50) || n.element.slice(-40)}
                </span>
                <span>{n.note}</span>
                <button className="icon-btn ghost" onClick={() => void fetch(`/api/ba/feedback/${n.id}`, { method: "DELETE" }).then(load)}>
                  Delete
                </button>
              </div>
            ))}
        </div>
      )}
      <div className="fb-dock">
        <button className={`icon-btn ${on ? "primary" : ""}`} onClick={() => (setOn(!on), setTarget(null))} title="Click anything on the page to leave a note (Esc to stop)">
          {on ? "Feedback on · click anything" : "Feedback"}
        </button>
        <button className="icon-btn ghost" onClick={() => setList(!list)} title="Notes you left">
          {notes.filter((n) => !n.done).length}
        </button>
      </div>
    </div>
  );
}
