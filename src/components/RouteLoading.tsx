import { useEffect, useState } from "react";

/**
 * Loading with shape (#37): the skeleton is the content's own silhouette —
 * entry blocks where entries will render — so a load reads as "coming", not
 * as a blank screen with a word on it. A slow load says so, once it is
 * actually slow: under 1500ms the state stays quiet, because a normal load
 * never earns the excuse. The timer is presentation only — it decides
 * whether a sentence renders, never whether data is fetched.
 */
export function RouteLoading({
  variant = "cards",
  slowNote = "Still waiting on the daemon…",
}: {
  variant?: "cards" | "rows" | "panels";
  /** What a slow load says; `null` for a surface that already says where things stand (a hosted build has no daemon to name). */
  slowNote?: string | null;
}) {
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), 1500);
    return () => clearTimeout(timer);
  }, []);

  const blocks = variant === "cards" ? 3 : variant === "rows" ? 5 : 2;

  return (
    <div aria-busy="true" className="p-6" data-testid="route-loading">
      <div className="flex flex-col gap-3">
        {Array.from({ length: blocks }, (_, index) => (
          // The skeleton block wears the entry shape the real content will.
          <div key={index} className="shape-entry motion-skeleton p-4" data-testid="route-loading-block" />
        ))}
      </div>
      {slow && slowNote !== null && (
        <p className="mt-4 type-provenance text-[var(--muted)]" data-testid="route-loading-slow">
          {slowNote}
        </p>
      )}
    </div>
  );
}
