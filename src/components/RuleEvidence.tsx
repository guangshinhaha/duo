import type { DuoApiConfig } from "../api/client.js";
import { useMirrorRule } from "../api/queries.js";
import type { Rule, RuleEvidenceExchange } from "../api/types.js";
import { OwnerMessage } from "./OwnerMessage.js";

function Exchange({ exchange }: { exchange: RuleEvidenceExchange }) {
  // The daemon resolves a citation whose record has since gone to null text
  // rather than failing the rule — say so, so a missing exchange is never
  // mistaken for a rule that cites less than it does.
  if (exchange.questionText === null && exchange.answerText === null) {
    return (
      <div className="type-provenance text-[var(--faint)]" data-testid="rule-evidence-exchange">
        This exchange is no longer in the record.
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-1" data-testid="rule-evidence-exchange">
      {/* Not `OwnerMessage`: the question was asked *of* the owner, not by
          them — AR-13's identity split cuts both ways (same as Audit). */}
      <div>
        <div className="type-provenance text-[var(--muted)]">Asked</div>
        <div className="type-body whitespace-pre-wrap" data-testid="rule-evidence-question">
          {exchange.questionText ?? "(question no longer in the record)"}
        </div>
      </div>
      {exchange.answerText === null ? (
        <div className="type-provenance text-[var(--faint)]">Your answer is no longer in the record.</div>
      ) : (
        // The answer is the owner's own past words — the thing the rule was
        // derived from — so it carries the owner's label, never the duo's.
        <OwnerMessage>
          <span className="whitespace-pre-wrap" data-testid="rule-evidence-answer">
            {exchange.answerText}
          </span>
        </OwnerMessage>
      )}
    </div>
  );
}

/**
 * The records behind one rule — "why did it say that", the Mirror's core
 * promise (#53). Opened on demand from `RuleCard`; a read of
 * `GET /mirror/rules/:id` and nothing else. Read-only by construction: no
 * input, no write hook — evidence is cited, never edited (AR-18).
 */
export function RuleEvidence({ api, rule }: { api: DuoApiConfig; rule: Rule }) {
  const detail = useMirrorRule(api, rule.id, true);

  if (detail.isLoading) {
    return <div className="type-provenance text-[var(--muted)]">Loading evidence…</div>;
  }
  if (detail.error) {
    return (
      <div className="type-provenance text-[var(--refused)]" data-testid="rule-evidence-error">
        {(detail.error as Error).message}
      </div>
    );
  }
  if (!detail.data) {
    return null;
  }

  const { evidence } = detail.data;
  return (
    <div className="flex flex-col gap-3 border-l border-[var(--edge)] pl-3" data-testid="rule-evidence">
      {evidence.length === 0 ? (
        <p className="type-provenance text-[var(--muted)]" data-testid="rule-evidence-none">
          {detail.data.rule.origin === "owner_asserted"
            ? "You asserted this rule. No supporting exchanges are cited — it stands on your word, not on your history."
            : "No supporting exchanges are cited for this rule."}
        </p>
      ) : (
        <>
          <p className="type-provenance text-[var(--muted)]">
            Cites {evidence.length} exchange{evidence.length === 1 ? "" : "s"}
          </p>
          {evidence.map((exchange) => (
            <Exchange key={exchange.qaPairId} exchange={exchange} />
          ))}
        </>
      )}
    </div>
  );
}
