import { isArtifactKey } from "../../shared/artifacts.ts";
import { isDrawingKey } from "../../shared/drawings.ts";
import { isNoteKey } from "../../shared/notes.ts";
import { isServiceKey } from "../../shared/services.ts";
import { isTerminalKey } from "../../shared/terminals.ts";
import { useEffect, useRef, useState } from "react";
import type { AgentSummary, Settings } from "../api.ts";
import { SessionPanelContent } from "./SessionPanelContent.tsx";
import { wbTicketIdOf } from "./WorkbenchView.tsx";
import { baFlags } from "../baFlags.ts";

const DRAWER_WIDTH_KEY = "drawer-width";
const DRAWER_MIN_WIDTH = 420;
// A fraction of the viewport rather than a fixed cap, so an ultrawide monitor
// can actually use the room instead of hitting a desktop-era ceiling.
const DRAWER_MAX_FRACTION = 0.9;

function drawerMaxWidth(): number {
  return Math.round(window.innerWidth * DRAWER_MAX_FRACTION);
}

// A Workbench ticket puts its steps beside the chat, so it gets its own, much wider
// width: the chat keeps a readable column and the steps still fit next to it.
const WB_DRAWER_WIDTH_KEY = "drawer-width-wb";
const WB_DRAWER_DEFAULT = 1400;

function defaultDrawerWidth(wide = false): number {
  return Math.min(wide ? WB_DRAWER_DEFAULT : 820, drawerMaxWidth());
}

function readDrawerWidth(wide = false): number {
  const saved = Number(localStorage.getItem(wide ? WB_DRAWER_WIDTH_KEY : DRAWER_WIDTH_KEY));
  return Number.isFinite(saved) && saved >= DRAWER_MIN_WIDTH
    ? Math.min(saved, drawerMaxWidth())
    : defaultDrawerWidth(wide);
}

/**
 * How wide a session is worth reading is a preference about your monitor and
 * your eyes, not about any one session, so it is remembered rather than reset
 * every time the drawer opens. A concrete pixel value throughout — rather than
 * "unset, fall back to CSS" — is what lets the floating handle track the
 * drawer's edge without measuring the DOM for it.
 *
 * The value returned is always re-clamped against the *current* viewport
 * (state + a resize listener), not just at the moment it was saved or
 * dragged: a width saved on a wider screen, or a window resized narrower
 * afterwards, would otherwise leave the drawer's CSS `max-width` shrinking
 * the visible panel while this hook kept reporting the old, wider number —
 * putting the handle at the width it no longer actually has, off over the
 * backdrop instead of on the drawer's real edge.
 */
function useDrawerWidth(wide = false) {
  const [width, setWidth] = useState<number>(() => readDrawerWidth(wide));
  // The agent (and so whether this is a Workbench ticket) can arrive after the first render.
  useEffect(() => setWidth(readDrawerWidth(wide)), [wide]);
  const [maxWidth, setMaxWidth] = useState<number>(drawerMaxWidth);
  const dragging = useRef(false);

  useEffect(() => {
    function onResize() {
      setMaxWidth(drawerMaxWidth());
    }
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useEffect(() => {
    function onMove(e: PointerEvent) {
      if (!dragging.current) return;
      const next = Math.min(
        drawerMaxWidth(),
        Math.max(DRAWER_MIN_WIDTH, window.innerWidth - e.clientX),
      );
      setWidth(next);
    }
    function onUp() {
      if (!dragging.current) return;
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
  }, []);

  useEffect(() => {
    localStorage.setItem(wide ? WB_DRAWER_WIDTH_KEY : DRAWER_WIDTH_KEY, String(width));
  }, [width]);

  const clampedWidth = Math.min(width, maxWidth);

  function startDrag(e: React.PointerEvent) {
    e.preventDefault();
    dragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
  }

  return { width: clampedWidth, startDrag };
}

export function SessionDrawer({
  id,
  agent,
  settings,
  onSettings,
  onClose,
}: {
  id: string;
  agent: AgentSummary | null;
  settings: Settings | null;
  onSettings: (s: Settings) => void;
  onClose: () => void;
}) {
  const aside = useRef<HTMLElement | null>(null);
  const { width, startDrag } = useDrawerWidth(baFlags.workbench && !!wbTicketIdOf(agent?.cwd));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <>
      <div className="scrim" onClick={onClose} />
      {/* A fixed sibling rather than a child of the drawer: the drawer scrolls
          (overflow-y: auto), and a scrolling container clips anything of its
          children that pokes outside its box — which is the whole point of a
          handle meant to float past the drawer's own edge. */}
      <div className="drawer-resize-handle" style={{ right: width }} onPointerDown={startDrag} title="Drag to resize">
        <span className="drawer-resize-grip" />
      </div>
      <aside className={`drawer ${agent ? "drawer-live" : ""}${isTerminalKey(id) || isServiceKey(id) || isArtifactKey(id) || isDrawingKey(id) || isNoteKey(id) ? " drawer-live drawer-term" : ""}`} ref={aside} style={{ width }}>
        <SessionPanelContent
          id={id}
          agent={agent}
          settings={settings}
          onSettings={onSettings}
          onClose={onClose}
          scrollRef={aside}
          jumpVariant="fixed"
        />
      </aside>
    </>
  );
}
