import { useCallback, useEffect, useState, type ReactNode } from "react";
import { claudeAuthApi, mcpApi, type ClaudeAuthStatus, type ClaudeLoginState, type McpServer } from "../api.ts";

/** The connectors the dashboard leans on, as they appear in `claude mcp list` ("claude.ai Notion"). */
const NEEDED = ["Notion", "Front", "Slack", "Qargo"];
const CONNECTORS_URL = "https://claude.ai/settings/connectors";

/**
 * First run: nothing works until the bundled Claude Code is signed in, so the app
 * shows this screen instead. Sign in opens the claude.ai page; the code it shows
 * after "Authorize" goes in the box. Signed in, it lists the connectors once and
 * lets you continue.
 */
export function SignInGate({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<ClaudeAuthStatus | null>(null);
  // Shown only when there was no login; after signing in it stays up for the connector check.
  const [gate, setGate] = useState(false);
  useEffect(() => {
    let stop = false;
    const load = () =>
      claudeAuthApi
        .get()
        .then((r) => {
          if (stop) return;
          setStatus(r.status);
          if (!r.status.loggedIn && !r.status.error) setGate(true);
        })
        .catch(() => !stop && setTimeout(load, 2000));
    load();
    return () => {
      stop = true;
    };
  }, []);
  if (!status || !gate) return <>{children}</>;
  return <SignInScreen status={status} onStatus={setStatus} onDone={() => setGate(false)} />;
}

function SignInScreen({ status, onStatus, onDone }: { status: ClaudeAuthStatus; onStatus: (s: ClaudeAuthStatus) => void; onDone: () => void }) {
  const [login, setLogin] = useState<ClaudeLoginState | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // While the browser is out, check every 2 seconds: some sign-ins finish without a code.
  useEffect(() => {
    if (status.loggedIn || !login?.running) return;
    const t = setInterval(() => void claudeAuthApi.get().then((r) => r.status.loggedIn && onStatus(r.status)).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [status.loggedIn, login?.running, onStatus]);

  const start = async (sso = false) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await claudeAuthApi.start({ sso });
      setLogin(r.login);
      if (r.login.url) window.open(r.login.url, "_blank", "noopener");
      else if (r.login.error) setErr(r.login.error);
      if (r.status?.loggedIn) onStatus(r.status);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!code.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await claudeAuthApi.code(code);
      setLogin(r.login);
      if (r.status?.loggedIn) onStatus(r.status);
      else if (r.login.done && !r.login.ok) setErr(r.login.error ?? "That code did not work. Start again.");
      else {
        const s = (await claudeAuthApi.get()).status;
        if (s.loggedIn) onStatus(s);
      }
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="signin">
      <div className="signin-card">
        <div className="signin-mark" aria-hidden="true">✳</div>
        {status.loggedIn ? (
          <>
            <h1>You're signed in</h1>
            <p className="signin-who">
              {status.email}
              {status.orgName ? ` · ${status.orgName}` : ""}
            </p>
            {status.orgName && !/qargo/i.test(status.orgName) && <p className="signin-warn">This is not your Qargo account. Sign out below and sign in with your Qargo email.</p>}
            <Connectors />
            <div className="signin-actions">
              <button className="signin-primary" onClick={onDone}>
                Open the dashboard
              </button>
              <button className="link-btn" onClick={() => void claudeAuthApi.logout().then((r) => onStatus(r.status))}>
                Sign out
              </button>
            </div>
          </>
        ) : !login?.running ? (
          <>
            <h1>Sign in to Claude</h1>
            <p>The dashboard works with your own Claude account. Sign in once with your Qargo email.</p>
            <div className="signin-actions">
              <button className="signin-primary" disabled={busy} onClick={() => void start(false)}>
                {busy ? "Opening…" : "Sign in with Claude"}
              </button>
              <button className="link-btn" disabled={busy} onClick={() => void start(true)}>
                Use single sign-on
              </button>
            </div>
          </>
        ) : (
          <>
            <h1>Finish in your browser</h1>
            <ol className="signin-steps">
              <li>On the Claude page that just opened, click <strong>Authorize</strong>.</li>
              <li>Copy the code it shows and paste it here.</li>
            </ol>
            <div className="signin-code">
              <input autoFocus placeholder="Paste the code" value={code} onChange={(e) => setCode(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void send()} />
              <button className="signin-primary" disabled={busy || !code.trim()} onClick={() => void send()}>
                {busy ? "Signing in…" : "Sign in"}
              </button>
            </div>
            <div className="signin-actions">
              {login.url && (
                <a className="link-btn" href={login.url} target="_blank" rel="noreferrer">
                  Open the Claude page again
                </a>
              )}
              <button className="link-btn" onClick={() => void claudeAuthApi.cancel().then(() => setLogin(null))}>
                Cancel
              </button>
            </div>
          </>
        )}
        {(err || status.error) && <p className="signin-error">{err ?? status.error}</p>}
      </div>
    </div>
  );
}

/** Which of the connectors the dashboard needs are on this Claude account. */
function Connectors() {
  const [list, setList] = useState<McpServer[] | null>(null);
  const [checking, setChecking] = useState(true);
  const load = useCallback(() => {
    void mcpApi
      .list()
      .then((r) => {
        setList(r.servers);
        setChecking(!!(r as { checking?: boolean }).checking);
        if ((r as { checking?: boolean }).checking) setTimeout(load, 3000);
      })
      .catch(() => setChecking(false));
  }, []);
  useEffect(() => {
    void mcpApi.refresh().finally(load);
  }, [load]);
  const find = (n: string) => list?.find((s) => s.origin === "claudeai" && new RegExp(`\\b${n}\\b`, "i").test(s.name));
  return (
    <div className="signin-conn">
      <div className="signin-conn-head">
        Connectors {checking && <span className="ba-muted">· checking…</span>}
      </div>
      {NEEDED.map((n) => {
        const s = find(n);
        const ok = s?.status === "connected";
        return (
          <div key={n} className={`signin-conn-row ${ok ? "ok" : ""}`}>
            <span className="signin-conn-dot" aria-hidden="true">{ok ? "✓" : "○"}</span>
            <span>{n}</span>
            {!ok && !checking && (
              <a className="link-btn" href={CONNECTORS_URL} target="_blank" rel="noreferrer">
                {s?.status === "needs-auth" ? "Reconnect on claude.ai" : "Add on claude.ai"}
              </a>
            )}
          </div>
        );
      })}
      <p className="ba-muted signin-conn-note">You can add connectors later too; the pages that need one say so.</p>
    </div>
  );
}

/** A line in Settings: who is signed in, and a way to switch. */
export function ClaudeAccountLine() {
  const [s, setS] = useState<ClaudeAuthStatus | null>(null);
  useEffect(() => void claudeAuthApi.get().then((r) => setS(r.status)).catch(() => {}), []);
  if (!s) return null;
  return (
    <div className="signin-line">
      <span>{s.loggedIn ? `Signed in to Claude as ${s.email}${s.orgName ? ` · ${s.orgName}` : ""}` : "Not signed in to Claude"}</span>
      <button
        className="link-btn"
        onClick={() => void (s.loggedIn ? claudeAuthApi.logout() : Promise.resolve(null)).then(() => location.reload())}
      >
        {s.loggedIn ? "Sign out" : "Sign in"}
      </button>
    </div>
  );
}
