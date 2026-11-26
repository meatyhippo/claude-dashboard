import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import { SignInGate } from "./components/ClaudeSignIn.tsx";
import "./styles.css";
import { installWindowActivity } from "./windowActivity.ts";

if ("dashboardShell" in window) {
  const root = document.documentElement;
  root.dataset.shell = "app";
  // The window buttons are drawn by macOS at a fixed size, so they cover more of
  // the page when it is zoomed out and less when zoomed in. The styles divide by this.
  const syncZoom = () => root.style.setProperty("--shell-zoom", (window.outerWidth / window.innerWidth || 1).toFixed(3));
  syncZoom();
  window.addEventListener("resize", syncZoom);
}
installWindowActivity();

// The development copy (vite, beside the installed app): marked so it is never taken for the live one.
if (import.meta.env.DEV) {
  document.documentElement.dataset.devCopy = "1";
  const mark = () => !document.title.startsWith("DEV · ") && (document.title = `DEV · ${document.title}`);
  mark();
  new MutationObserver(mark).observe(document.querySelector("title") ?? document.head, { childList: true, subtree: true, characterData: true });
  const tag = document.createElement("div");
  tag.className = "dev-copy-tag";
  tag.textContent = "DEV";
  tag.title = "Development copy: no background jobs, its own data. Your live app runs separately.";
  document.body.appendChild(tag);
}

createRoot(document.getElementById("root")!).render(
  <SignInGate>
    <App />
  </SignInGate>,
);
