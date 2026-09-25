import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { normalizeBaseUrl } from "../routes/Setup.js";

/**
 * #62: the pairing form, in one place so the two doors that offer it cannot
 * drift — Setup's secondary card (the front door) and the member shell's
 * "Pair your duo" dialog (the offer an unpaired member sees). Validation
 * and wording are #11/#12's, moved not rewritten: `normalizeBaseUrl` is the
 * one validator, the token is trimmed on submit, and the error testid
 * (`setup-error`) is the one Setup's tests read.
 */
export function PairDuoForm({ onConnect }: { onConnect: (config: DuoApiConfig) => void }) {
  const [baseUrlInput, setBaseUrlInput] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const normalized = normalizeBaseUrl(baseUrlInput);
        if (!normalized) {
          setError(`"${baseUrlInput}" doesn't look like a valid address — try something like 100.64.1.5:7717`);
          return;
        }
        // Trimmed, unlike baseUrl was before this line existed to fix
        // exactly this: a token copy-pasted from a terminal commonly
        // picks up a trailing newline or space, which then silently
        // fails every request's Authorization header with no indication
        // whitespace was the cause. Checked here too, not just in the
        // button's `disabled` below — a whitespace-only paste makes
        // `token` a non-empty string, so `disabled={!token}` alone
        // would let the form submit with an empty trimmed token.
        const trimmedToken = token.trim();
        if (!trimmedToken) {
          setError("Paste the token `duo pair new` printed — it looks empty.");
          return;
        }
        setError(null);
        onConnect({ baseUrl: normalized, token: trimmedToken });
      }}
    >
      <label className="flex flex-col gap-1 type-body">
        Daemon address
        <input
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
          placeholder="100.64.1.5:7717"
          value={baseUrlInput}
          onChange={(e) => {
            setBaseUrlInput(e.target.value);
            setError(null);
          }}
        />
      </label>
      <label className="flex flex-col gap-1 type-body">
        Token
        <input
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
          value={token}
          onChange={(e) => setToken(e.target.value)}
        />
      </label>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="setup-error">
          {error}
        </p>
      )}
      <button
        className="mt-2 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
        type="submit"
        disabled={!token.trim() || !baseUrlInput}
      >
        Connect
      </button>
    </form>
  );
}
