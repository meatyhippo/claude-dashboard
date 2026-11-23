import { useState } from "react";
import { baApi } from "../api.ts";

/**
 * BA edition: above a customer's file workbench. Make a file or folder (with a
 * starter for .md, .html, .json and .jsonata), and open the folder in VS Code or Finder.
 */
export default function BaFilesBar({ projectId, onCreated }: { projectId: number; onCreated: (rel: string, kind: "file" | "folder") => void }) {
  const [mode, setMode] = useState<"file" | "folder" | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = () => {
    if (!mode || !name.trim()) return;
    baApi
      .newEntry(projectId, name.trim(), mode)
      .then((r) => {
        onCreated(r.rel, mode);
        setMode(null);
        setName("");
        setError(null);
      })
      .catch((e) => setError(String(e?.message ?? e)));
  };
  return (
    <div className="ba-filesbar">
      {mode ? (
        <>
          <input
            className="drawings-search"
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => (e.key === "Enter" ? create() : e.key === "Escape" ? setMode(null) : undefined)}
            placeholder={mode === "file" ? "notes/kick-off.md, mappings/order-import.jsonata, spec.html…" : "mappings, samples/2026-11…"}
          />
          <button className="icon-btn primary" disabled={!name.trim()} onClick={create}>
            Create {mode}
          </button>
          <button className="icon-btn ghost" onClick={() => setMode(null)}>
            Cancel
          </button>
        </>
      ) : (
        <>
          <button className="icon-btn" onClick={() => setMode("file")}>
            + New file
          </button>
          <button className="icon-btn" onClick={() => setMode("folder")}>
            + New folder
          </button>
          <span className="ba-filesbar-gap" />
          <button className="icon-btn ghost" onClick={() => void baApi.openFolder(projectId, "vscode").catch((e) => setError(String(e?.message ?? e)))}>
            Open in VS Code
          </button>
          <button className="icon-btn ghost" onClick={() => void baApi.openFolder(projectId, "finder").catch((e) => setError(String(e?.message ?? e)))}>
            Show in Finder
          </button>
        </>
      )}
      {error && <span className="chat-error">{error}</span>}
    </div>
  );
}
