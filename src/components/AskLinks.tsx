import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useAskLinks, useCreateAskLink, useRevokeAskLink } from "../api/queries.js";
import type { AskLinkRow } from "../api/types.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./primitives/AlertDialog.js";
import { CopyableSecret } from "./CopyableSecret.js";
import { MutationError } from "./MutationError.js";
import { Timestamp } from "./Timestamp.js";

const DEFAULT_EXPIRY_HOURS = 72;
const rowButton = "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]";

/**
 * The shareable address of an ask link: this app's own `ask.html` (the
 * no-install asker page), with the duo's base URL and the ask token in the
 * hash — never the query string, so neither rides in a `Referer`. The base
 * URL keeps its path, so a hosted duo's `/t/<id>` reaches the right duo.
 */
export function askLinkUrl(origin: string, baseUrl: string, token: string): string {
  return `${origin}/ask.html#host=${encodeURIComponent(baseUrl)}&token=${encodeURIComponent(token)}`;
}

/** Only rows in the daemon's documented shape render — a stray payload must never crash Settings on a bad timestamp. */
function isAskLinkRow(value: unknown): value is AskLinkRow {
  const row = value as Partial<AskLinkRow> | null;
  return (
    !!row &&
    typeof row.id === "string" &&
    typeof row.name === "string" &&
    typeof row.createdAt === "string" &&
    typeof row.expiresAt === "string" &&
    !Number.isNaN(Date.parse(row.createdAt)) &&
    !Number.isNaN(Date.parse(row.expiresAt))
  );
}

function AskLinkItem({ link, onRevoke }: { link: AskLinkRow; onRevoke: () => void }) {
  const live = link.valid && !link.revokedAt;
  return (
    <li className="shape-entry flex flex-col gap-2 px-4 py-3" data-testid="ask-link-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-body">{link.name}</span>
        {link.revokedAt ? (
          <span className="type-provenance text-[var(--refused)]">
            Revoked <Timestamp iso={link.revokedAt} />
          </span>
        ) : !link.valid ? (
          <span className="type-provenance text-[var(--muted)]">Expired</span>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-x-4 type-provenance text-[var(--muted)]">
        <span>
          Created <Timestamp iso={link.createdAt} />
        </span>
        <span>
          {live ? "Expires" : "Expired"} <Timestamp iso={link.expiresAt} />
        </span>
      </div>
      {live && (
        <AlertDialog>
          <AlertDialogTrigger aria-label={`Revoke ${link.name}'s link…`} className={`${rowButton} self-start`} data-testid="ask-link-revoke">
            Revoke…
          </AlertDialogTrigger>
          <AlertDialogContent className="w-[calc(100vw-3rem)] max-w-md" data-testid="ask-link-revoke-confirmation">
            <AlertDialogTitle className="type-heading">Revoke {link.name}&apos;s link?</AlertDialogTitle>
            <AlertDialogDescription className="type-provenance text-[var(--muted)]">
              The link stops working on its next use. What they already asked stays in your audit log.
            </AlertDialogDescription>
            <div className="flex gap-2">
              <AlertDialogAction
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--refused)] px-3 text-white"
                data-testid="ask-link-revoke-confirm"
                onClick={onRevoke}
              >
                Revoke link
              </AlertDialogAction>
              <AlertDialogCancel className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3">
                Cancel
              </AlertDialogCancel>
            </div>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </li>
  );
}

/**
 * Ask links (digital-duo #158/#159, now minted from the app): a short-lived
 * link a colleague opens to ask this duo one question at a time — no
 * install, no pairing, ask-only powers. The link is shown ONCE, at minting,
 * because the daemon never stores its token in recoverable form; the list
 * shows who each link was for and whether it still works.
 */
export function AskLinks({ api, origin = window.location.origin }: { api: DuoApiConfig; origin?: string }) {
  const [name, setName] = useState("");
  const [hours, setHours] = useState(String(DEFAULT_EXPIRY_HOURS));
  const links = useAskLinks(api);
  const create = useCreateAskLink(api);
  const revoke = useRevokeAskLink(api);
  const minted = create.data;
  const rows = Array.isArray(links.data) ? links.data.filter(isAskLinkRow) : [];
  const parsedHours = Number.parseInt(hours, 10);
  const hoursValid = Number.isInteger(parsedHours) && parsedHours > 0 && String(parsedHours) === hours.trim();

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-ask-links">
      <h2 className="type-heading">Ask links</h2>
      <p className="type-provenance text-[var(--muted)]">
        Let a colleague ask your duo questions from a link, with nothing to install. It answers only on topics you&apos;ve trusted it with;
        everything else is passed on to you.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed && hoursValid && !create.isPending) {
            create.mutate({ name: trimmed, expiresInHours: parsedHours }, { onSuccess: () => setName("") });
          }
        }}
      >
        <label className="flex flex-col gap-1 type-body">
          Who it&apos;s for
          <input
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
            onChange={(e) => setName(e.target.value)}
            placeholder="Sam"
            value={name}
          />
        </label>
        <label className="flex flex-col gap-1 type-body">
          Expires in (hours)
          <input
            className="min-h-11 w-28 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
            inputMode="numeric"
            onChange={(e) => setHours(e.target.value)}
            value={hours}
          />
        </label>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
          disabled={create.isPending || name.trim().length === 0 || !hoursValid}
          type="submit"
        >
          {create.isPending ? "Creating…" : "Create link"}
        </button>
      </form>
      {minted && (
        <div className="flex flex-col gap-2" data-testid="ask-link-minted">
          <p className="type-body">
            {minted.name}&apos;s link — send it to them now. It won&apos;t be shown again, and it expires <Timestamp iso={minted.expiresAt} />.
          </p>
          <CopyableSecret label="Link" testId="ask-link-url" value={askLinkUrl(origin, api.baseUrl, minted.token)} />
        </div>
      )}
      <MutationError error={create.error} />
      {links.isLoading ? (
        <p className="type-provenance text-[var(--muted)]" role="status">
          Loading links…
        </p>
      ) : links.error ? (
        <p className="type-provenance text-[var(--refused)]" role="alert">
          {links.error instanceof Error ? links.error.message : "The daemon could not list its ask links."}
        </p>
      ) : rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((link) => (
            <AskLinkItem key={link.id} link={link} onRevoke={() => revoke.mutate({ id: link.id })} />
          ))}
        </ul>
      ) : (
        <p className="type-provenance text-[var(--muted)]" data-testid="ask-links-empty">
          No ask links yet.
        </p>
      )}
      <MutationError error={revoke.error} />
    </section>
  );
}
