import { useState, type FormEvent } from "react";
import { askQuestion, parseAskLink, type AskLinkConfig } from "../api/ask.js";
import type { PublicAnswerOutcome } from "../api/types.js";
import { ConfidenceHairline } from "../components/ConfidenceHairline.js";

/**
 * The answer half of an answered outcome — a duo-attributed container, but
 * *not* `<DuoMessage>`: that component's attribution is hardcoded "Your
 * duo" because every other surface in this app is the owner's, and the
 * person reading this page is a colleague, not the owner. Same visual
 * language (AR-13: generated text is always labelled as the duo's, never
 * poses as the owner), different addressee.
 *
 * The text renders verbatim: the daemon composes the full public post —
 * answer, sources, attribution — before returning it (#44 AC1), so this
 * surface appends nothing and re-lists nothing; `sources` on the wire is
 * for callers that want it structured, and duplicating it under the text
 * it is already woven into would be noise, not transparency. The hairline
 * and the evidence-age line are what the text doesn't carry visually.
 */
function AnsweredAnswer({ outcome }: { outcome: Extract<PublicAnswerOutcome, { kind: "answered" }> }) {
  return (
    <div
      data-testid="duo-answer"
      className="flex flex-row gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] bg-[var(--surface-2)] px-4 py-3"
    >
      {/* #32: the hairline leads the answer card on its leading edge, same
          gutter rule as the owner's surfaces. */}
      <ConfidenceHairline
        result={{
          kind: "draft",
          draftId: outcome.draftId,
          text: outcome.text,
          sources: [...outcome.sources],
          confidence: outcome.confidence,
        }}
      />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="text-xs font-medium tracking-wide text-[var(--muted)]" data-testid="duo-answer-attribution">
          the owner&#39;s duo
        </div>
        <p className="whitespace-pre-wrap text-[var(--text)]">{outcome.text}</p>
        <p className="text-xs text-[var(--faint)]" data-testid="duo-answer-evidence-age">
          {outcome.evidenceAgeDays === null
            ? "freshest evidence: undated"
            : `freshest evidence: ${outcome.evidenceAgeDays} day${outcome.evidenceAgeDays === 1 ? "" : "s"} old`}
        </p>
      </div>
    </div>
  );
}

function Outcome({ outcome }: { outcome: PublicAnswerOutcome }) {
  if (outcome.kind === "answered") {
    return <AnsweredAnswer outcome={outcome} />;
  }
  // Both non-answer variants render the daemon's fixed message verbatim —
  // `PUBLIC_PASSED_ON_MESSAGE` / `PUBLIC_REFUSAL_MESSAGE` are deliberately
  // indistinct by underlying reason (#43 AC3), and a friendlier paraphrase
  // here would reintroduce exactly the signal those fixed strings remove.
  // `ownerNotice` is likewise never rendered: it is addressed to the owner
  // (#55), and this page is not the owner's.
  if (outcome.kind === "passed_on") {
    return (
      <p data-testid="ask-passed-on" className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-4 py-3 text-[var(--muted)]">
        {outcome.message}
      </p>
    );
  }
  return (
    <p data-testid="ask-declined" className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-4 py-3 text-[var(--refused)]">
      {outcome.message}
    </p>
  );
}

/**
 * The no-install asker page (duo #1/#2, contract-first against digital-duo
 * #157/#159): a colleague opens the link the owner shares — `ask.html#host=…&token=…`
 * — types a question, and gets one of three outcomes back. Nothing else:
 * no draft list, no mirror, no owner surface of any kind; the ask token
 * authorizes exactly one route (`POST /ask`) and this page exposes exactly
 * that one behaviour.
 */
export function Ask() {
  const [config] = useState<AskLinkConfig | null>(() => parseAskLink(window.location.hash));
  const [question, setQuestion] = useState("");
  const [outcome, setOutcome] = useState<PublicAnswerOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  if (!config) {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-2 p-6" data-testid="ask-missing-link">
        <h1 className="text-base font-medium">Ask the duo</h1>
        <p className="text-sm text-[var(--muted)]">
          This link has no connection details in it. Ask the owner for a fresh ask link.
        </p>
      </main>
    );
  }

  // A const arrow (not a hoisted `function` declaration) so `config`'s
  // non-null narrowing above carries into it — the guard already returned.
  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (pending || question.trim() === "") {
      return;
    }
    setPending(true);
    setError(null);
    setOutcome(null);
    try {
      setOutcome(await askQuestion(config, question));
    } catch (err) {
      // The daemon's own message verbatim — an expired ask link, for
      // instance, arrives as `{error:{code,message}}` with wording the
      // owner's daemon chose; this page has nothing truer to say.
      setError(err instanceof Error ? err.message : "Something went wrong reaching the duo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-4 p-6" data-testid="ask">
      <header className="flex flex-col gap-1">
        <h1 className="text-base font-medium">Ask the duo</h1>
        <p className="text-xs text-[var(--muted)]">
          One question at a time — the duo answers from what it has been taught, or passes your question to the owner.
        </p>
      </header>

      <form className="flex flex-col gap-2" onSubmit={onSubmit}>
        <textarea
          data-testid="ask-question"
          className="rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface)] px-3 py-2 text-sm text-[var(--text)] outline-none focus:border-[var(--accent)]"
          rows={3}
          placeholder="What do you want to ask?"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          type="submit"
          data-testid="ask-submit"
          className="self-end rounded-[var(--r-sm)] bg-[var(--accent)] px-4 py-1.5 text-sm font-medium text-[var(--bg)] disabled:opacity-50"
          disabled={pending || question.trim() === ""}
        >
          {pending ? "Asking…" : "Ask"}
        </button>
      </form>

      {error && (
        <div data-testid="ask-error" className="text-sm text-[var(--refused)]">
          {error}
        </div>
      )}
      {outcome && <Outcome outcome={outcome} />}
    </main>
  );
}
