import { useSyncExternalStore } from "react";
import { shell } from "./shell.ts";

/**
 * BA edition: the cloud-session panel. A claude.ai/code session opens docked on
 * the right of the app (CloudPanel.tsx), next to the page, so mail, files and
 * tickets stay usable. Only the Mac app can embed claude.ai (an Electron
 * <webview>); in a browser the session opens in a tab, as before.
 */
export type CloudPanelState = { url: string | null; width: number };

const WIDTH_KEY = "ba.cloudPanel.width";
const MIN_W = 380;

function savedWidth(): number {
  try {
    const n = Number(window.localStorage.getItem(WIDTH_KEY));
    if (n >= MIN_W) return n;
  } catch {
    // Default width.
  }
  return 560;
}

let state: CloudPanelState = { url: null, width: savedWidth() };
const listeners = new Set<() => void>();
const set = (next: Partial<CloudPanelState>) => {
  state = { ...state, ...next };
  for (const l of listeners) l();
};

/** True when cloud sessions can open in the panel (the Mac app). */
export const canEmbedCloud = !!shell;

export const isCloudUrl = (url: string) => /^https:\/\/claude\.ai\//.test(url);

/** Opens a claude.ai/code session in the panel, or in a browser tab outside the app. */
export function openCloud(url: string) {
  if (canEmbedCloud && isCloudUrl(url)) set({ url });
  else window.open(url, "_blank", "noopener");
}

export const closeCloud = () => set({ url: null });

export function setCloudWidth(width: number) {
  const w = Math.round(Math.max(MIN_W, Math.min(width, window.innerWidth - 360)));
  set({ width: w });
  try {
    window.localStorage.setItem(WIDTH_KEY, String(w));
  } catch {
    // Width is only a convenience.
  }
}

export function useCloudPanel(): CloudPanelState {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => state,
  );
}
