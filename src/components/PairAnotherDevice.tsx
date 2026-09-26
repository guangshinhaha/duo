import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { usePairDevice } from "../api/queries.js";
import { CopyableSecret } from "./CopyableSecret.js";
import { MutationError } from "./MutationError.js";

/**
 * Pairing another device from one already paired (`POST /devices`) — for a
 * hosted duo there is no terminal to run `duo pair new` at, so this is the
 * way a phone joins a laptop. The daemon answers the token exactly once:
 * it is shown here with the address to paste beside it, then never again.
 */
export function PairAnotherDevice({ api }: { api: DuoApiConfig }) {
  const [name, setName] = useState("");
  const pair = usePairDevice(api);
  const minted = pair.data;

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-pair-device">
      <h2 className="type-heading">Pair another device</h2>
      <p className="type-provenance text-[var(--muted)]">
        Name the device, then open this app on it and paste the address and token below into Pair a duo. The token is shown once.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed && !pair.isPending) {
            pair.mutate({ name: trimmed }, { onSuccess: () => setName("") });
          }
        }}
      >
        <label className="flex flex-col gap-1 type-body">
          Device name
          <input
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
            onChange={(e) => setName(e.target.value)}
            placeholder="my phone"
            value={name}
          />
        </label>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
          disabled={pair.isPending || name.trim().length === 0}
          type="submit"
        >
          {pair.isPending ? "Pairing…" : "Pair device"}
        </button>
      </form>
      {minted && (
        <div className="flex flex-col gap-2" data-testid="pair-device-result">
          <p className="type-body">{minted.name} is paired. Paste these on that device — the token won&apos;t be shown again.</p>
          <CopyableSecret label="Address" testId="pair-device-address" value={api.baseUrl} />
          <CopyableSecret label="Token" testId="pair-device-token" value={minted.token} />
        </div>
      )}
      <MutationError error={pair.error} />
    </section>
  );
}
