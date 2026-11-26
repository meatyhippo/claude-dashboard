import { useEffect, useState } from "react";
import { baApi } from "../api.ts";
import { baFlags } from "../baFlags.ts";
import { DRAWINGS_CHANGED } from "./drawingEvents.ts";

type Stray = { path: string; rel: string; modified: number };

/**
 * BA edition: Excalidraw files a session wrote somewhere else in the customer folder
 * (a workspace's own subfolder, say), which the Drawings box does not read. One click
 * moves a file into the customer's drawings/ so it joins the others.
 */
export function StrayDrawings({ projectId }: { projectId: number }) {
  const on = baFlags.enabled && baFlags.diagrams;
  const [list, setList] = useState<Stray[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const bump = () => setTick((n) => n + 1);
    window.addEventListener(DRAWINGS_CHANGED, bump);
    return () => window.removeEventListener(DRAWINGS_CHANGED, bump);
  }, []);
  useEffect(() => {
    if (!on) return;
    let stale = false;
    baApi
      .strayDrawings(projectId)
      .then((r) => !stale && setList(r.drawings))
      .catch(() => {});
    return () => {
      stale = true;
    };
  }, [on, projectId, tick]);
  if (!on || list.length === 0) return null;

  const adopt = async (s: Stray) => {
    setBusy(s.path);
    setError(null);
    try {
      await baApi.adoptStrayDrawing(projectId, s.path);
      window.dispatchEvent(new CustomEvent(DRAWINGS_CHANGED, { detail: { at: Date.now() } }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="stray-drawings">
      <h3>Found in workspace folders</h3>
      {list.map((s) => (
        <div key={s.path} className="stray-drawing">
          <code title={s.path}>{s.rel}</code>
          <button className="icon-btn" disabled={busy !== null} onClick={() => void adopt(s)} title="Move it into this customer's drawings folder, where the dashboard can open it">
            {busy === s.path ? "Moving…" : "Move to Drawings"}
          </button>
        </div>
      ))}
      {error && <p className="chat-error">{error}</p>}
    </div>
  );
}
