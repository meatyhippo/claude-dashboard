import { useEffect, useRef } from "react";
import { closeCloud, setCloudWidth, useCloudPanel } from "../cloudPanel.ts";

// Electron's <webview> tag (enabled for the main window in electron/main.ts); React's types know the tag.
type WebviewEl = HTMLWebViewElement & { reload(): void; goBack(): void; canGoBack(): boolean; getURL(): string };
// Electron only checks that the attribute is there; React drops `true` on it.
const ALLOW_POPUPS = { allowpopups: "true" } as object;

/**
 * claude.ai sees a plain Chrome. Google sign-in refuses browsers that name
 * themselves Electron ("This browser or app may not be secure").
 */
const chromeUa = (() => {
  const v = /Chrome\/([\d.]+)/.exec(navigator.userAgent)?.[1] ?? "140.0.0.0";
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${v} Safari/537.36`;
})();

/**
 * BA edition: a claude.ai/code session docked on the right. The page keeps
 * its room on the left (`--cloud-w` pads .app-main), so mail, files and
 * tickets stay usable beside it. The claude.ai sign-in lives in its own
 * storage (`persist:claude-ai`) and is kept between launches.
 */
export function CloudPanel() {
  const { url, width } = useCloudPanel();
  const view = useRef<WebviewEl>(null);
  const drag = useRef<{ x: number; w: number } | null>(null);

  useEffect(() => {
    document.documentElement.style.setProperty("--cloud-w", url ? `${width}px` : "0px");
  }, [url, width]);

  if (!url) return null;

  const startDrag = (e: React.PointerEvent) => {
    drag.current = { x: e.clientX, w: width };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    document.documentElement.classList.add("cloud-dragging");
  };
  const onDrag = (e: React.PointerEvent) => {
    if (drag.current) setCloudWidth(drag.current.w + (drag.current.x - e.clientX));
  };
  const endDrag = () => {
    drag.current = null;
    document.documentElement.classList.remove("cloud-dragging");
  };

  return (
    <aside className="cloud-panel" style={{ width }} aria-label="Cloud session">
      <div className="cloud-panel-grip" onPointerDown={startDrag} onPointerMove={onDrag} onPointerUp={endDrag} onPointerCancel={endDrag} title="Drag to resize" />
      <div className="cloud-panel-head">
        <span className="cloud-panel-title">Cloud session</span>
        <button className="icon-btn ghost" title="Back" onClick={() => view.current?.canGoBack() && view.current.goBack()}>
          ←
        </button>
        <button className="icon-btn ghost" title="Reload" onClick={() => view.current?.reload()}>
          ↻
        </button>
        <button className="icon-btn ghost" title="Open in the browser" onClick={() => window.open(view.current?.getURL() || url, "_blank", "noopener")}>
          ↗
        </button>
        <button className="icon-btn ghost" title="Close the panel (the session keeps running on claude.ai)" onClick={closeCloud}>
          ✕
        </button>
      </div>
      <webview ref={view as React.Ref<HTMLWebViewElement>} className="cloud-panel-view" src={url} partition="persist:claude-ai" useragent={chromeUa} {...ALLOW_POPUPS} />
    </aside>
  );
}
