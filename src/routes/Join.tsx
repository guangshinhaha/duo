import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { ApiRequestError } from "../api/client.js";
import { parseJoinHash, signUp } from "../api/hosted.js";

/** The daemon's own words for a refused invite are kept, but the reason a person most needs is what to do next. */
function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) {
    if (error.code === "invite_invalid") {
      return "This invite can't be used — it has already been used, has expired, or was never issued. Ask whoever sent it for a new one.";
    }
    return error.message;
  }
  if (error instanceof TypeError) {
    return "Couldn't reach the duo server. Check your connection and try again.";
  }
  return "Something went wrong creating your duo. Try again.";
}

/**
 * Invite-only hosted mode's front door: `#join?host=…&invite=…`. Asks the
 * person's name, spends the invite (`POST {host}/hosted/signup`), and pairs
 * this browser to the new duo exactly the way Setup does after pairing —
 * the connection is `host + basePath` plus the first device token. Then it
 * lands on onboarding, where the duo gets built.
 *
 * A browser already paired to a duo is told that joining replaces that
 * pairing on this browser (the other duo itself is untouched).
 */
export function Join({
  hash,
  alreadyPaired,
  onJoined,
}: {
  hash: string;
  alreadyPaired: boolean;
  onJoined: (config: DuoApiConfig) => void;
}) {
  const invite = parseJoinHash(hash);
  const [name, setName] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex h-dvh items-center justify-center bg-[var(--bg)] px-4">
      <div className="shape-entry flex w-full max-w-sm flex-col gap-4 p-6" data-testid="join">
        <h1 className="type-heading">Create your duo</h1>
        {!invite ? (
          <p className="type-body text-[var(--refused)]" data-testid="join-invalid" role="status">
            This invite link is incomplete — it needs both the server address and the invite code. Ask whoever sent it to send it again.
          </p>
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
            <form
              className="flex flex-col gap-3"
              onSubmit={(e) => {
                e.preventDefault();
                const trimmed = name.trim();
                if (!trimmed || pending) {
                  return;
                }
                setPending(true);
                setError(null);
                signUp(invite, trimmed)
                  .then(({ config }) => onJoined(config))
                  .catch((reason: unknown) => {
                    setError(errorText(reason));
                    setPending(false);
                  });
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
          </>
        )}
      </div>
    </div>
  );
}
