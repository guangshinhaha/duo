import type { DuoAnswerReading, DuoTrust } from "../workspace/duoAnswer.js";

/**
 * #67: what a colleague reads under somebody's duo's words — why it said
 * what it said, how far it is trusted, and where a passed-on question
 * stands. It renders inside `RoomDuoMessage`'s subtree (the duo-authored
 * boundary), takes only a reading of the daemon's composed words and the
 * owner's label derived from the duo's user id, and knows nothing about
 * where either came from.
 *
 * Three rules shape it:
 *
 * - Provenance is on the answer, not behind it (§1.5: "why did it say that
 *   … should cost zero clicks"). It shows exactly what the words carried —
 *   the sources the daemon named, the evidence's age — and offers nothing
 *   further, because the evidence itself stays on the owner's machine
 *   (org-read §5): an asker's rail is honest by being short, and a control
 *   that promised more would promise what the client cannot fetch.
 * - Trust is words. The reading carries no number and this component has
 *   none to show; each state has its own sentence, so the difference never
 *   rests on colour alone. The hairline beside it is the owner's hairline
 *   idiom, an aid, not the message.
 * - The daemon's fixed outcomes are contract: the passed-on and refusal
 *   messages render byte for byte in one element of their own, and the
 *   framing beside them — "outside what it answers on its own", "a boundary
 *   {owner} set" — is the client's, added around them, never in place of
 *   them. A refusal is the system working: no alert semantics, no retry, no
 *   error vocabulary.
 */

/** A hairline per state — the same colour tokens the owner's confidence hairline draws from. */
const HAIRLINE: Record<DuoTrust | "outside" | "boundary", string> = {
  confident: "border-[var(--confident)]",
  hedging: "border-[var(--escalate)]",
  outside: "border-[var(--escalate)]",
  boundary: "border-[var(--refused)]",
};

function TrustLine({ state, children }: { state: DuoTrust | "outside" | "boundary"; children: string }) {
  return (
    <p
      className={`border-l-2 pl-2 type-provenance text-[var(--muted)] ${HAIRLINE[state]}`}
      data-testid="duo-trust"
      data-trust={state}
    >
      {children}
    </p>
  );
}

/** The state of a question the duo passed on: waiting on a person, or answered by them. */
function EscalationLine({ state, ownerLabel }: { state: "waiting" | "followed-up"; ownerLabel: string }) {
  return (
    <p className="type-provenance text-[var(--muted)]" data-state={state} data-testid="duo-escalation">
      {state === "waiting"
        ? `Waiting on ${ownerLabel} — a person will answer this, not the duo.`
        : `${ownerLabel} has replied since — their answer is in this conversation.`}
    </p>
  );
}

export function RoomDuoAnswer({
  reading,
  ownerLabel,
  escalation,
}: {
  reading: DuoAnswerReading;
  ownerLabel: string;
  /** Where a passed-on question stands — only ever passed for a passed-on message. */
  escalation: "waiting" | "followed-up" | null;
}) {
  if (reading.kind === "refused") {
    return (
      <div className="flex flex-col gap-2">
        <p className="whitespace-pre-line" data-testid="duo-verbatim">
          {reading.body}
        </p>
        <TrustLine state="boundary">
          {`A boundary ${ownerLabel} set — this duo doesn't speak for ${ownerLabel} on this subject. That is the system working as designed, not a fault.`}
        </TrustLine>
      </div>
    );
  }
  if (reading.kind === "passed-on") {
    return (
      <div className="flex flex-col gap-2">
        <p className="whitespace-pre-line" data-testid="duo-verbatim">
          {reading.body}
        </p>
        <TrustLine state="outside">{`Outside what this duo answers on its own — it passed your question to ${ownerLabel}.`}</TrustLine>
        {escalation !== null && <EscalationLine ownerLabel={ownerLabel} state={escalation} />}
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="whitespace-pre-line">{reading.answer}</p>
      <div className="type-provenance text-[var(--muted)]" data-testid="duo-provenance">
        <p className="uppercase text-[var(--faint)]">What it drew on</p>
        {reading.sources.length === 0 ? (
          <p>It named no sources for this.</p>
        ) : (
          <ul className="mt-1 space-y-1">
            {reading.sources.map((source, index) => (
              <li data-source-kind={source.kind} data-testid="duo-source" key={index}>
                {source.label} —{" "}
                {source.kind === "standing-order" ? `${ownerLabel}'s own standing order` : `a past exchange, not ${ownerLabel} speaking now`}
              </li>
            ))}
          </ul>
        )}
        <p className="mt-1" data-testid="duo-evidence">
          {reading.evidence}
        </p>
      </div>
      <TrustLine state={reading.trust}>
        {reading.trust === "confident"
          ? `Confident — ${ownerLabel} has trusted this duo with this topic, and it's sure of this answer.`
          : `Hedging — ${ownerLabel} has trusted this duo with this topic, but it's less sure of this answer. Treat it as a starting point.`}
      </TrustLine>
      <p className="type-provenance text-[var(--faint)]">{reading.attribution}</p>
    </div>
  );
}
