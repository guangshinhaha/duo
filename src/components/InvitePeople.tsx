import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useCreateHostedInvite, useHostedInvites } from "../api/queries.js";
import type { HostedInviteRow } from "../api/hosted.js";
import { CopyableSecret } from "./CopyableSecret.js";
import { MutationError } from "./MutationError.js";
import { Timestamp } from "./Timestamp.js";

const DEFAULT_EXPIRY_DAYS = 7;

/** Only rows in the daemon's documented shape render — a bad timestamp must never crash Settings. */
function isInviteRow(value: unknown): value is HostedInviteRow {
  const row = value as Partial<HostedInviteRow> | null;
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

function inviteStatus(row: HostedInviteRow, now = Date.now()): "used" | "expired" | "pending" {
  if (row.usedAt) {
    return "used";
  }
  return Date.parse(row.expiresAt) <= now ? "expired" : "pending";
}

function InviteItem({ invite }: { invite: HostedInviteRow }) {
  const status = inviteStatus(invite);
  return (
    <li className="shape-entry flex flex-col gap-1 px-4 py-3" data-testid="invite-row">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-body">{invite.name}</span>
        {invite.email && <span className="type-identifier text-[var(--muted)]">{invite.email}</span>}
        <span
          className={`type-provenance ${status === "used" ? "text-[var(--accent)]" : status === "expired" ? "text-[var(--muted)]" : "text-[var(--escalate)]"}`}
          data-testid="invite-status"
        >
          {status === "used" ? "Joined" : status === "expired" ? "Expired" : "Not used yet"}
        </span>
      </div>
      <div className="flex flex-wrap gap-x-4 type-provenance text-[var(--muted)]">
        <span>
          Created <Timestamp iso={invite.createdAt} />
        </span>
        {invite.usedAt ? (
          <span>
            Joined <Timestamp iso={invite.usedAt} />
          </span>
        ) : (
          <span>
            {status === "expired" ? "Expired" : "Expires"} <Timestamp iso={invite.expiresAt} />
          </span>
        )}
      </div>
    </li>
  );
}

/**
 * Hosted mode, admins only: invite someone to create a duo of their own on
 * this server. The link is shown once — the daemon keeps only a hash of the
 * code — and is single-use. An email locks the invite to that Google
 * account, so a forwarded link can't be spent by someone else.
 */
export function InvitePeople({ api, origin }: { api: DuoApiConfig; origin: string }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [days, setDays] = useState(String(DEFAULT_EXPIRY_DAYS));
  const invites = useHostedInvites(origin, api);
  const create = useCreateHostedInvite(origin, api);
  const minted = create.data;
  const rows = Array.isArray(invites.data) ? invites.data.filter(isInviteRow).slice().reverse() : [];
  const parsedDays = Number.parseInt(days, 10);
  const daysValid = Number.isInteger(parsedDays) && parsedDays > 0 && parsedDays <= 365 && String(parsedDays) === days.trim();
  const emailValid = email.trim() === "" || email.includes("@");

  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-invite-people">
      <h2 className="type-heading">Invite people</h2>
      <p className="type-provenance text-[var(--muted)]">
        Each invite lets one person create a duo of their own on this server, signing in with Google. Their duo is separate from yours — but
        as the person running this server, you could technically read it, and they&apos;re told so when they join.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          const trimmed = name.trim();
          if (trimmed && daysValid && emailValid && !create.isPending) {
            create.mutate(
              { name: trimmed, ...(email.trim() ? { email: email.trim() } : {}), expiresInHours: parsedDays * 24 },
              {
                onSuccess: () => {
                  setName("");
                  setEmail("");
                },
              },
            );
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
          Their Google email (optional)
          <input
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
            inputMode="email"
            onChange={(e) => setEmail(e.target.value)}
            placeholder="sam@example.com"
            value={email}
          />
        </label>
        <label className="flex flex-col gap-1 type-body">
          Expires in (days)
          <input
            className="min-h-11 w-24 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
            inputMode="numeric"
            onChange={(e) => setDays(e.target.value)}
            value={days}
          />
        </label>
        <button
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
          disabled={create.isPending || name.trim().length === 0 || !daysValid || !emailValid}
          type="submit"
        >
          {create.isPending ? "Creating…" : "Create invite"}
        </button>
      </form>
      {minted && (
        <div className="flex flex-col gap-2" data-testid="invite-minted">
          <p className="type-body">
            {minted.name}&apos;s invite{minted.email ? ` (only ${minted.email} can use it)` : ""} — send it now. It won&apos;t be shown again,
            works once, and expires <Timestamp iso={minted.expiresAt} />.
          </p>
          {minted.link ? (
            <CopyableSecret label="Invite link" testId="invite-link" value={minted.link} />
          ) : (
            <CopyableSecret label="Invite code (this server doesn't know its public address, so there's no link)" testId="invite-code" value={minted.code} />
          )}
        </div>
      )}
      <MutationError error={create.error} />
      {invites.isLoading ? (
        <p className="type-provenance text-[var(--muted)]" role="status">
          Loading invites…
        </p>
      ) : invites.error ? (
        <p className="type-provenance text-[var(--refused)]" role="alert">
          {invites.error instanceof Error ? invites.error.message : "The server could not list its invites."}
        </p>
      ) : rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((invite) => (
            <InviteItem invite={invite} key={invite.id} />
          ))}
        </ul>
      ) : (
        <p className="type-provenance text-[var(--muted)]" data-testid="invites-empty">
          No invites yet.
        </p>
      )}
    </section>
  );
}
