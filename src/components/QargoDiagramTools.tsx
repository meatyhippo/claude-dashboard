import { useMemo, useState } from "react";
import { convertToExcalidrawElements, exportToBlob } from "@excalidraw/excalidraw";
import { checkDiagram, librarySkeletons, landscapeSkeleton, type DiagramIssue, type SceneElement } from "../../shared/qargoDiagram.ts";

/**
 * The Qargo styleguide on the drawing canvas: a style check against the
 * self-check in the scoping skill's references/excalidraw.md, an export in
 * light theme for customers, and a library of pre-styled blocks and flows.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Api = any;

/** Library items for Excalidraw's library panel, built once. */
export function qargoLibraryItems() {
  const now = Date.now();
  return librarySkeletons().map((item, i) => ({
    id: `qargo-${i}`,
    status: "published" as const,
    name: item.name,
    created: now,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    elements: convertToExcalidrawElements(item.skeleton as any, { regenerateIds: true }),
  }));
}

/** The integration-landscape starting scene, as Excalidraw scene JSON text. */
export function landscapeSceneJson(customer: string): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elements = convertToExcalidrawElements(landscapeSkeleton(customer) as any, { regenerateIds: false });
  return JSON.stringify({
    type: "excalidraw",
    version: 2,
    source: "claude-dashboard",
    elements,
    appState: { gridSize: null, viewBackgroundColor: "#ffffff" },
    files: {},
  });
}

const LEVEL_MARK: Record<DiagramIssue["level"], string> = { error: "✗", warn: "!", info: "i" };

export default function QargoDiagramTools({ api, title }: { api: Api | null; title?: string }) {
  const [issues, setIssues] = useState<DiagramIssue[] | null>(null);
  const [busy, setBusy] = useState(false);

  const counts = useMemo(() => {
    const c = { error: 0, warn: 0, info: 0 };
    for (const i of issues ?? []) c[i.level]++;
    return c;
  }, [issues]);

  const runCheck = () => {
    if (!api) return;
    setIssues(checkDiagram(api.getSceneElements() as SceneElement[], title));
  };

  const select = (ids: string[]) => {
    if (!api || !ids.length) return;
    const selectedElementIds = Object.fromEntries(ids.map((id) => [id, true]));
    api.updateScene({ appState: { selectedElementIds } });
    const els = api.getSceneElements().filter((e: SceneElement) => ids.includes(e.id));
    api.scrollToContent(els, { fitToContent: els.length > 1, animate: true });
  };

  const exportLight = async () => {
    if (!api) return;
    setBusy(true);
    try {
      const blob = await exportToBlob({
        elements: api.getSceneElements(),
        appState: { ...api.getAppState(), exportBackground: true, exportWithDarkMode: false, viewBackgroundColor: "#ffffff", exportScale: 2 },
        files: api.getFiles(),
        mimeType: "image/png",
        exportPadding: 32,
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${(title || "integration-landscape").replace(/[^\w .-]+/g, "")}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="qargo-tools">
      <div className="qargo-tools-bar">
        <button className="icon-btn" onClick={runCheck} disabled={!api} title="Check this diagram against the Qargo Excalidraw styleguide">
          Style check
          {issues && (
            <span className={`qargo-count ${counts.error ? "is-error" : counts.warn ? "is-warn" : "is-ok"}`}>
              {counts.error || counts.warn ? `${counts.error} ✗ · ${counts.warn} !` : "✓"}
            </span>
          )}
        </button>
        <button className="icon-btn" onClick={() => void exportLight()} disabled={!api || busy} title="PNG in light theme, for customers">
          Customer export
        </button>
        <span className="qargo-tools-hint">Qargo shapes: open the library (book icon, top right)</span>
      </div>
      {issues && (
        <div className="qargo-issues" role="list">
          <div className="qargo-issues-head">
            <span>Styleguide check</span>
            <button className="icon-btn ghost" onClick={runCheck}>Re-check</button>
            <button className="icon-btn ghost" onClick={() => setIssues(null)} aria-label="Close">✕</button>
          </div>
          {issues.length === 0 && <div className="qargo-issue is-ok">Nothing to fix.</div>}
          {issues.map((i, n) => (
            <button key={n} role="listitem" className={`qargo-issue is-${i.level}`} onClick={() => select(i.ids)} disabled={!i.ids.length}>
              <span className="qargo-issue-mark">{LEVEL_MARK[i.level]}</span>
              <span className="qargo-issue-rule">#{i.rule}</span>
              <span>{i.message}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
