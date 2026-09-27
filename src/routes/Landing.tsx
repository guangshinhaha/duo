import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { ApiRequestError } from "../api/client.js";
import { accountFor, fetchHostedConfig, logIn, type HostedAccount } from "../api/hosted.js";
import type { WorkspaceSession } from "../workspace/matrix.js";
import { GoogleSignInButton } from "../components/GoogleSignInButton.js";
import { Setup } from "./Setup.js";

function signInErrorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "no_duo") {
      return "There's no duo for this Google account yet. Ask the person who runs this server for an invite link, then open it.";
    }
    if (error.code === "rate_limited") {
      return "Too many sign-in attempts from here. Wait a few minutes and try again.";
    }
    return error.message;
  }
  if (error instanceof TypeError) {
    return "Couldn't reach the duo server. Check your connection and try again.";
  }
  return "Signing in didn't work. Try again.";
}

type ConfigState = { kind: "loading" } | { kind: "google"; clientId: string } | { kind: "none" } | { kind: "unreachable" };

/**
 * The front door of a hosted build (`VITE_DUO_DAEMON_URL` set): the server
 * is already known, so there is no address to type and no token to paste —
 * just Sign in with Google, which answers this account's duo and a fresh
 * device token for this browser. A server without sign-in configured, or a
 * person who wants a different server, gets the original Setup screen.
 */
export function Landing({
  origin,
  notice,
  onSignedIn,
  onConnect,
  onWorkspaceSession,
}: {
  origin: string;
  notice?: string;
  onSignedIn: (config: DuoApiConfig, account: HostedAccount) => void;
  onConnect: (config: DuoApiConfig) => void;
  onWorkspaceSession: (session: WorkspaceSession) => void;
}) {
  const [config, setConfig] = useState<ConfigState>({ kind: "loading" });
  const [manual, setManual] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetchHostedConfig(origin)
      .then((answer) => {
        if (!cancelled) {
          setConfig(answer.googleClientId ? { kind: "google", clientId: answer.googleClientId } : { kind: "none" });
        }
      })
      .catch(() => {
        if (!cancelled) {
          setConfig({ kind: "unreachable" });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [origin]);

  if (manual || config.kind === "none") {
    return <Setup notice={notice} onConnect={onConnect} onWorkspaceSession={onWorkspaceSession} />;
  }

  const signIn = (credential: string) => {
    setPending(true);
    setError(null);
    logIn(origin, credential)
      .then(({ config: connection, result }) => onSignedIn(connection, accountFor(origin, result)))
      .catch((reason: unknown) => {
        setError(signInErrorText(reason));
        setPending(false);
      });
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg)] px-4">
      <div className="shape-entry flex w-full max-w-sm flex-col gap-5 p-6" data-testid="landing">
        {notice && (
          <p
            className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-3 py-2 type-body text-[var(--escalate)]"
            data-testid="landing-notice"
            role="status"
          >
            {notice}
          </p>
        )}
        <div className="flex flex-col gap-2">
          <h1 className="type-heading">Digital Duo</h1>
          <p className="type-body text-[var(--muted)]">
            Your AI counterpart: it learns how you answer, drafts replies for you to approve, and never poses as you.
          </p>
        </div>
        {config.kind === "loading" && (
          <p className="type-provenance text-[var(--muted)]" role="status">
            Connecting…
          </p>
        )}
        {config.kind === "unreachable" && (
          <p className="type-body text-[var(--refused)]" data-testid="landing-unreachable" role="status">
            Couldn&apos;t reach the duo server. Check your connection and reload.
          </p>
        )}
        {config.kind === "google" && (
          <div className="flex flex-col gap-3">
            {pending ? (
              <p className="type-provenance text-[var(--muted)]" role="status">
                Signing you in…
              </p>
            ) : (
              <GoogleSignInButton clientId={config.clientId} onCredential={signIn} />
            )}
            {error && (
              <p className="type-body text-[var(--refused)]" data-testid="landing-error" role="status">
                {error}
              </p>
            )}
            <p className="type-provenance text-[var(--muted)]">New here? Duos are invite-only — open the invite link you were sent.</p>
          </div>
        )}
        <button
          className="self-start type-provenance text-[var(--faint)] underline"
          data-testid="landing-advanced"
          onClick={() => setManual(true)}
          type="button"
        >
          Advanced: connect to a server by address
        </button>
        <p className="type-provenance text-[var(--faint)]" data-testid="landing-legal">
          <a className="underline" href="/privacy.html">Privacy</a> · <a className="underline" href="/terms.html">Terms</a>
        </p>
      </div>
    </div>
  );
}
