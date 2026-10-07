import { useEffect, useState, type FormEvent } from "react";
import type { WorkspaceConnection } from "../workspace/matrix.js";

/**
 * #310: the owner's own standing keyword alerts — words that notify
 * regardless of a room's mute or mentions-only mode ("I catch topics I
 * own"). The list lives on the homeserver as this account's own content
 * push rules (`workspace/matrix.ts`'s `keywordAlerts`/`addKeywordAlert`/
 * `removeKeywordAlert`), so it — and what it alerts on — is the same on
 * every device signed into this account, the same "server push rules"
 * story a room's own notification mode already tells. Read fresh on
 * mount, the same `connection.profile()`-style load `WorkspaceProfile`
 * takes, rather than cached past that: this screen is the one place a
 * member goes to check exactly what's set, so nothing here should be
 * allowed to drift stale.
 */
export function KeywordAlerts({ connection }: { connection: WorkspaceConnection }) {
  const [keywords, setKeywords] = useState<readonly string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const [removingKeyword, setRemovingKeyword] = useState<string | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = (): void => {
    if (!connection.keywordAlerts) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setLoadError(null);
    connection
      .keywordAlerts()
      .then(setKeywords)
      .catch((error: unknown) => {
        setLoadError(error instanceof Error ? error.message : "Couldn't load your keyword alerts.");
      })
      .finally(() => setLoading(false));
  };

  // Fresh per mount, same reasoning as `WorkspaceProfile`'s own load.
  useEffect(load, [connection]);

  const add = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = draft.trim();
    if (trimmed === "" || adding || !connection.addKeywordAlert) {
      return;
    }
    // A keyword already on the list, retyped, is a no-op the homeserver
    // already treats as idempotent — no need to refuse it here too.
    setAdding(true);
    setAddError(null);
    connection
      .addKeywordAlert(trimmed)
      .then(() => {
        setDraft("");
        load();
      })
      .catch((error: unknown) => {
        setAddError(error instanceof Error ? error.message : "Couldn't add that keyword.");
      })
      .finally(() => setAdding(false));
  };

  const remove = (keyword: string): void => {
    if (removingKeyword !== null || !connection.removeKeywordAlert) {
      return;
    }
    setRemovingKeyword(keyword);
    setRemoveError(null);
    connection
      .removeKeywordAlert(keyword)
      .then(() => {
        setKeywords((current) => current.filter((entry) => entry !== keyword));
      })
      .catch((error: unknown) => {
        setRemoveError(error instanceof Error ? error.message : "Couldn't remove that keyword.");
      })
      .finally(() => setRemovingKeyword(null));
  };

  return (
    <div className="flex flex-col gap-3" data-testid="keyword-alerts">
      <p className="type-provenance text-[var(--muted)]">
        A word that always notifies you, even in a muted conversation or one set to mentions only.
      </p>
      <form className="flex flex-wrap items-center gap-2" onSubmit={add}>
        <label className="sr-only" htmlFor="keyword-alert-input">
          Add a keyword
        </label>
        <input
          className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 text-[var(--text)]"
          data-testid="keyword-alert-input"
          id="keyword-alert-input"
          onChange={(e) => setDraft(e.target.value)}
          placeholder="e.g. launch"
          type="text"
          value={draft}
        />
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)] disabled:opacity-50"
          data-testid="keyword-alert-add"
          disabled={draft.trim() === "" || adding}
          type="submit"
        >
          {adding ? "Adding…" : "Add"}
        </button>
      </form>
      {addError && (
        <p className="type-provenance text-[var(--refused)]" role="alert">
          {addError}
        </p>
      )}
      {loading ? (
        <p className="type-provenance text-[var(--muted)]">Loading…</p>
      ) : loadError ? (
        <p className="type-provenance text-[var(--refused)]" role="alert">
          {loadError}
        </p>
      ) : keywords.length === 0 ? (
        <p className="type-provenance text-[var(--muted)]" data-testid="keyword-alerts-empty">
          No keyword alerts yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="keyword-alerts-list">
          {keywords.map((keyword) => (
            <li className="flex min-h-11 items-center justify-between gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] px-3" key={keyword}>
              <span className="type-body text-[var(--text)]">{keyword}</span>
              <button
                className="inline-flex min-h-11 items-center justify-center text-[var(--muted)] disabled:opacity-50"
                data-testid={`keyword-alert-remove-${keyword}`}
                disabled={removingKeyword !== null}
                onClick={() => remove(keyword)}
                type="button"
              >
                {removingKeyword === keyword ? "Removing…" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {removeError && (
        <p className="type-provenance text-[var(--refused)]" role="alert">
          {removeError}
        </p>
      )}
    </div>
  );
}
