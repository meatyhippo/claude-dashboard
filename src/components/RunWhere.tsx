import { CloudIcon, LaptopIcon } from "./BaIcons.tsx";
import { useEffect, useState } from "react";
import { baRawFlags } from "../baFlags.ts";

/**
 * Where BA session buttons run: in the cloud (claude.ai/code) or on this Mac.
 * One click, saved at once for every button; no reload needed, since the daemon
 * reads the switch for each new session.
 */
let current = baRawFlags.cloudSessions;
const listeners = new Set<(v: boolean) => void>();

export function RunWhere({ compact }: { compact?: boolean }) {
  const [cloud, setCloud] = useState(current);
  useEffect(() => {
    listeners.add(setCloud);
    return () => void listeners.delete(setCloud);
  }, []);
  const set = (v: boolean) => {
    current = v;
    listeners.forEach((fn) => fn(v));
    void fetch("/api/ba/flags", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ cloudSessions: v }) });
    try {
      const raw = JSON.parse(localStorage.getItem("ba-flags") ?? "{}");
      localStorage.setItem("ba-flags", JSON.stringify({ ...raw, cloudSessions: v }));
    } catch {
      /* the daemon has it either way */
    }
  };
  return (
    <span className={`rw ba-seg ${compact ? "compact" : ""}`} role="radiogroup" aria-label="Where sessions run" title="Where session buttons start Claude: in the cloud (keeps running without this Mac) or on this Mac (with your local files)">
      <button role="radio" aria-checked={cloud} className={cloud ? "on" : ""} onClick={() => set(true)}>
        <CloudIcon /> Cloud
      </button>
      <button role="radio" aria-checked={!cloud} className={!cloud ? "on" : ""} onClick={() => set(false)}>
        <LaptopIcon /> This Mac
      </button>
    </span>
  );
}
