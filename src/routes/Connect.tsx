import { useEffect, useRef, useState } from "react";
import { ApiRequestError } from "../api/client.js";
import { decideConnect, fetchConnectRequest, fetchHostedConfig, parseConnectHash, type ConnectScope } from "../api/hosted.js";
import { GoogleSignInButton } from "../components/GoogleSignInButton.js";

/** The one permission that lets Claude act as the owner. It is never ticked for them, whatever the daemon's list says. */
const SEND_SCOPE = "duo:send";

/** Where the browser may be sent back to after the owner decides: Claude's own origins, and nothing the server names. */
const CLAUDE_ORIGINS: ReadonlySet<string> = new Set(["https://claude.ai", "https://claude.com"]);

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

/**
 * The daemon answers where to send the browser back to. It is followed only
 * when it is one of Claude's own origins, with no credentials in the address
 * (`https://claude.ai@elsewhere.example` reads as claude.ai and is not): a
 * client can register any callback name it likes, and what it registered is
 * not something this page can vouch for.
 */
function isFollowable(redirectTo: string): boolean {
  try {
    const url = new URL(redirectTo);
    return url.protocol === "https:" && !url.username && !url.password && CLAUDE_ORIGINS.has(url.origin);
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
 *
 * A link is anyone's to write, so `host` is honoured only when it is a
 * daemon this app already trusts (`trustedOrigins`). Otherwise nothing is
 * fetched and no Google sign-in is offered: the ID token this page collects
 * is what the daemon accepts for a device token, so it must never go to an
 * address a link chose.
 */
export function Connect({
  hash,
  trustedOrigins,
  navigate = (url) => window.location.assign(url),
}: {
  hash: string;
  trustedOrigins: readonly string[];
  navigate?: (url: string) => void;
}) {
  const target = parseConnectHash(hash);
  const trusted = target !== null && trustedOrigins.includes(target.host);
  const [clientId, setClientId] = useState<string | null | undefined>(undefined);
  const [configFailed, setConfigFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const [clientName, setClientName] = useState<string | null>(null);
  // What Claude asked for, in the daemon's words, and which of it the owner has ticked. Null from a daemon that predates permissions.
  const [scopes, setScopes] = useState<readonly ConnectScope[] | null>(null);
  const [chosen, setChosen] = useState<ReadonlySet<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expired, setExpired] = useState(false);
  const [declined, setDeclined] = useState(false);
  const host = trusted ? target.host : undefined;
  const request = trusted ? target.request : undefined;

  useEffect(() => {
    if (!host || !request) {
      return;
    }
    let cancelled = false;
    setConfigFailed(false);
    setError(null);
    fetchHostedConfig(host)
      .then((config) => !cancelled && setClientId(config.googleClientId ?? null))
      .catch(() => !cancelled && setConfigFailed(true));
    fetchConnectRequest({ host, request })
      .then((answer) => {
        if (cancelled) {
          return;
        }
        setClientName(answer.clientName);
        setScopes(answer.scopes ?? null);
        setChosen(new Set((answer.scopes ?? []).filter((scope) => scope.defaultOn && scope.id !== SEND_SCOPE).map((scope) => scope.id)));
      })
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
  }, [host, request, attempt]);

  // The Google popup can finish long after the button was clicked, and the checklist stays editable meanwhile, so what to
  // send is read from here when the credential arrives, not from the render the button last saw.
  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;

  const toggle = (id: string) =>
    setChosen((current) => {
      const next = new Set(current);
      if (!next.delete(id)) {
        next.add(id);
      }
      return next;
    });

  const decide = (decision: { credential: string } | "deny") => {
    if (!target || !trusted || pending) {
      return;
    }
    const ticked = [...chosenRef.current];
    if (decision !== "deny" && scopes && ticked.length === 0) {
      // Everything was unticked while Google's popup was open: send nothing rather than what was ticked a moment ago.
      return;
    }
    setPending(true);
    setError(null);
    decideConnect(target, decision === "deny" ? decision : { ...decision, scopes: scopes ? ticked : undefined })
      .then(({ redirectTo }) => {
        if (!isFollowable(redirectTo)) {
          // The daemon has already taken the answer, so this must not claim nothing happened.
          setError("The server sent an address this page won't follow. Go back to Claude and check whether it connected.");
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
        ) : !trusted ? (
          <p className="type-body text-[var(--refused)]" data-testid="connect-untrusted" role="status">
            This link points to {new URL(target.host).host}, which isn&apos;t a server this app is set up to use, so nothing was sent to it. Start again from Claude in
            your own duo&apos;s app.
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
            {clientName === null ? (
              error ? null : (
                <p className="type-provenance text-[var(--muted)]" role="status">
                  Connecting…
                </p>
              )
            ) : (
              <>
                {scopes && scopes.length > 0 ? (
                  <fieldset className="flex flex-col gap-2" data-testid="connect-scopes">
                    <legend className="type-body">{who} is asking to work with your duo. Choose what it may do:</legend>
                    {scopes.map((scope) => (
                      <label className="flex items-start gap-2" data-testid={`connect-scope-${scope.id}`} key={scope.id}>
                        <input checked={chosen.has(scope.id)} className="mt-1 h-4 w-4" disabled={pending} onChange={() => toggle(scope.id)} type="checkbox" />
                        <span className="flex flex-col">
                          <span className="type-body">{scope.label}</span>
                          <span className="type-provenance text-[var(--muted)]">{scope.description}</span>
                        </span>
                      </label>
                    ))}
                    {chosen.has("duo:send") && (
                      <p className="type-provenance text-[var(--escalate)]" data-testid="connect-send-warning" role="status">
                        Send lets Claude act as you. Only allow it if you want that.
                      </p>
                    )}
                  </fieldset>
                ) : scopes ? null : (
                  <p className="type-body">
                    {who} is asking to save notes to your duo when you tell it to. It can add notes; it can&apos;t read what is in your duo or act as you.
                  </p>
                )}
                <p className="type-provenance text-[var(--muted)]" data-testid="connect-host">
                  Your duo is on <span className="type-identifier">{new URL(target.host).host}</span>. You can disconnect {who} any time from Settings.
                </p>
                {configFailed ? (
                  <div className="flex flex-col gap-2" data-testid="connect-config-failed">
                    <p className="type-body text-[var(--refused)]" role="status">
                      Couldn&apos;t load sign-in from the duo server.
                    </p>
                    <button
                      className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                      onClick={() => setAttempt((count) => count + 1)}
                      type="button"
                    >
                      Try again
                    </button>
                  </div>
                ) : clientId === undefined ? (
                  <p className="type-provenance text-[var(--muted)]" role="status">
                    Connecting…
                  </p>
                ) : scopes && scopes.length === 0 ? (
                  <p className="type-body text-[var(--muted)]" data-testid="connect-nothing-offered" role="status">
                    {who} isn&apos;t asking for anything this server offers, so there is nothing to allow. You can decline.
                  </p>
                ) : scopes && chosen.size === 0 ? (
                  <p className="type-body text-[var(--muted)]" data-testid="connect-choose-one" role="status">
                    Choose at least one thing above to continue, or decline.
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
                  </div>
                ) : (
                  <p className="type-body text-[var(--refused)]" data-testid="connect-no-sign-in" role="status">
                    Sign-in isn&apos;t set up on this server, so Claude can&apos;t be connected this way.
                  </p>
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
              </>
            )}
            {error && (
              <div className="flex flex-col gap-2">
                <p className="type-body text-[var(--refused)]" data-testid="connect-error" role="status">
                  {error}
                </p>
                {clientName === null && (
                  <button
                    className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                    onClick={() => setAttempt((count) => count + 1)}
                    type="button"
                  >
                    Try again
                  </button>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
