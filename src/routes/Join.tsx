import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { ApiRequestError } from "../api/client.js";
import { accountFor, configuredDaemonOrigin, fetchHostedConfig, parseJoinHash, signUp, type HostedAccount } from "../api/hosted.js";
import { GoogleSignInButton } from "../components/GoogleSignInButton.js";

/** The daemon's own words for a refused invite are kept, but the reason a person most needs is what to do next. */
function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "invite_invalid") {
      return "This invite can't be used — it has already been used, has expired, or was never issued. Ask whoever sent it for a new one.";
    }
    if (error.code === "already_has_duo") {
      return "This Google account already has a duo — sign in to it instead. The invite hasn't been used up.";
    }
    // invite_wrong_account: the daemon's own message names the email the invite is for.
    return error.message;
  }
  if (error instanceof TypeError) {
    return "Couldn't reach the duo server. Check your connection and try again.";
  }
  return "Something went wrong creating your duo. Try again.";
}

/**
 * Invite-only hosted mode's front door: `#join?host=…&invite=…`. On a
 * server with sign-in (`GET /hosted/config` names a Google client id) the
 * person continues with Google — their duo is bound to that account, which
 * is what lets them sign back in anywhere; otherwise it asks their name, spends the invite (`POST {host}/hosted/signup`), and pairs
 * this browser to the new duo exactly the way Setup does after pairing —
 * the connection is `host + basePath` plus the first device token. Then it
 * lands on onboarding, where the duo gets built.
 *
 * A link is anyone's to write, so `host` is honoured only when it is a
 * daemon this app already trusts (`trustedOrigins` — the one this build was
 * made for, or the one this browser is already paired to). Otherwise
 * nothing is fetched and no Google sign-in or signup is offered: the ID
 * token this page collects, and the invite code itself, are what
 * `/hosted/signup` spends, so neither may go to an address a link alone
 * chose. The one exception is a build with no configured daemon at all
 * (the plain pair-with-your-Mac app) — it has no built-in origin to check
 * against, so instead of refusing outright it shows the host from the link
 * and asks the owner to confirm it before anything is sent.
 *
 * A browser already paired to a duo is told that joining replaces that
 * pairing on this browser (the other duo itself is untouched).
 */
export function Join({
  hash,
  alreadyPaired,
  trustedOrigins,
  onJoined,
}: {
  hash: string;
  alreadyPaired: boolean;
  trustedOrigins: readonly string[];
  onJoined: (config: DuoApiConfig, account: HostedAccount) => void;
}) {
  const invite = parseJoinHash(hash);
  const knownOrigin = invite !== null && trustedOrigins.includes(invite.host);
  // No daemon this build is pinned to: there is no fixed origin to check the link against, so the
  // owner is asked to confirm it themselves instead of the link being trusted outright.
  const confirmable = invite !== null && !knownOrigin && configuredDaemonOrigin() === null;
  const [hostConfirmed, setHostConfirmed] = useState(false);
  const trusted = invite !== null && (knownOrigin || (confirmable && hostConfirmed));
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [alreadyHasDuo, setAlreadyHasDuo] = useState(false);
  // undefined while asking the server; null when it has no sign-in (the name form).
  const [clientId, setClientId] = useState<string | null | undefined>(undefined);
  const host = trusted && invite ? invite.host : undefined;

  useEffect(() => {
    if (!host) {
      return;
    }
    let cancelled = false;
    fetchHostedConfig(host)
      .then((config) => !cancelled && setClientId(config.googleClientId ?? null))
      // A server that can't answer /hosted/config predates sign-in: the name form still works against it.
      .catch(() => !cancelled && setClientId(null));
    return () => {
      cancelled = true;
    };
  }, [host]);

  const join = (who: { name: string } | { credential: string }) => {
    if (!invite || !trusted || pending) {
      return;
    }
    setPending(true);
    setError(null);
    setAlreadyHasDuo(false);
    signUp(invite, who)
      .then(({ config, result }) => onJoined(config, accountFor(invite.host, result)))
      .catch((reason: unknown) => {
        setAlreadyHasDuo(reason instanceof ApiRequestError && reason.code === "already_has_duo");
        setError(errorText(reason));
        setPending(false);
      });
  };

  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg)] px-4">
      <div className="shape-entry flex w-full max-w-sm flex-col gap-4 p-6" data-testid="join">
        <h1 className="type-heading">Create your duo</h1>
        {!invite ? (
          <p className="type-body text-[var(--refused)]" data-testid="join-invalid" role="status">
            This invite link is incomplete — it needs both the server address and the invite code. Ask whoever sent it to send it again.
          </p>
        ) : !knownOrigin && !confirmable ? (
          <p className="type-body text-[var(--refused)]" data-testid="join-untrusted" role="status">
            This link points to {new URL(invite.host).host}, which isn&apos;t a server this app is set up to use, so nothing was sent to it.
            Ask whoever invited you to send the invite your duo&apos;s app itself would give out.
          </p>
        ) : !trusted ? (
          <div className="flex flex-col gap-3" data-testid="join-confirm-host">
            <p className="type-body text-[var(--muted)]">
              This invite points to <span className="type-identifier">{new URL(invite.host).host}</span>. This app isn&apos;t set up to use a
              particular server, so make sure you trust this one before continuing — whoever runs it can read what you put in your duo.
            </p>
            <button
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)]"
              data-testid="join-confirm-host-button"
              onClick={() => setHostConfirmed(true)}
              type="button"
            >
              Continue to {new URL(invite.host).host}
            </button>
          </div>
        ) : (
          <>
            <p className="type-body text-[var(--muted)]">
              You&apos;ve been invited to try Digital Duo: an AI counterpart that learns how you answer, drafts replies for you to approve, and
              never poses as you.
            </p>
            <p className="type-provenance text-[var(--muted)]" data-testid="join-host">
              Your duo will live on <span className="type-identifier">{new URL(invite.host).host}</span>. Whoever runs that server can
              technically read what you put in it — only import what you&apos;re comfortable sharing with them.
            </p>
            {alreadyPaired && (
              <p className="type-provenance text-[var(--escalate)]" data-testid="join-replaces" role="status">
                This browser is already paired with a duo. Joining pairs it with your new one instead — the other duo itself isn&apos;t touched.
              </p>
            )}
            {clientId === undefined ? (
              <p className="type-provenance text-[var(--muted)]" role="status">
                Connecting…
              </p>
            ) : clientId ? (
              <div className="flex flex-col gap-3" data-testid="join-google">
                <p className="type-body">Continue with Google to create your duo. You&apos;ll sign in the same way on any browser later.</p>
                {pending ? (
                  <p className="type-provenance text-[var(--muted)]" role="status">
                    Creating your duo…
                  </p>
                ) : (
                  <GoogleSignInButton clientId={clientId} onCredential={(credential) => join({ credential })} text="continue_with" />
                )}
                {error && (
                  <p className="type-body text-[var(--refused)]" data-testid="join-error" role="status">
                    {error}
                  </p>
                )}
                {alreadyHasDuo && (
                  <a className="self-start type-body text-[var(--accent)] underline" data-testid="join-sign-in-instead" href="#">
                    Go to sign in
                  </a>
                )}
              </div>
            ) : (
              <form
                className="flex flex-col gap-3"
                onSubmit={(e) => {
                  e.preventDefault();
                  const trimmed = name.trim();
                  if (trimmed) {
                    join({ name: trimmed });
                  }
                }}
              >
                <label className="flex flex-col gap-1 type-body">
                  Your name
                  <input
                    autoComplete="name"
                    className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
                    disabled={pending}
                    onChange={(e) => {
                      setName(e.target.value);
                      setError(null);
                    }}
                    value={name}
                  />
                </label>
                <p className="type-provenance text-[var(--muted)]">How your duo attributes its answers — &quot;{name.trim() || "your name"}&apos;s duo&quot;.</p>
                {error && (
                  <p className="type-body text-[var(--refused)]" data-testid="join-error" role="status">
                    {error}
                  </p>
                )}
                <button
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                  disabled={pending || name.trim().length === 0}
                  type="submit"
                >
                  {pending ? "Creating your duo…" : "Create my duo"}
                </button>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
}
