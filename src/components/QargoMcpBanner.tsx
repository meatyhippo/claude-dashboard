import { useEffect, useState } from "react";
import { baApi } from "../api.ts";
import { baFlags } from "../baFlags.ts";
import { ConnectorSignIn } from "./Conversation.tsx";

/**
 * BA edition: the Qargo MCP connectors (qargo-mcp-test / -prod) sign in on their own
 * and drop out overnight. Checked when the app starts and again every half hour while
 * this is on screen, so the sign-in happens here, in the morning, rather than in the
 * middle of a ticket's chat. "Not now" hides it until the next day.
 */
const HIDE_KEY = "ba-mcp-banner-hidden";
const today = () => new Date().toDateString();
const hiddenToday = () => {
  try {
    return localStorage.getItem(HIDE_KEY) === today();
  } catch {
    return false;
  }
};

export function QargoMcpBanner() {
  const [st, setSt] = useState<{ test: string; prod: string } | null>(null);
  const [hidden, setHidden] = useState(hiddenToday);
  const check = (refresh = false) => void baApi.qargoMcp(refresh).then(setSt).catch(() => {});
  useEffect(() => {
    if (!baFlags.enabled || !baFlags.qargoMcp) return;
    check();
    const t = setInterval(() => {
      setHidden(hiddenToday());
      check();
    }, 30 * 60_000);
    return () => clearInterval(t);
  }, []);
  if (!baFlags.enabled || !baFlags.qargoMcp || hidden || !st) return null;
  const out = (["prod", "test"] as const).filter((x) => st[x] === "needs-auth");
  if (!out.length) return null;
  return (
    <div className="mcp-banner" role="status">
      <span>
        <strong>Qargo MCP {out.join(" and ")} {out.length > 1 ? "are" : "is"} not signed in.</strong> Sign in now so ticket chats can reach the tenant without stopping for it.
      </span>
      <ConnectorSignIn names={out.map((x) => `claude.ai qargo-mcp-${x}`)} okText="" onSignedIn={() => check(true)} />
      <button
        className="icon-btn ghost"
        onClick={() => {
          try {
            localStorage.setItem(HIDE_KEY, today());
          } catch {}
          setHidden(true);
        }}
      >
        Not now
      </button>
    </div>
  );
}
