import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useConnector, useMintConnector } from "../api/queries.js";
import { CopyableSecret } from "./CopyableSecret.js";
import { MutationError } from "./MutationError.js";

/**
 * The claude.ai connector (digital-duo#227): the owner mints a URL, adds it
 * to claude.ai as a custom connector, and can then save from any chat. The
 * daemon answers the URL exactly once, so it is shown here right after
 * minting and never again — returning later shows only that a connector
 * exists. Replacing it revokes the old one, so it asks first. For a hosted
 * duo `api.baseUrl` already carries the duo's `/t/<id>` prefix, which is
 * what makes the URL open that duo and no other.
 *
 * The second half is the prompt that feeds past chats in. The daemon builds
 * it (it names the tool and the duo's own ceiling); this only shows it.
 */
export function ConnectToClaude({ api }: { api: DuoApiConfig }) {
  const status = useConnector(api);
  const mint = useMintConnector(api);
  const [confirmingReplace, setConfirmingReplace] = useState(false);

  const existing = status.data?.connector ?? null;
  const historyPrompt = status.data?.historyPrompt;
  const minted = mint.data;
  const connectorUrl = minted ? `${api.baseUrl.replace(/\/+$/, "")}${minted.path}` : undefined;

  function generate() {
    if (!mint.isPending) {
      setConfirmingReplace(false);
      mint.mutate();
    }
  }

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-connect-claude">
      <h2 className="type-heading">Connect to Claude</h2>
      <p className="type-provenance text-[var(--muted)]">
        Add your duo to claude.ai as a connector, then ask Claude to save things to it from any chat. The connector URL works like a password: anyone who has it can add to your duo.
      </p>

      {connectorUrl && (
        <div className="flex flex-col gap-2" data-testid="connect-claude-result">
          <CopyableSecret label="Connector URL" testId="connect-claude-url" value={connectorUrl} />
          <p className="type-body">
            In claude.ai open Settings, then Connectors, then Add custom connector, and paste this URL. It won&apos;t be shown again.
          </p>
        </div>
      )}

      {!connectorUrl && existing && (
        <p className="type-body" data-testid="connect-claude-existing">
          A connector was created on {new Date(existing.createdAt).toLocaleDateString()}. Its URL can&apos;t be shown again; generate a new one if you need it.
        </p>
      )}

      {confirmingReplace ? (
        <div className="flex flex-col gap-2" data-testid="connect-claude-confirm">
          <p className="type-body">The current URL will stop working right away. Generate a new one?</p>
          <div className="flex flex-wrap gap-2">
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
              disabled={mint.isPending}
              onClick={generate}
              type="button"
            >
              Replace it
            </button>
            <button
              className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
              onClick={() => setConfirmingReplace(false)}
              type="button"
            >
              Keep it
            </button>
          </div>
        </div>
      ) : (
        <div>
          <button
            className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
            data-testid="connect-claude-generate"
            disabled={mint.isPending || status.isPending}
            onClick={() => (existing ? setConfirmingReplace(true) : generate())}
            type="button"
          >
            {mint.isPending ? "Generating…" : existing ? "Generate new URL" : "Generate connector URL"}
          </button>
        </div>
      )}
      <MutationError error={mint.error} />

      {(existing || minted) && historyPrompt && (
        <div className="flex flex-col gap-2" data-testid="connect-claude-history">
          <h3 className="type-heading">Bring in your history</h3>
          <p className="type-body">
            With the connector added, paste this into a claude.ai chat. Claude searches your past chats (paid plans) and saves notes to your duo. They are Claude&apos;s summaries, not exact copies; for an exact copy import your Claude export.
          </p>
          <CopyableSecret label="Prompt" multiline testId="connect-claude-prompt" value={historyPrompt} />
        </div>
      )}
    </section>
  );
}
