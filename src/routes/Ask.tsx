import { useEffect, useRef, useState, type FormEvent } from "react";
import { askQuestion, isAskLinkUsable, parseAskLink, type AskLinkConfig } from "../api/ask.js";
import type { PublicAnswerOutcome } from "../api/types.js";

/**
 * The answer half of an answered outcome — a duo-attributed container, but
 * *not* `<DuoMessage>`: that component's attribution is hardcoded "Your
 * duo" because every other surface in this app is the owner's, and the
 * person reading this page is a colleague, not the owner. Same visual
 * language (AR-13: generated text is always labelled as the duo's, never
 * poses as the owner), different addressee.
 *
 * The text renders verbatim, and *only* the text: the daemon composes the
 * full public post — answer, sources, attribution line, confidence, and
 * evidence age — into that one string before returning it (#44 AC1), and
 * the asker projection carries nothing structured beyond `sources` (for
 * callers that want them machine-read). Duplicating any of it under the
 * text it is already woven into would be noise, not transparency — and
 * there is no hairline or age line here for the same reason: those fields
 * reach only a *device* principal (digital-duo #159 R8), so this page
 * couldn't draw them even if it wanted to.
 */
function AnsweredAnswer({ outcome }: { outcome: Extract<PublicAnswerOutcome, { kind: "answered" }> }) {
  return (
    <div
      data-testid="duo-answer"
      className="shape-entry-quiet flex flex-col gap-2 px-4 py-3"
    >
      <div className="type-provenance text-[var(--muted)]" data-testid="duo-answer-attribution">
        the owner&#39;s duo
      </div>
      <p className="whitespace-pre-wrap text-[var(--text)]">{outcome.text}</p>
    </div>
  );
}

function Outcome({ outcome }: { outcome: PublicAnswerOutcome }) {
  if (outcome.kind === "answered") {
    return <AnsweredAnswer outcome={outcome} />;
  }
  // Both non-answer variants render the daemon's fixed string verbatim —
  // `PUBLIC_PASSED_ON_MESSAGE` / `PUBLIC_REFUSAL_MESSAGE` are deliberately
  // indistinct by underlying reason (#43 AC3), and a friendlier paraphrase
  // here would reintroduce exactly the signal those fixed strings remove.
  // (`ownerNotice` is not suppressed here — it never reaches an ask token
  // at all; the daemon projects it away, R8.)
  if (outcome.kind === "passed_on") {
    return (
      <p data-testid="ask-passed-on" className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-4 py-3 text-[var(--muted)]">
        {outcome.text}
      </p>
    );
  }
  return (
    <p data-testid="ask-declined" className="rounded-[var(--r-md)] bg-[var(--surface-2)] px-4 py-3 text-[var(--refused)]">
      {outcome.text}
    </p>
  );
}

/**
 * The state a link with nothing to ask from gets: a heading and one honest
 * sentence, and nothing else. Shared by the no-connection-details case and
 * the dead-link case (#2's acceptance criterion: an expired or revoked
 * link "says so plainly, with no question box shown") — the wording is
 * each case's own; what they share is that neither offers a question box.
 */
function LinkRefusalState({ testId, title, children }: { testId: string; title: string; children: string }) {
  return (
    <main
      className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center gap-2 p-6"
      data-testid={testId}
    >
      <h1 className="type-heading">{title}</h1>
      <p className="text-[var(--muted)]">{children}</p>
    </main>
  );
}

/** A page-load link check's result — see `isAskLinkUsable` for what each value means. */
type LinkStatus = "checking" | "ready" | "dead";

/**
 * The no-install asker page (duo #1/#2, against digital-duo #158/#159):
 * a colleague opens the link the owner shares — `ask.html#host=…&token=…`
 * — types a question, and gets one of three outcomes back. Nothing else:
 * no draft list, no mirror, no owner surface of any kind; the ask token
 * authorizes exactly one route (`POST /ask`) and this page exposes exactly
 * that one behaviour.
 */
export function Ask() {
  const [config] = useState<AskLinkConfig | null>(() => parseAskLink(window.location.hash));
  const [linkStatus, setLinkStatus] = useState<LinkStatus>(config === null ? "dead" : "checking");
  const [question, setQuestion] = useState("");
  const [outcome, setOutcome] = useState<PublicAnswerOutcome | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // The probe promise lives in a ref so React 19 StrictMode's dev-only
  // mount-cleanup-mount cycle shares one POST instead of firing two: the
  // real daemon's auth hook counts failures per IP (10/60s), and a dead
  // link opened in `npm run dev` must not burn the limit twice as fast.
  const probeRef = useRef<Promise<boolean> | null>(null);

  useEffect(() => {
    // A link with connection details is checked once, on load, with a
    // zero-question probe — a dead link (expired or revoked) fails here,
    // before the asker types anything. `config` is captured once, from the
    // hash this page was opened with; a mid-session hash edit is not a
    // re-open and deliberately does not re-check.
    if (config === null) {
      return;
    }
    probeRef.current ??= isAskLinkUsable(config);
    let cancelled = false;
    void probeRef.current.then((usable) => {
      if (!cancelled) {
        setLinkStatus(usable ? "ready" : "dead");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [config]);

  if (config === null) {
    return (
      <LinkRefusalState testId="ask-missing-link" title="Ask the duo">
        This link has no connection details in it. Ask the owner for a fresh ask link.
      </LinkRefusalState>
    );
  }

  if (linkStatus === "dead") {
    // The daemon's kind-blind 401 — unknown, expired, and revoked are
    // indistinguishable by design (digital-duo #159 R1) — so this says
    // exactly as much as the daemon does, and no more.
    return (
      <LinkRefusalState testId="ask-dead-link" title="Ask the duo">
        This link is no longer valid — it has expired or been revoked. Ask the owner for a fresh ask link.
      </LinkRefusalState>
    );
  }

  if (linkStatus === "checking") {
    return (
      <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col justify-center p-6" data-testid="ask-checking">
        <p className="text-[var(--muted)]">Checking this link…</p>
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
      // The daemon's own message verbatim — a link revoked between the
      // page-load probe and this submit, for instance, arrives as
      // `{error:{code,message}}` with wording the owner's daemon chose;
      // this page has nothing truer to say.
      setError(err instanceof Error ? err.message : "Something went wrong reaching the duo.");
    } finally {
      setPending(false);
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-xl flex-col gap-4 p-6" data-testid="ask">
      <header className="flex flex-col gap-1">
        <h1 className="type-heading">Ask the duo</h1>
        <p className="type-provenance text-[var(--muted)]">
          One question at a time — the duo answers from what it has been taught, or passes your question to the owner.
        </p>
      </header>

      <form className="flex flex-col gap-2" onSubmit={onSubmit}>
        <textarea
          data-testid="ask-question"
          className="rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 py-2 text-[var(--text)]"
          rows={3}
          placeholder="What do you want to ask?"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
        />
        <button
          type="submit"
          data-testid="ask-submit"
          className="self-end rounded-[var(--r-sm)] bg-[var(--accent)] px-4 py-1 text-[var(--bg)] disabled:opacity-50"
          disabled={pending || question.trim() === ""}
        >
          {pending ? "Asking…" : "Ask"}
        </button>
      </form>

      {error && (
        <div data-testid="ask-error" className="text-[var(--refused)]">
          {error}
        </div>
      )}
      {outcome && <Outcome outcome={outcome} />}
    </main>
  );
}
