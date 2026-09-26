import { useEffect, useRef, useState, type ReactNode } from "react";
import { ApiRequestError, type DuoApiConfig } from "../api/client.js";
import type { HostedOrg, HostedOrgMember } from "../api/hosted.js";
import {
  useCreateHostedInvite,
  useCreateHostedOrg,
  useHostedOrgMembers,
  useHostedOrgs,
  useRenameHostedOrg,
} from "../api/queries.js";
import { CopyableSecret } from "../components/CopyableSecret.js";
import { MutationError } from "../components/MutationError.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Timestamp } from "../components/Timestamp.js";

/**
 * #128: the super admin's screens — the orgs on this server, who is in
 * each, and an invite link into one. What `duo hosted org …` and
 * `duo hosted invite --org …` do from a terminal, without needing one.
 *
 * Only a super admin sees the way in (the sidebar shows the entry from the
 * sign-in answer's `isAdmin`), but that flag is a per-browser convenience:
 * the daemon re-checks it on every call. So a 401 or 403 here — an admin
 * withdrawn since sign-in, or a hand-typed `#admin` — lands on the same
 * plain "not for you" note a non-admin gets, never on an error screen.
 */

const field = "min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2";
const primaryButton =
  "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40";
const quietButton = "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]";

/** The daemon says "not a super admin" as 401 (no credential) or 403. */
function isNotAdmin(error: unknown): boolean {
  return error instanceof ApiRequestError && (error.status === 401 || error.status === 403);
}

function peopleCount(count: number): string {
  return count === 1 ? "1 person" : `${count} people`;
}

/** The address of one org's page. Org ids are lowercase letters and digits, but encode all the same. */
export function orgHref(orgId: string): string {
  return `#admin/${encodeURIComponent(orgId)}`;
}

function NotAvailable() {
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-2 p-6" data-testid="admin-not-available">
      <h1 className="type-heading">Admin</h1>
      <p className="type-body text-[var(--muted)]">Only the person who runs this server can open this page.</p>
    </div>
  );
}

function OrgRow({ org }: { org: HostedOrg }) {
  return (
    <li>
      <a
        className="shape-entry flex min-h-11 flex-wrap items-baseline justify-between gap-x-4 gap-y-1 px-4 py-3"
        data-testid="admin-org"
        href={orgHref(org.id)}
      >
        <span className="type-body">{org.name}</span>
        <span className="type-provenance text-[var(--muted)]">
          <span data-testid="admin-org-count">{peopleCount(org.memberCount)}</span> · created <Timestamp iso={org.createdAt} />
        </span>
      </a>
    </li>
  );
}

function CreateOrg({ api, origin }: { api: DuoApiConfig; origin: string }) {
  const [name, setName] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const create = useCreateHostedOrg(origin, api);
  const trimmed = name.trim();
  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="admin-create-org">
      <h2 className="type-heading">Create an org</h2>
      <p className="type-provenance text-[var(--muted)]">
        An org is a group of people whose duos work together, like a team or an agency. Each person belongs to one.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !create.isPending) {
            setCreated(null);
            create.mutate(trimmed, {
              onSuccess: (org) => {
                setName("");
                setCreated(org.name);
              },
            });
          }
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 type-body">
          Name of the org
          <input className={field} onChange={(e) => setName(e.target.value)} placeholder="Platform team" value={name} />
        </label>
        <button className={primaryButton} disabled={create.isPending || trimmed.length === 0} type="submit">
          {create.isPending ? "Creating…" : "Create org"}
        </button>
      </form>
      {created && (
        <p className="type-body" data-testid="admin-org-created" role="status">
          Created {created}. Open it in the list above to invite people in.
        </p>
      )}
      <MutationError error={create.error} />
    </section>
  );
}

/** Every org on the server, with how many people are in it. */
function OrgList({ api, origin }: { api: DuoApiConfig; origin: string }) {
  const orgs = useHostedOrgs(origin, api);
  if (isNotAdmin(orgs.error)) {
    return <NotAvailable />;
  }
  if (orgs.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (orgs.error) {
    return <RouteError api={api} error={orgs.error} onRetry={() => void orgs.refetch()} />;
  }
  const rows = Array.isArray(orgs.data) ? orgs.data : [];
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6" data-testid="admin">
      <h1 className="type-heading">Admin</h1>
      <section className="flex flex-col gap-3" data-testid="admin-orgs">
        <h2 className="type-heading">Orgs on this server</h2>
        {rows.length > 0 ? (
          <ul className="flex flex-col gap-2">
            {rows.map((org) => (
              <OrgRow key={org.id} org={org} />
            ))}
          </ul>
        ) : (
          <p className="type-provenance text-[var(--muted)]" data-testid="admin-orgs-empty">
            No orgs yet.
          </p>
        )}
      </section>
      <CreateOrg api={api} origin={origin} />
    </div>
  );
}

function MemberRow({ member }: { member: HostedOrgMember }) {
  return (
    <li className="shape-entry flex flex-col gap-1 px-4 py-3" data-testid="admin-member">
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-body">{member.name}</span>
        {member.isRoot && (
          <span className="type-identifier text-[var(--muted)]" data-testid="admin-member-root">
            Root duo
          </span>
        )}
        {member.isAdmin && <span className="type-identifier text-[var(--muted)]">Admin</span>}
      </div>
      <div className="flex flex-wrap gap-x-4 type-provenance text-[var(--muted)]">
        <span>{member.name}&apos;s duo</span>
        {member.email && <span className="type-identifier">{member.email}</span>}
        {member.joinedAt && (
          <span>
            Joined <Timestamp iso={member.joinedAt} />
          </span>
        )}
      </div>
      {member.isRoot && (
        <p className="type-provenance text-[var(--muted)]">The first duo on this server, made before invites existed.</p>
      )}
    </li>
  );
}

function RenameOrg({ api, origin, org }: { api: DuoApiConfig; origin: string; org: HostedOrg }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(org.name);
  const rename = useRenameHostedOrg(origin, api);
  const trimmed = name.trim();
  // The Rename button and the form replace each other, so focus is handed over by hand: into the
  // input when editing starts, back to the button when it ends (Cancel or a saved name).
  const inputRef = useRef<HTMLInputElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
    } else if (wasEditing.current) {
      buttonRef.current?.focus();
    }
    wasEditing.current = editing;
  }, [editing]);
  if (!editing) {
    return (
      <button
        className={`${quietButton} self-start`}
        data-testid="admin-rename"
        ref={buttonRef}
        onClick={() => {
          setName(org.name);
          rename.reset();
          setEditing(true);
        }}
        type="button"
      >
        Rename
      </button>
    );
  }
  return (
    <div className="flex flex-col gap-2">
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && !rename.isPending) {
            rename.mutate({ orgId: org.id, name: trimmed }, { onSuccess: () => setEditing(false) });
          }
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 type-body">
          New name
          <input className={field} onChange={(e) => setName(e.target.value)} ref={inputRef} value={name} />
        </label>
        <button className={primaryButton} disabled={rename.isPending || trimmed.length === 0 || trimmed === org.name} type="submit">
          {rename.isPending ? "Saving…" : "Save name"}
        </button>
        <button className={quietButton} onClick={() => setEditing(false)} type="button">
          Cancel
        </button>
      </form>
      <MutationError error={rename.error} />
    </div>
  );
}

/** One invite link into this org, shown once. An email locks it to that Google account. */
function InviteIntoOrg({ api, origin, org }: { api: DuoApiConfig; origin: string; org: HostedOrg }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const create = useCreateHostedInvite(origin, api);
  const minted = create.data;
  const emailValid = email.trim() === "" || email.includes("@");
  const trimmed = name.trim();
  // The form clears and its button disables when the link is made, so focus would be lost: move it
  // to the result, which is also announced. The link is shown only once.
  const resultRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (minted) {
      resultRef.current?.focus();
    }
  }, [minted]);
  return (
    <section className="shape-container flex flex-col gap-3 p-4" data-testid="admin-invite">
      <h2 className="type-heading">Invite someone into {org.name}</h2>
      <p className="type-provenance text-[var(--muted)]">
        The link lets one person create a duo of their own and join this org. Whoever opens it first uses it up.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && emailValid && !create.isPending) {
            create.mutate(
              { name: trimmed, orgId: org.id, ...(email.trim() ? { email: email.trim() } : {}) },
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
        <label className="flex min-w-0 flex-col gap-1 type-body">
          Who it&apos;s for
          <input className={field} onChange={(e) => setName(e.target.value)} placeholder="Sam" value={name} />
        </label>
        <label className="flex min-w-0 flex-col gap-1 type-body">
          Their Google email (optional)
          <input className={field} inputMode="email" onChange={(e) => setEmail(e.target.value)} placeholder="sam@example.com" value={email} />
        </label>
        <button className={primaryButton} disabled={create.isPending || trimmed.length === 0 || !emailValid} type="submit">
          {create.isPending ? "Creating…" : "Create invite link"}
        </button>
      </form>
      {minted && (
        <div aria-live="polite" className="flex flex-col gap-2" data-testid="admin-invite-minted" ref={resultRef} role="status" tabIndex={-1}>
          <p className="type-body">
            {minted.name}&apos;s invite to {org.name}
            {minted.email ? ` (only ${minted.email} can use it)` : ""} — send it now. It won&apos;t be shown again, works once, and expires{" "}
            <Timestamp iso={minted.expiresAt} />.
            {!minted.link && " This server doesn't know its public address, so there is no link to send, only the code below."}
          </p>
          {minted.link ? (
            <CopyableSecret label="Invite link" testId="admin-invite-link" value={minted.link} />
          ) : (
            <CopyableSecret label="Invite code" testId="admin-invite-code" value={minted.code} />
          )}
        </div>
      )}
      <MutationError error={create.error} />
    </section>
  );
}

function Members({ members }: { members: ReturnType<typeof useHostedOrgMembers> }) {
  const rows = Array.isArray(members.data) ? members.data : [];
  return (
    <section className="flex flex-col gap-3" data-testid="admin-members">
      <h2 className="type-heading">People</h2>
      {members.isLoading ? (
        <p className="type-provenance text-[var(--muted)]" role="status">
          Loading people…
        </p>
      ) : members.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="type-provenance text-[var(--refused)]" data-testid="admin-members-error" role="alert">
            {members.error instanceof Error ? members.error.message : "The server could not list this org's people."}
          </p>
          <button className={quietButton} data-testid="admin-members-retry" onClick={() => void members.refetch()} type="button">
            Try again
          </button>
        </div>
      ) : rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((member) => (
            <MemberRow key={member.duoId} member={member} />
          ))}
        </ul>
      ) : (
        <p className="type-provenance text-[var(--muted)]" data-testid="admin-members-empty">
          No one has joined yet. Send an invite link below.
        </p>
      )}
    </section>
  );
}

/** The page of an org that exists. Its people are asked for only now, so an address the list doesn't confirm never reaches the daemon. */
function OrgBody({ api, back, org, origin }: { api: DuoApiConfig; back: ReactNode; org: HostedOrg; origin: string }) {
  const members = useHostedOrgMembers(origin, api, org.id);
  if (isNotAdmin(members.error)) {
    return <NotAvailable />;
  }
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6" data-testid="admin-org-page">
      {back}
      <header className="flex flex-col gap-2">
        <h1 className="type-heading" data-testid="admin-org-name">
          {org.name}
        </h1>
        <p className="type-provenance text-[var(--muted)]">
          {peopleCount(org.memberCount)} · created <Timestamp iso={org.createdAt} />
        </p>
        <RenameOrg api={api} org={org} origin={origin} />
      </header>
      <Members members={members} />
      <InviteIntoOrg api={api} key={org.id} org={org} origin={origin} />
    </div>
  );
}

/** One org: its name (renameable), its people, and an invite link into it. */
function OrgPage({ api, origin, orgId }: { api: DuoApiConfig; origin: string; orgId: string }) {
  const orgs = useHostedOrgs(origin, api);
  if (isNotAdmin(orgs.error)) {
    return <NotAvailable />;
  }
  if (orgs.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (orgs.error) {
    return <RouteError api={api} error={orgs.error} onRetry={() => void orgs.refetch()} />;
  }
  const org = (Array.isArray(orgs.data) ? orgs.data : []).find((candidate) => candidate.id === orgId);
  const back = (
    <a className="inline-flex min-h-11 items-center self-start type-body text-[var(--muted)]" data-testid="admin-back" href="#admin">
      ← All orgs
    </a>
  );
  if (!org) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-3 p-6" data-testid="admin-org-missing">
        {back}
        <p className="type-body text-[var(--muted)]">There is no org with this address. It may have been renamed or removed.</p>
      </div>
    );
  }
  return <OrgBody api={api} back={back} org={org} origin={origin} />;
}

/**
 * `origin` is null when this browser isn't signed in to a hosted server as
 * an admin — the same "not for you" answer as a 403, without a request.
 * `orgId` opens one org (`#admin/<id>`); without it, the list.
 */
export function Admin({ api, origin, orgId }: { api: DuoApiConfig; origin: string | null; orgId: string | null }) {
  if (!origin) {
    return <NotAvailable />;
  }
  // Keyed by the id: a hand-edited address from one org to another must not carry the first org's state (a minted invite link) into the second.
  return orgId ? <OrgPage api={api} key={orgId} orgId={orgId} origin={origin} /> : <OrgList api={api} origin={origin} />;
}
