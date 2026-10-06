import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { requestNeverAnswerSuggestion, useSaveNeverAnswer } from "../api/queries.js";
import { MutationError } from "./MutationError.js";

type Step = "offer" | "loading" | "editing" | "saved";

/**
 * Drafts whose "shouldn't answer this" offer is open, this session. The tray
 * that records the dismissal leaves as soon as the draft stops waiting on
 * you, so the dismissed turn in the chat reads this to keep the offer in
 * front of the owner until they answer it. Session memory on purpose: an
 * offer is a follow-up to a tap just made, not a standing reminder.
 */
export const openNeverAnswerOffers = new Set<string>();

/**
 * #259 → #269: turning a "shouldn't answer this" dismissal into a standing
 * never-answer rule. One tap asks the daemon for starting words (the
 * dismissed question's own content words); the owner edits or approves them,
 * and only Save records anything — a rule is always in words the owner wrote
 * or approved, never one the duo made up on its own.
 *
 * `onSkip` clears the offer; without it (a dismissed turn in the chat, where
 * the offer is a quiet link) "No thanks" simply hides it here.
 */
export function NeverAnswerOffer({ api, draftId, onSkip }: { api: DuoApiConfig; draftId: string; onSkip?: () => void }) {
  const [step, setStep] = useState<Step>("offer");
  const [hidden, setHidden] = useState(false);
  const [subject, setSubject] = useState("");
  const [loadError, setLoadError] = useState<Error | null>(null);
  const save = useSaveNeverAnswer(api);

  if (hidden) {
    return null;
  }
  const skip = () => {
    openNeverAnswerOffers.delete(draftId);
    if (onSkip) {
      onSkip();
    } else {
      setHidden(true);
    }
  };
  const start = () => {
    setStep("loading");
    setLoadError(null);
    requestNeverAnswerSuggestion(api, draftId)
      .then((suggestion) => setSubject(suggestion.subject))
      .catch((error: Error) => {
        // No suggestion is no reason not to write one: the owner types it.
        setLoadError(error);
        setSubject("");
      })
      .finally(() => setStep("editing"));
  };
  const submit = () => {
    const words = subject.trim();
    if (words.length === 0 || save.isPending) {
      return;
    }
    save.mutate(
      { input: { subject: words } },
      {
        onSuccess: () => {
          openNeverAnswerOffers.delete(draftId);
          setStep("saved");
        },
      },
    );
  };

  if (step === "saved") {
    return (
      <span className="type-provenance text-[var(--muted)]" data-testid="never-answer-noted" role="status">
        Saved. Your duo will never answer about {subject.trim()} — it passes those to you. Change it in May do.
      </span>
    );
  }

  if (step === "editing" || step === "loading") {
    return (
      <form
        className="flex w-full flex-col gap-2"
        data-testid="never-answer-edit"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <label className="flex flex-col gap-1 type-provenance text-[var(--muted)]">
          I never answer about…
          <input
            autoFocus
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2 type-body text-[var(--text)]"
            data-testid="never-answer-subject"
            disabled={step === "loading"}
            onChange={(e) => setSubject(e.target.value)}
            placeholder={step === "loading" ? "Finding the words…" : "budget approvals"}
            value={subject}
          />
        </label>
        {loadError && <span className="type-provenance text-[var(--faint)]">Couldn&apos;t suggest words for this one — write your own.</span>}
        <div className="flex flex-wrap gap-2">
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
            data-testid="never-answer-save"
            disabled={step === "loading" || subject.trim().length === 0 || save.isPending}
            type="submit"
          >
            {save.isPending ? "Saving…" : "Save rule"}
          </button>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
            data-testid="never-answer-skip"
            onClick={skip}
            type="button"
          >
            No thanks
          </button>
        </div>
        <MutationError error={save.error} />
      </form>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-2" data-testid="never-answer-offer">
      <span className="type-provenance text-[var(--muted)]">Add a never-answer rule for this?</span>
      <button
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
        data-testid="never-answer-confirm"
        onClick={start}
        type="button"
      >
        Add rule
      </button>
      <button
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
        data-testid="never-answer-skip"
        onClick={skip}
        type="button"
      >
        No thanks
      </button>
    </div>
  );
}
