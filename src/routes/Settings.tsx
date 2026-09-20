import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { normalizeBaseUrl } from "./Setup.js";

/** Masked to the last few characters — a paired token is a bearer credential, and a settings screen is exactly where screens get shared. */
function maskedToken(token: string): string {
  return `•••• ${token.slice(-4)}`;
}

/**
 * §3.1's `/settings` (daemon address, device name, unpair), scoped to what
 * the client actually owns: this device's stored connection. The address is
 * editable with Setup's own validator and wording; unpair is a local
 * forget — the daemon has no revocation route, so the copy never claims
 * one. Device name is absent for the same reason (issue #11's open
 * question): the daemon records it at pairing but serves no way to read it
 * back, and the client never sees it.
 */
export function Settings({ api, onConfigChange }: { api: DuoApiConfig; onConfigChange: (config: DuoApiConfig | null) => void }) {
  const [addressInput, setAddressInput] = useState(api.baseUrl);
  const [error, setError] = useState<string | null>(null);
  const [confirmingUnpair, setConfirmingUnpair] = useState(false);

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6" data-testid="settings">
      <section className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] p-4">
        <h2 className="text-sm font-medium">Connection</h2>
        <div className="flex flex-col gap-1 text-xs text-[var(--muted)]">
          <div data-testid="settings-address">{api.baseUrl}</div>
          <div data-testid="settings-token">{maskedToken(api.token)}</div>
        </div>
        <form
          className="flex flex-col gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            const normalized = normalizeBaseUrl(addressInput);
            if (!normalized) {
              setError(`"${addressInput}" doesn't look like a valid address — try something like 100.64.1.5:7717`);
              return;
            }
            setError(null);
            // Token unchanged: a moved daemon keeps its paired devices;
            // re-pairing is the flow when the token itself is wrong.
            onConfigChange({ baseUrl: normalized, token: api.token });
          }}
        >
          <label className="text-xs text-[var(--muted)]" htmlFor="settings-address-input">
            Daemon address
          </label>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1.5 text-sm text-[var(--text)]"
              id="settings-address-input"
              onChange={(e) => setAddressInput(e.target.value)}
              value={addressInput}
            />
            <button className="rounded-[var(--r-sm)] bg-[var(--accent)] px-3 py-1.5 text-sm text-[var(--bg)] disabled:opacity-40" disabled={!addressInput.trim()} type="submit">
              Save
            </button>
          </div>
          {error && (
            <p className="text-xs text-[var(--refused)]" data-testid="settings-error">
              {error}
            </p>
          )}
        </form>
      </section>

      <section className="flex flex-col gap-3 rounded-[var(--r-lg)] border border-[var(--edge)] p-4">
        <h2 className="text-sm font-medium">This device</h2>
        {confirmingUnpair ? (
          <div className="flex flex-col gap-3" data-testid="settings-unpair-confirmation">
            <p className="text-xs text-[var(--muted)]">
              Forget this device's stored connection? The daemon keeps its own record — this removes the address and token here, on this device only.
            </p>
            <div className="flex gap-2">
              <button
                className="rounded-[var(--r-sm)] bg-[var(--refused)] px-3 py-1.5 text-sm text-white"
                data-testid="settings-unpair-confirm"
                onClick={() => onConfigChange(null)}
              >
                Forget this device
              </button>
              <button
                className="rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1.5 text-sm"
                data-testid="settings-unpair-cancel"
                onClick={() => setConfirmingUnpair(false)}
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            className="self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1.5 text-sm text-[var(--muted)]"
            data-testid="settings-unpair"
            onClick={() => setConfirmingUnpair(true)}
          >
            Forget this device…
          </button>
        )}
      </section>
    </div>
  );
}
