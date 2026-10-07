import { useState } from "react";
import type { ReactNode } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useDailyBrief, usePendingDrafts } from "../api/queries.js";
import type { DailyBriefHandledItem, DailyBriefPassedOnItem, DailyBriefWaitingItem, DraftRecord } from "../api/types.js";
import { conversationOf, roomHref } from "../workspace/drafts.js";
import { dailyBriefSince, isDailyBriefDue, markDailyBriefShown } from "../dailyBriefPrefs.js";

/** Same defensive shape-check `Away.tsx`'s `isAwayState` applies to `GET /away` — a response that isn't really a `DailyBrief` (a stale cache entry, a test fixture that stubs every route with something else) reads as "nothing to show yet" rather than a render crash. */
function isDailyBrief(value: unknown): value is {
  readonly waitingOnYou: readonly DailyBriefWaitingItem[];
  readonly passedOn: readonly DailyBriefPassedOnItem[];
  readonly handledByDuo: readonly DailyBriefHandledItem[];
  readonly allClear: boolean;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { waitingOnYou?: unknown }).waitingOnYou) &&
    Array.isArray((value as { passedOn?: unknown }).passedOn) &&
    Array.isArray((value as { handledByDuo?: unknown }).handledByDuo) &&
    typeof (value as { allClear?: unknown }).allClear === "boolean"
  );
}

/**
 * duo#282 (digital-duo#279): the daily brief — "what's waiting, what was
 * passed on, what your duo handled". The first card in Your duo (AC), the
 * same slot `ReturnSummaryCard` already occupies for #270's away summary,
 * styled the same way: a plain notice card, not a duo-authored message
 * (unlike `CatchUpCard`, nothing here is generated text — every line is a
 * fact a daemon module already recorded).
 *
 * Links: `waitingOnYou`/`passedOn` resolve to the conversation they
 * arrived in, the same way `RoomDrafts`/`useConversationLink` already do
 * (`conversationOf` on the matching pending draft's own provenance) — an
 * owner-asked question with nowhere else to go opens Your duo itself,
 * where it already renders as a turn. `handledByDuo` items link to the
 * Activity tab (`#duo/profile/activity`), the surface duo#267 already
 * built for "everything your duo said on your behalf".
 */

function ItemLink({ href, children }: { href: string | undefined; children: string }) {
  return href ? (
    <a className="rounded-[var(--r-sm)] type-provenance text-[var(--muted)] underline" href={href}>
      “{children}”
    </a>
  ) : (
    <span className="type-provenance text-[var(--muted)]">“{children}”</span>
  );
}

function pendingDraftHref(drafts: readonly DraftRecord[] | undefined, draftId: string): string | undefined {
  const draft = drafts?.find((candidate) => candidate.id === draftId);
  if (!draft) {
    return undefined;
  }
  const conversation = conversationOf(draft.provenance);
  if (conversation) {
    return roomHref(conversation.roomId);
  }
  return draft.provenance?.origin === "owner" ? "#duo" : undefined;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h3 className="type-heading">{title}</h3>
      <ul className="flex flex-col gap-1">{children}</ul>
    </div>
  );
}

export function DailyBriefCard({ api }: { api: DuoApiConfig }) {
  // Re-evaluated once per mount — Duo.tsx mounts fresh each visit to the
  // route, the same lifetime `isDailyBriefDue`'s "due today" check assumes.
  const [due] = useState(() => isDailyBriefDue());
  const [shown, setShown] = useState(due);
  const since = dailyBriefSince();
  const brief = useDailyBrief(shown ? api : null, since ?? undefined);
  const pending = usePendingDrafts(shown ? api : null);

  if (!shown || !isDailyBrief(brief.data)) {
    return null;
  }
  const data = brief.data;

  const dismiss = (): void => {
    markDailyBriefShown();
    setShown(false);
  };

  return (
    <section className="shape-container mb-5 flex flex-col gap-3 p-4" data-testid="daily-brief-card">
      <h2 className="type-heading">Your daily brief</h2>
      {data.allClear ? (
        <p className="type-provenance text-[var(--muted)]" data-testid="daily-brief-all-clear">
          All clear — nothing waiting, nothing passed on, nothing your duo had to handle.
        </p>
      ) : (
        <div className="flex flex-col gap-3">
          {data.waitingOnYou.length > 0 && (
            <Section title={`Waiting on you (${data.waitingOnYou.length})`}>
              {data.waitingOnYou.map((item: DailyBriefWaitingItem) => (
                <li data-testid="daily-brief-waiting-item" key={item.draftId}>
                  <ItemLink href={pendingDraftHref(pending.data, item.draftId)}>{item.question}</ItemLink>
                </li>
              ))}
            </Section>
          )}
          {data.passedOn.length > 0 && (
            <Section title={`Passed on (${data.passedOn.length})`}>
              {data.passedOn.map((item: DailyBriefPassedOnItem) => (
                <li data-testid="daily-brief-passed-on-item" key={item.draftId}>
                  <ItemLink href={pendingDraftHref(pending.data, item.draftId)}>{item.question}</ItemLink>
                </li>
              ))}
            </Section>
          )}
          {data.handledByDuo.length > 0 && (
            <Section title={`Handled by your duo (${data.handledByDuo.length})`}>
              {data.handledByDuo.map((item: DailyBriefHandledItem) => (
                <li data-testid="daily-brief-handled-item" key={item.id}>
                  <ItemLink href="#duo/profile/activity">{item.question}</ItemLink>
                </li>
              ))}
            </Section>
          )}
        </div>
      )}
      <button
        className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
        data-testid="daily-brief-dismiss"
        onClick={dismiss}
        type="button"
      >
        Done
      </button>
    </section>
  );
}
