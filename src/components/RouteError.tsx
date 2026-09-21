import { ApiRequestError, type DuoApiConfig } from "../api/client.js";

/**
 * Errors that say what to do (#37). The headline is the app's voice and
 * names the class of failure — unreachable daemon, gone, refused, broken —
 * because "what happened and what to try" is this client's half of the
 * contract. The daemon's own message renders beneath it, verbatim, in
 * provenance style: this client never paraphrases the daemon (§1.5 wrote
 * its error messages for a human already), and the code rides along as an
 * identifier chip when the daemon sent one. "Try again" refetches the read
 * — nothing more, nothing the query doesn't already know how to do.
 */
export function RouteError({ api, error, onRetry }: { api: DuoApiConfig; error: unknown; onRetry: () => void }) {
  const apiError = error instanceof ApiRequestError ? error : null;
  const rawMessage = error instanceof Error ? error.message : null;

  let headline: string;
  if (apiError) {
    if (apiError.status === 401) {
      headline = "This device is no longer paired with the daemon.";
    } else if (apiError.status === 404) {
      headline = "The daemon doesn't have this.";
    } else if (apiError.status >= 500) {
      headline = "The daemon had a problem.";
    } else {
      headline = "The daemon refused this request.";
    }
  } else {
    // Not an ApiRequestError: the request never got an answer worth naming
    // — the reachable-daemon question is the one worth asking first.
    headline = `Can't reach the daemon at ${api.baseUrl} — check that it's running and reachable.`;
  }

  return (
    <div className="p-6" data-testid="route-error" role="alert">
      <div className="flex max-w-xl flex-col gap-2">
        <div className="flex items-baseline gap-2">
          <h2 className="type-heading text-[var(--refused)]">{headline}</h2>
          {apiError && apiError.code !== "unknown" && (
            <span className="rounded-[var(--r-sm)] border border-[var(--edge)] px-2 py-0 type-identifier text-[var(--muted)]" data-testid="route-error-code">
              {apiError.code}
            </span>
          )}
        </div>
        {/* The daemon's words (or the wire's), exactly as they arrived. */}
        {rawMessage && (
          <p className="type-provenance text-[var(--muted)]" data-testid="route-error-message">
            {rawMessage}
          </p>
        )}
        <button
          className="self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1"
          data-testid="route-error-retry"
          onClick={onRetry}
        >
          Try again
        </button>
      </div>
    </div>
  );
}
