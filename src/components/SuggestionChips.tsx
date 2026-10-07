import { useEffect, useRef, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useCreateDraftStream, useFollowUpSuggestions, useStarterSuggestions } from "../api/queries.js";
import type { FollowUpSuggestions } from "../api/types.js";
import { useSyncStatus } from "../sync.js";
import { readSuggestionChipsEnabled } from "../suggestionsPrefs.js";

/**
 * duo#305: "suggested questions and follow-ups". One small mechanism, two
 * call sites in `Duo.tsx` below — `StarterChips` for an empty chat (AC1)
 * and `FollowUpChips` for after an answer (AC2) — both asking through the
 * exact mutation `Composer.tsx` itself calls (`useCreateDraftStream`), so a
 * tapped chip streams in behind the hairline exactly like a typed question
 * (duo#304): the same `onAsk`/`onChunk`/`onAskFailed` triple `Duo.tsx`
 * already threads into `Composer` is threaded into these, and `Duo`'s own
 * effect clears the live bubble into the real `Turn` the same way either
 * way. AC3 ("chips can be turned off") is `suggestionsPrefs.ts`'s one
 * switch, read fresh on each mount — re-checked here rather than hoisted
 * into `Duo.tsx`, so a change in Settings takes effect on the next render
 * without this chat needing to know the setting exists.
 */

/** Same defensive shape-check `DailyBriefCard.tsx`'s `isDailyBrief` applies — a response that isn't really this shape (a stale cache entry, a test fixture stubbing every route with something else) reads as "nothing to show yet" rather than a render crash. */
function starterList(value: unknown): readonly string[] {
  const starters = (value as { starters?: unknown } | undefined)?.starters;
  return Array.isArray(starters) ? starters.filter((item): item is string => typeof item === "string") : [];
}

function followUpList(value: unknown): readonly string[] {
  const followUps = (value as { followUps?: unknown } | undefined)?.followUps;
  return Array.isArray(followUps) ? followUps.filter((item): item is string => typeof item === "string") : [];
}

function Chip({ children, disabled, onClick }: { children: string; disabled: boolean; onClick: () => void }) {
  return (
    <button
      className="inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--edge)] px-3 type-provenance text-[var(--muted)] disabled:opacity-40"
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {children}
    </button>
  );
}

function useAskChip(api: DuoApiConfig, onAsk: (question: string) => void, onChunk: (text: string) => void, onAskFailed: () => void) {
  const { mutation: createDraft } = useCreateDraftStream(api);
  const { reachable } = useSyncStatus();
  const ask = (question: string) => {
    if (createDraft.isPending || !reachable) {
      return;
    }
    onAsk(question);
    createDraft.mutate(
      { question, threadContext: null, onChunk },
      { onError: (error) => {
          const aborted = error instanceof DOMException && error.name === "AbortError";
          if (!aborted) {
            onAskFailed();
          }
        },
      },
    );
  };
  return { ask, disabled: createDraft.isPending || !reachable };
}

/**
 * AC1: "Empty Your duo shows relevant starters" — `GET /suggestions/starters`
 * (coverage gaps plus recent activity, composed daemon-side) rendered as
 * chips. Tapping one asks it exactly as if typed.
 */
export function StarterChips({
  api,
  onAsk,
  onChunk,
  onAskFailed,
}: {
  api: DuoApiConfig;
  onAsk: (question: string) => void;
  onChunk: (text: string) => void;
  onAskFailed: () => void;
}) {
  const starters = useStarterSuggestions(api);
  const { ask, disabled } = useAskChip(api, onAsk, onChunk, onAskFailed);
  const list = starterList(starters.data);
  if (!readSuggestionChipsEnabled() || list.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2 p-6" data-testid="starter-chips">
      {list.map((starter) => (
        <Chip disabled={disabled} key={starter} onClick={() => ask(starter)}>
          {starter}
        </Chip>
      ))}
    </div>
  );
}

/**
 * AC2: "Each answer offers up to 3 follow-ups" — fired once per newly
 * settled turn (`questionKey`, the draft id: a fresh id means a fresh
 * answer, which is when `POST /suggestions/follow-ups` is asked, never
 * retroactively for the rest of the history on every mount/scroll). A
 * provider-less daemon or a genuinely empty suggestion both render
 * nothing, same as the route's own "no error state" design.
 */
export function FollowUpChips({
  api,
  questionKey,
  question,
  answer,
  onAsk,
  onChunk,
  onAskFailed,
}: {
  api: DuoApiConfig;
  questionKey: string;
  question: string;
  answer: string;
  onAsk: (question: string) => void;
  onChunk: (text: string) => void;
  onAskFailed: () => void;
}) {
  const followUps = useFollowUpSuggestions(api);
  const { ask, disabled } = useAskChip(api, onAsk, onChunk, onAskFailed);
  // Same requested-batch-key guard as CatchUpCard.tsx's own effect: fetched
  // once per `questionKey` (the settled draft's own id), never re-fired by
  // an unrelated re-render, and never re-fired for the rest of the history
  // on a later mount of this same turn.
  const [result, setResult] = useState<FollowUpSuggestions | undefined>(undefined);
  const requestedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!readSuggestionChipsEnabled() || requestedFor.current === questionKey) {
      return;
    }
    requestedFor.current = questionKey;
    followUps.mutate(
      { question, answer },
      { onSuccess: (data) => setResult(data), onError: () => setResult({ followUps: [] }) },
    );
    // `question`/`answer`/`followUps` are fresh closures every render;
    // `questionKey` alone (guarded by `requestedFor`) decides whether a
    // new request is due — same precedent as CatchUpCard.tsx's own effect.
  }, [questionKey]);

  const list = followUpList(result);
  if (!readSuggestionChipsEnabled() || list.length === 0) {
    return null;
  }
  return (
    <div className="flex flex-wrap gap-2" data-testid="follow-up-chips" key={questionKey}>
      {list.map((followUp) => (
        <Chip disabled={disabled} key={followUp} onClick={() => ask(followUp)}>
          {followUp}
        </Chip>
      ))}
    </div>
  );
}
