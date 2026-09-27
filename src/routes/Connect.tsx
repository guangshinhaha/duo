import { useEffect, useState } from "react";
import { ApiRequestError } from "../api/client.js";
import { decideConnect, fetchConnectRequest, fetchHostedConfig, parseConnectHash } from "../api/hosted.js";
import { GoogleSignInButton } from "../components/GoogleSignInButton.js";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "no_duo") {
      return "There's no duo for this Google account, so nothing was connected. Sign in with the account that owns your duo.";
    }
    if (error.code === "request_expired") {
      return "This connection request has expired. Start again from Claude.";
    }
    return error.message;
  }
  if (error instanceof TypeError) {
    return "Couldn't reach the duo server. Check your connection and try again.";
  }
  return "Something went wrong connecting Claude. Try again.";
}

/** The daemon answers where to send the browser back to; only an https address is ever followed. */
function isFollowable(redirectTo: string): boolean {
  try {
    return new URL(redirectTo).protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Where claude.ai sends the owner to sign in (`#connect?host=…&request=…`,
 * digital-duo#240): the daemon has registered Claude and remembered its
 * request, and this page shows what is being asked, takes the Google
 * sign-in (which is what tells the daemon whose duo it is) and sends the
 * browser back to Claude with the answer. The daemon only ever grants the
 * duo that the signed-in account owns, so there is nothing to choose here.
 * Like Join it outranks every other surface: paired or not, whoever opened
 * this link sees it.
 */
export function Connect({ hash, navigate = (url) => window.location.assign(url) }: { hash: string; navigate?: (url: string) => void }) {
  const target = parseConnectHash(hash);
  const [clientId, setClientId] = useState<string | null | undefined>(undefined);
  const [clientName, setClientName] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [declined, setDeclined] = useState(false);
  const host = target?.host;
  const request = target?.request;

  useEffect(() => {
    if (!host || !request) {
      return;
    }
    let cancelled = false;
    fetchHostedConfig(host)
      .then((config) => !cancelled && setClientId(config.googleClientId ?? null))
      .catch(() => !cancelled && setClientId(null));
    fetchConnectRequest({ host, request })
      .then((answer) => !cancelled && setClientName(answer.clientName))
      .catch((reason: unknown) => {
        if (cancelled) {
          return;
        }
        if (reason instanceof ApiRequestError && reason.code === "request_expired") {
          setExpired(true);
        } else {
          setError(errorText(reason));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [host, request]);

  const decide = (decision: { credential: string } | "deny") => {
    if (!target || pending) {
      return;
    }
    setPending(true);
    setError(null);
    decideConnect(target, decision)
      .then(({ redirectTo }) => {
        if (!isFollowable(redirectTo)) {
          setError("The server sent an address this page won't follow. Nothing was connected.");
          setPending(false);
          return;
        }
        if (decision === "deny") {
          setDeclined(true);
        }
        navigate(redirectTo);
      })
      .catch((reason: unknown) => {
        setExpired(reason instanceof ApiRequestError && reason.code === "request_expired");
        setError(errorText(reason));
        setPending(false);
      });
  };

  const who = clientName ?? "Claude";
  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg)] px-4">
      <div className="shape-entry flex w-full max-w-sm flex-col gap-4 p-6" data-testid="connect">
        <h1 className="type-heading">Connect {who} to your duo</h1>
        {!target ? (
          <p className="type-body text-[var(--refused)]" data-testid="connect-invalid" role="status">
            This connection link is incomplete. Start again from Claude.
          </p>
        ) : expired ? (
          <p className="type-body text-[var(--refused)]" data-testid="connect-expired" role="status">
            {errorText(new ApiRequestError(404, { error: { code: "request_expired", message: "" } }))}
          </p>
        ) : declined ? (
          <p className="type-body" data-testid="connect-declined" role="status">
            You declined. Nothing was connected.
          </p>
        ) : (
          <>
            <p className="type-body">
              {who} is asking to save notes to your duo when you tell it to. It can add notes; it can&apos;t read what is in your duo or act as you.
            </p>
            <p className="type-provenance text-[var(--muted)]" data-testid="connect-host">
              Your duo is on <span className="type-identifier">{new URL(target.host).host}</span>. You can disconnect {who} any time from Settings.
            </p>
            {clientId === undefined ? (
              <p className="type-provenance text-[var(--muted)]" role="status">
                Connecting…
              </p>
            ) : clientId ? (
              <div className="flex flex-col gap-3" data-testid="connect-google">
                <p className="type-body">Sign in with Google to allow it. That is how your duo knows it is you.</p>
                {pending ? (
                  <p className="type-provenance text-[var(--muted)]" role="status">
                    Connecting…
                  </p>
                ) : (
                  <GoogleSignInButton clientId={clientId} onCredential={(credential) => decide({ credential })} />
                )}
                <button
                  className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
                  data-testid="connect-decline"
                  disabled={pending}
                  onClick={() => decide("deny")}
                  type="button"
                >
                  Decline
                </button>
              </div>
            ) : (
              <p className="type-body text-[var(--refused)]" data-testid="connect-no-sign-in" role="status">
                Sign-in isn&apos;t set up on this server, so Claude can&apos;t be connected this way.
              </p>
            )}
            {error && (
              <p className="type-body text-[var(--refused)]" data-testid="connect-error" role="status">
                {error}
              </p>
            )}
          </>
        )}
      </div>
    </div>
  );
}
