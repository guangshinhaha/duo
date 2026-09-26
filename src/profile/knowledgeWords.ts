import type { DuoKnowledge } from "../api/types.js";

function formatDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : "—";
}

/**
 * #37: the import and corpus sentences, built once. Review's empty state
 * makes the same argument this screen makes, and it must make it with the
 * same words — both screens render the daemon's counts through these, so
 * the argument can only drift if the sentence itself does, in one place.
 */
export function lastImportSentence(lastImport: DuoKnowledge["lastImport"]): string {
  return lastImport
    ? `Last import ${formatDate(lastImport.runAt)}: ${lastImport.written} new, ${lastImport.alreadyPresent} already there, ${lastImport.skippedDmConversations} direct-message conversations left out.`
    : "No import yet — importing your history is what gives the duo something to answer from.";
}

/**
 * The corpus verdict in words (#37 shares it with Review's empty state):
 * thin in the portrait's own terms — the bar and what clears it — and past
 * the bar, the count with the action the facts support. No percentage, no
 * invented numeral (§1.6).
 */
export function corpusSentence(corpus: DuoKnowledge["corpus"]): string {
  if (corpus.tooThin) {
    return `Not enough history yet — your duo starts to get a picture of you at ${corpus.minimumQuestionsToCharacterize} questions, and it has ${corpus.totalQuestions}. Importing more of your messages is what thickens it.`;
  }
  return `${corpus.totalQuestions} question${corpus.totalQuestions === 1 ? "" : "s"} so far — asking it questions is what thickens it.`;
}

/**
 * The cached payload is typed as `DuoKnowledge`, but the cache is a
 * storage layer, not a promise — it can hold a shape the daemon never
 * sent (an array where the object should be, say, written under the same
 * CACHE_BUSTER by an older build). A payload that is not the daemon's
 * documented shape is not an answer, and the screen must read it as
 * "still asking", never crash on it — the same braces-and-belt law App.tsx
 * states for the persisted cache as a whole.
 */
export function isDuoKnowledgeShape(value: unknown): value is DuoKnowledge {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const candidate = value as DuoKnowledge;
  return [candidate.records, candidate.corpus, candidate.rules, candidate.providers, candidate.sharedUsage].every(
    (section) => section !== null && typeof section === "object",
  );
}
