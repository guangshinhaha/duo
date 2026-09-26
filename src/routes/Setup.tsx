import { PairDuoForm } from "../components/PairDuoForm.js";
import { WorkspaceSignInForm } from "../components/WorkspaceSignInForm.js";
import type { DuoApiConfig } from "../api/client.js";
import type { WorkspaceSession } from "../workspace/matrix.js";
import { isHostedBuild } from "../workspace/access.js";

/**
 * Normalizes and validates a daemon address. A pasted tailnet address
 * missing its scheme (e.g. "100.64.1.5:7717", a plausible copy-paste
 * mistake off a terminal) is silently fatal otherwise: the browser
 * resolves it as a path relative to the client's own origin, and every
 * subsequent API call 404s or hits the wrong server with nothing telling
 * the owner what went wrong. Returns the normalized URL, or `null` for
 * anything the `URL` constructor itself can't parse.
 *
 * Exported because Settings re-edits the same field with the same rules
 * and the same error wording — one validator, no second copy to drift.
 */
export function normalizeBaseUrl(raw: string): string | null {
  const trimmed = raw.trim();
  // No manual trailing-slash strip: `URL.origin` (used below) is always
  // just `protocol://host[:port]` with no trailing slash by construction,
  // so there's nothing to strip after parsing — and stripping the raw
  // string *before* parsing is actively wrong for an input that's
  // nothing but a scheme, like "http://": removing one trailing "/"
  // turns it into "http:/", which no longer matches the scheme check
  // below, gets "http://" re-prepended, and silently parses as the valid
  // (but wrong) URL "http://http:/" — a real bug this shape hit in
  // testing, not a hypothetical one.
  const withScheme = /^https?:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(withScheme);
    if (!parsed.hostname) {
      return null;
    }
    // A hosted duo lives under a path on a shared daemon (`/t/<id>`, the
    // invite-only hosted mode), so the path is part of the address and is
    // kept — only its trailing slashes go, since every API path is
    // appended as `${baseUrl}/route`. A bare origin stays a bare origin.
    return `${parsed.origin}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return null;
  }
}

/**
 * First-run screen, now with two doors (#62): the workspace sign-in (who
 * you are, in an org — the front door a workspace with members needs) and
 * the duo pairing (paste the daemon's address and the token `duo pair new`
 * printed — still the right door for one person pairing their own phone).
 * Two credentials with separate lifetimes, so two forms, one screen; the
 * app opens as soon as EITHER succeeds. `notice` is App's one non-first-run
 * reason for being here: a revoked token (#41) unpairs from any surface
 * and lands here saying so, so the owner is never left guessing why the
 * app signed them out.
 */
export function Setup({
  onConnect,
  onWorkspaceSession,
  notice,
}: {
  onConnect: (config: DuoApiConfig) => void;
  onWorkspaceSession: (session: WorkspaceSession) => void;
  notice?: string;
}) {
  // #127: a hosted build never asks for a homeserver, even on this screen
  // (the "Advanced" door of the hosted front door) — and nobody is signed in
  // here yet, so the workspace section is left out and pairing leads.
  const hosted = isHostedBuild();
  return (
    // #38: dvh, not vh — this is the FIRST screen a phone reaches over
    // Tailscale (G4), and mobile Safari's collapsing URL bar would push the
    // submit buttons under it with a fixed 100vh.
    <div className="flex h-dvh items-center justify-center bg-[var(--bg)] px-4">
      <div className="shape-entry flex w-full max-w-sm flex-col gap-6 p-6">
        {notice && (
          <p
            className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-3 py-2 type-body text-[var(--escalate)]"
            data-testid="setup-notice"
            role="status"
          >
            {notice}
          </p>
        )}
        {!hosted && (
          <>
            <section className="flex flex-col gap-3">
              <h1 className="type-heading">Sign in to your workspace</h1>
              <p className="type-body text-[var(--muted)]">Who you are, in your org — separate from your duo, which only you reach.</p>
              <WorkspaceSignInForm onSession={onWorkspaceSession} />
            </section>
            <div className="border-t border-[var(--edge)]" />
          </>
        )}
        <section className="flex flex-col gap-3">
          {/* The page's only heading when the workspace section is left out. */}
          {hosted ? <h1 className="type-heading">Pair a duo instead</h1> : <h2 className="type-heading">Pair a duo instead</h2>}
          <p className="type-body text-[var(--muted)]">
            Run <code>duo pair new &quot;this device&apos;s name&quot;</code> on your Mac, then paste its address and token here.
          </p>
          <PairDuoForm onConnect={onConnect} />
          <p className="type-provenance text-[var(--muted)]" data-testid="setup-invite-hint">
            Have an invite link? Open it directly — it sets up a duo of your own and pairs this browser.
          </p>
        </section>
      </div>
    </div>
  );
}
