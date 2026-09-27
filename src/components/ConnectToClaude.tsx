import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useConnector, useMintConnector, useRevokeConnection } from "../api/queries.js";
import type { ConnectorStatus } from "../api/types.js";
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
  if (status.data?.mode === "signin") {
    return <SignInConnector api={api} status={status.data} />;
  }
  return <SecretUrlConnector api={api} />;
}

/**
 * Connecting by signing in (digital-duo#240): the address carries no secret,
 * so it can be shown any time; Claude signs the owner in with Google on the
 * web app's connect page. What the owner manages here is who is connected,
 * and disconnecting one takes effect at once.
 */
function SignInConnector({ api, status }: { api: DuoApiConfig; status: ConnectorStatus }) {
  const revoke = useRevokeConnection(api);
  const connections = status.connections ?? [];
  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-connect-claude">
      <h2 className="type-heading">Connect to Claude</h2>
      <p className="type-provenance text-[var(--muted)]">
        Add your duo to claude.ai as a connector, then ask Claude to save things to it from any chat. Claude asks you to sign in with Google, so only you can connect it to your duo.
      </p>
      {status.url && <CopyableSecret label="Connector address" testId="connect-claude-address" value={status.url} />}
      <p className="type-body">In claude.ai open Settings, then Connectors, then Add custom connector, and paste this address.</p>

      <div className="flex flex-col gap-2" data-testid="connect-claude-connections">
        <h3 className="type-heading">Connected</h3>
        {connections.length === 0 ? (
          <p className="type-body text-[var(--muted)]" data-testid="connect-claude-none">
            Nothing is connected yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {connections.map((connection) => (
              <li className="flex flex-wrap items-center justify-between gap-2" data-testid="connect-claude-connection" key={connection.id}>
                <span className="type-body">
                  {connection.clientName}, connected {new Date(connection.createdAt).toLocaleDateString()}
                  {connection.lastUsedAt ? `, last used ${new Date(connection.lastUsedAt).toLocaleDateString()}` : ", not used yet"}
                </span>
                <button
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
                  disabled={revoke.isPending}
                  onClick={() => revoke.mutate(connection.id)}
                  type="button"
                >
                  Disconnect
                </button>
              </li>
            ))}
          </ul>
        )}
        <MutationError error={revoke.error} />
      </div>

      {connections.length > 0 && (
        <div className="flex flex-col gap-2" data-testid="connect-claude-history">
          <h3 className="type-heading">Bring in your history</h3>
          <p className="type-body">
            Paste this into a claude.ai chat. Claude searches your past chats (paid plans) and saves notes to your duo. They are Claude&apos;s summaries, not exact copies; for an exact copy import your Claude export.
          </p>
          <CopyableSecret label="Prompt" multiline testId="connect-claude-prompt" value={status.historyPrompt} />
        </div>
      )}
    </section>
  );
}

function SecretUrlConnector({ api }: { api: DuoApiConfig }) {
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
