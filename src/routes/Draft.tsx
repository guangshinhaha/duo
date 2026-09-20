import { useEffect, useRef } from "react";
import { ApiRequestError, type DuoApiConfig } from "../api/client.js";
import { useDraft } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { DraftCard } from "../components/DraftCard.js";
import { MutationError } from "../components/MutationError.js";

/**
 * One draft on its own (#25): `#draft/:id`, the address a notification
 * opens and a link points at. Renders the same DraftCard the queue does —
 * provenance, sources, disposition controls — fed by `GET /drafts/:id`
 * rather than the list. An id this daemon does not know (never existed,
 * or lives on another duo) is a 404 the page says plainly, with the way
 * back to Review.
 */
export function Draft({ api, draftId }: { api: DuoApiConfig; draftId: string }) {
  const draft = useDraft(api, draftId);

  // Deciding on this page returns to the queue — the draft is dealt with
  // and Review is what's next. But an ALREADY-decided draft linked
  // directly must stay: opening is not deciding, so only a null→set
  // transition on a draft already rendered navigates — never the state a
  // draft first arrives in (hence `seenData`: the first successful read
  // establishes the baseline instead of counting as a change).
  const prevOutcome = useRef<DraftRecord["outcome"]>(null);
  const seenData = useRef(false);
  useEffect(() => {
    if (!draft.data) {
      return;
    }
    const before = prevOutcome.current;
    const firstRead = !seenData.current;
    seenData.current = true;
    prevOutcome.current = draft.data.outcome;
    if (!firstRead && before === null && draft.data.outcome != null) {
      window.location.hash = "#review";
    }
  }, [draft.data]);

  if (draft.isPending) {
    return <div className="p-6 text-[var(--muted)]">Opening the draft…</div>;
  }
  if (draft.isError) {
    // A 404 is the honest "not here" — the daemon was asked and does not
    // know this id. Anything else (the daemon unreachable, a 500) is an
    // error the page reports as one, both with the way back.
    const notOnThisDuo = draft.error instanceof ApiRequestError && draft.error.status === 404;
    return (
      <div className="flex flex-col items-start gap-3 p-6" data-testid={notOnThisDuo ? "draft-not-found" : "draft-error"}>
        {notOnThisDuo ? (
          <p className="text-sm">This draft is not on this duo.</p>
        ) : (
          <MutationError error={draft.error} />
        )}
        <a className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 text-sm" href="#review">
          Back to Review
        </a>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-4 p-6" data-testid="draft-page">
      <DraftCard api={api} draft={draft.data} />
    </div>
  );
}
