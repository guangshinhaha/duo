import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { ApiRequestError, type DuoApiConfig } from "../api/client.js";
import { pairedDuoId, type AdminRole, type HostedOrg, type HostedOrgMember, type OrgPendingInvite } from "../api/hosted.js";
import {
  queryKeys,
  useCreateHostedOrg,
  useHostedOrgMembers,
  useHostedOrgs,
  useInviteIntoOrg,
  useOrgOverview,
  useOwnOrgInvites,
  useOwnOrgMembers,
  useRenameOrg,
  useSetAnswering,
  useSetOrgAdmin,
  type OrgScope,
} from "../api/queries.js";
import { CopyableSecret } from "../components/CopyableSecret.js";
import { MutationError } from "../components/MutationError.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Timestamp } from "../components/Timestamp.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/primitives/AlertDialog.js";

/**
 * #128, #254: the admin screens. The super admin's are the orgs on this server, who is in each, and an
 * invite link into one — what `duo hosted org …` and `duo hosted invite --org …` do from a terminal, without
 * needing one. An org admin's are the same for their own org and no other: its people, its pending invites,
 * an invite link, a new name, and who else is an org admin.
 *
 * Who sees the way in is the shell's call (`adminRoleOf`: the daemon's live answer to "what is my role",
 * with the sign-in's flags only as the first hint), but that is a courtesy: the daemon re-checks the role on
 * every call. So a 401 or 403 here — a role withdrawn since, or a hand-typed `#admin` — lands on the same
 * plain "not for you" note a non-admin gets, never on an error screen. An org admin never asks a `/hosted/*`
 * route, never sees another org's name, and is never handed an org list: their calls go to their own duo's
 * `<basePath>/org*` routes, which name no org at all.
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

/**
 * One note for everyone this page is not for: a member, an org admin whose role was just withdrawn, a wrong address.
 * It can replace a page the person was using, so it is announced and takes focus (the row that held it is gone).
 */
function NotAvailable() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-2 p-6" data-testid="admin-not-available" ref={ref} role="status" tabIndex={-1}>
      <h1 className="type-heading">Admin</h1>
      <p className="type-body text-[var(--muted)]">
        This page is for admins, and your account isn&apos;t one right now. If that changed, ask an admin of your org.
      </p>
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

/** A calendar date, in the reader's own format, for "appointed on …". The full time rides on hover. */
function DateLabel({ iso }: { iso: string }) {
  const when = new Date(iso);
  return (
    <time dateTime={iso} title={when.toISOString()}>
      {when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })}
    </time>
  );
}

/**
 * The marks. "Org admin" and "Super admin" are different words, not different colours: a person reading the
 * page aloud, or in a monochrome print, tells them apart. The super admin manages every org; an org admin only this one.
 */
function RoleMark({ kind }: { kind: "org_admin" | "super_admin" | "root" }) {
  const label = kind === "org_admin" ? "Org admin" : kind === "super_admin" ? "Super admin" : "Root duo";
  const tone = kind === "org_admin" ? "border-[var(--accent)] text-[var(--text)]" : "border-[var(--edge)] text-[var(--muted)]";
  return (
    <span className={`rounded-[var(--r-sm)] border px-2 type-identifier ${tone}`} data-testid={`admin-member-${kind.replace("_", "-")}`}>
      {label}
    </span>
  );
}

/**
 * duo#318: the verification marks — "Unverified" (the owner's Google sign-in was never checked against an
 * invite; a duo made this way cannot answer colleagues at all, whatever the switch below says) and "Answering
 * revoked" (verified, but an admin switched it off). The hairline's refused colour (`--refused`), the same one
 * a draft's refusal reading carries, because both are the system declining to speak on the owner's behalf.
 */
function AnsweringMark({ kind }: { kind: "unverified" | "revoked" }) {
  const label = kind === "unverified" ? "Unverified" : "Answering revoked";
  return (
    <span className="rounded-[var(--r-sm)] border border-[var(--refused)] px-2 type-identifier text-[var(--refused)]" data-testid={`admin-member-${kind}`}>
      {label}
    </span>
  );
}

/** What to say for a refusal the daemon gave a code for. The app's words, keyed by the code and never by the daemon's own text. */
function knownRefusal(error: unknown): string | null {
  if (!(error instanceof ApiRequestError)) {
    return null;
  }
  switch (error.code) {
    case "last_org_admin":
      return "This is the org's last org admin. Only the super admin can remove them.";
    case "super_admin_protected":
      return "The super admin manages every org already, so this can't be changed here.";
    case "root_not_appointable":
      return "The first duo on this server can't be made an org admin.";
    case "org_name_taken":
    case "name_unavailable":
      // Two codes for one answer (the super admin's route and an org admin's): neither says which org has the name.
      return "That name isn't available. Choose a different one.";
    case "too_many_invites":
      return "This org has too many invites waiting. Some need to be used or to expire (invites last up to a year) before you can make another, or the super admin can cancel one.";
    default:
      return null;
  }
}

/** A failed save, as the words to show: ours for a code we know, else the daemon's own (which is written for a person). */
function friendlyError(error: Error | null): Error | null {
  const known = knownRefusal(error);
  return known && error ? new Error(known) : error;
}

interface Notice {
  readonly tone: "ok" | "error";
  readonly text: string;
}

const dialogButton = "inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] px-3";

function ConfirmChange({
  confirmLabel,
  description,
  disabled,
  onClosed,
  onConfirm,
  testId,
  title,
  tone,
  triggerLabel,
  triggerName,
}: {
  confirmLabel: string;
  description: string;
  disabled: boolean;
  /** After the dialog closed on Confirm, where focus goes (a Cancel returns to the button, as everywhere). */
  onClosed: () => void;
  onConfirm: () => void;
  testId: string;
  title: string;
  tone: "appoint" | "revoke";
  triggerLabel: string;
  triggerName: string;
}) {
  const confirmed = useRef(false);
  return (
    <AlertDialog>
      <AlertDialogTrigger
        aria-label={triggerName}
        className={`${dialogButton} border border-[var(--edge)] text-[var(--muted)] disabled:opacity-40`}
        data-testid={testId}
        disabled={disabled}
      >
        {triggerLabel}
      </AlertDialogTrigger>
      <AlertDialogContent
        className="w-[calc(100vw-3rem)] max-w-md"
        data-testid={`${testId}-confirmation`}
        onCloseAutoFocus={(event) => {
          // The button that opened this turns into its opposite once the change lands, so a confirmed dialog hands focus to the person's row instead.
          if (confirmed.current) {
            event.preventDefault();
            confirmed.current = false;
            onClosed();
          }
        }}
      >
        <AlertDialogTitle className="type-heading">{title}</AlertDialogTitle>
        <AlertDialogDescription className="type-provenance text-[var(--muted)]">{description}</AlertDialogDescription>
        <div className="flex flex-wrap gap-2">
          <AlertDialogAction
            className={`${dialogButton} ${tone === "revoke" ? "bg-[var(--refused)] text-white" : "bg-[var(--accent)] text-[var(--bg)]"}`}
            data-testid={`${testId}-confirm`}
            onClick={() => {
              confirmed.current = true;
              onConfirm();
            }}
          >
            {confirmLabel}
          </AlertDialogAction>
          <AlertDialogCancel className={`${dialogButton} border border-[var(--edge)]`} data-testid={`${testId}-cancel`}>
            Cancel
          </AlertDialogCancel>
        </div>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function MemberRow({
  answeringBusy,
  busy,
  isSelf,
  lastOrgAdminForOrgAdmin,
  member,
  onAppoint,
  onClosed,
  onRevoke,
  onRevokeAnswering,
  onRestoreAnswering,
  orgName,
  rowRef,
  viewer,
}: {
  answeringBusy: boolean;
  busy: boolean;
  isSelf: boolean;
  /** An org admin looking at the org's only org admin: the daemon refuses that revoke for them, so it is explained, not offered. */
  lastOrgAdminForOrgAdmin: boolean;
  member: HostedOrgMember;
  onAppoint: () => void;
  onClosed: () => void;
  onRevoke: () => void;
  /** duo#318: never offered for the root duo or (to an org admin) the super admin's own duo — the daemon protects both the same way the role does. */
  onRevokeAnswering: () => void;
  onRestoreAnswering: () => void;
  orgName: string;
  rowRef: (element: HTMLLIElement | null) => void;
  viewer: "super" | "org";
}) {
  const isOrgAdmin = member.orgRole === "org_admin";
  const canAppoint = !isOrgAdmin && !member.superAdmin && !member.isRoot;
  // A super admin who also holds the role can step down themselves, but another org admin does not manage them.
  const canRevoke = isOrgAdmin && !lastOrgAdminForOrgAdmin && !(viewer === "org" && member.superAdmin && !isSelf);
  // duo#318: the root duo is never a target (always verified, always answering), and no viewer manages a super
  // admin's own duo from this screen — the same unconditional carve-out `canAppoint` already gives that row.
  const answeringManageable = !member.isRoot && !member.superAdmin;
  return (
    <li
      className="shape-entry flex flex-col gap-1 px-4 py-3"
      data-testid="admin-member"
      ref={rowRef}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="type-body">{member.name}</span>
        {isSelf && <span className="type-provenance text-[var(--muted)]">(you)</span>}
        {member.isRoot && <RoleMark kind="root" />}
        {member.superAdmin && <RoleMark kind="super_admin" />}
        {isOrgAdmin && <RoleMark kind="org_admin" />}
        {!member.verified && <AnsweringMark kind="unverified" />}
        {member.verified && !member.answeringEnabled && <AnsweringMark kind="revoked" />}
      </div>
      <div className="flex flex-wrap gap-x-4 type-provenance text-[var(--muted)]">
        <span>{member.name}&apos;s duo</span>
        {member.email && <span className="type-identifier break-all">{member.email}</span>}
        {member.joinedAt && (
          <span>
            Joined <Timestamp iso={member.joinedAt} />
          </span>
        )}
      </div>
      {isOrgAdmin && (
        <p className="type-provenance text-[var(--muted)]" data-testid="admin-member-appointed">
          Appointed{member.appointedByName ? ` by ${member.appointedByName}` : ""}
          {member.appointedAt && (
            <>
              {" "}
              on <DateLabel iso={member.appointedAt} />
            </>
          )}
        </p>
      )}
      {member.isRoot && <p className="type-provenance text-[var(--muted)]">The first duo on this server, made before invites existed.</p>}
      {member.superAdmin && (
        <p className="type-provenance text-[var(--muted)]">
          {isOrgAdmin ? "Also the super admin, who manages every org on this server." : "Manages every org on this server, and can't be changed from here."}
        </p>
      )}
      {isOrgAdmin && lastOrgAdminForOrgAdmin && (
        <p className="type-provenance text-[var(--muted)]" data-testid="admin-member-last">
          The org&apos;s last org admin. Only the super admin can remove them.
        </p>
      )}
      {!member.verified && (
        <p className="type-provenance text-[var(--muted)]" data-testid="admin-member-unverified-note">
          {member.name}&apos;s Google sign-in was never checked against an invite.
        </p>
      )}
      {member.verified && !member.answeringEnabled && (
        <p className="type-provenance text-[var(--muted)]" data-testid="admin-member-answering-revoked">
          Revoked{member.answeringRevokedByName ? ` by ${member.answeringRevokedByName}` : ""}
          {member.answeringRevokedAt && (
            <>
              {" "}
              on <DateLabel iso={member.answeringRevokedAt} />
            </>
          )}
          . {member.name}&apos;s duo still works for them, but can&apos;t answer colleagues until this is restored.
        </p>
      )}
      {member.orgAdminLog.length > 0 && (
        <details className="type-provenance text-[var(--muted)]" data-testid="admin-member-history">
          <summary className="inline-flex min-h-11 cursor-pointer items-center">History ({member.orgAdminLog.length})</summary>
          <ul className="flex flex-col gap-1 pb-1">
            {member.orgAdminLog.map((entry, index) => (
              <li data-testid="admin-member-history-entry" key={`${entry.at}-${index}`}>
                {entry.action === "grant" ? "Appointed" : "Revoked"}
                {entry.byName ? ` by ${entry.byName}` : ""} on <DateLabel iso={entry.at} />
              </li>
            ))}
          </ul>
        </details>
      )}
      {(canAppoint || canRevoke) && (
        <div className="flex flex-wrap gap-2 pt-1">
          {canAppoint && (
            <ConfirmChange
              confirmLabel={`Appoint ${member.name}`}
              description={`${member.name} will be able to see who is in ${orgName}, invite people into it, rename it, and appoint or revoke other org admins. In the chat they stay a normal member, with no extra power.`}
              disabled={busy}
              onClosed={onClosed}
              onConfirm={onAppoint}
              testId="admin-appoint"
              title={`Make ${member.name} an org admin?`}
              tone="appoint"
              triggerLabel="Appoint…"
              triggerName={`Appoint ${member.name} as an org admin…`}
            />
          )}
          {canRevoke && (
            <ConfirmChange
              confirmLabel={isSelf ? "Step down" : `Revoke ${member.name}`}
              description={
                isSelf
                  ? `You stay in ${orgName} as a normal member, but you can no longer manage it. This page closes and the Admin entry leaves your app.`
                  : `${member.name} stays in ${orgName} as a normal member, but can no longer manage it. Their Admin entry goes the next time their app checks.`
              }
              disabled={busy}
              onClosed={onClosed}
              onConfirm={onRevoke}
              testId="admin-revoke"
              title={isSelf ? "Step down as an org admin?" : `Revoke ${member.name} as an org admin?`}
              tone="revoke"
              triggerLabel={isSelf ? "Step down…" : "Revoke…"}
              triggerName={isSelf ? "Step down as an org admin…" : `Revoke ${member.name} as an org admin…`}
            />
          )}
        </div>
      )}
      {member.verified && answeringManageable && (
        <div className="flex flex-wrap gap-2 pt-1">
          {member.answeringEnabled ? (
            <ConfirmChange
              confirmLabel={`Revoke answering`}
              description={`${member.name}'s duo stops answering colleagues at once. It keeps working for ${member.name} themselves, and nothing it already answered is undone.`}
              disabled={answeringBusy}
              onClosed={onClosed}
              onConfirm={onRevokeAnswering}
              testId="admin-revoke-answering"
              title={`Stop ${member.name}'s duo answering colleagues?`}
              tone="revoke"
              triggerLabel="Revoke answering…"
              triggerName={`Stop ${member.name}'s duo from answering colleagues…`}
            />
          ) : (
            <ConfirmChange
              confirmLabel={`Restore answering`}
              description={`${member.name}'s duo can answer colleagues again, at once, within whatever limits ${member.name} has set.`}
              disabled={answeringBusy}
              onClosed={onClosed}
              onConfirm={onRestoreAnswering}
              testId="admin-restore-answering"
              title={`Let ${member.name}'s duo answer colleagues again?`}
              tone="appoint"
              triggerLabel="Restore answering…"
              triggerName={`Let ${member.name}'s duo answer colleagues again…`}
            />
          )}
        </div>
      )}
    </li>
  );
}

/**
 * The org's people, with the appoint and revoke controls. `scope` is the super admin's org (null for an org admin's
 * own). Results are announced in one polite region that is always on the page, and focus moves to the person's row
 * when a change is confirmed, because the button that opened the dialog turns into its opposite.
 */
function OrgPeople({
  api,
  emptyText,
  members,
  onRefused,
  onSteppedDown,
  orgId,
  orgName,
  scope,
  viewer,
}: {
  api: DuoApiConfig;
  emptyText: string;
  members: UseQueryResult<HostedOrgMember[]>;
  /** An org admin's own request was refused (no longer an org admin): the page becomes the "not for you" note. */
  onRefused?: () => void;
  /** An org admin revoked themselves. */
  onSteppedDown?: () => void;
  /** The org this list is of: keys an org admin's cached people, so a change of org never shows the old one's. */
  orgId: string;
  orgName: string;
  scope: OrgScope;
  viewer: "super" | "org";
}) {
  const change = useSetOrgAdmin(api, scope, orgId);
  const answering = useSetAnswering(api, scope, orgId);
  const [notice, setNotice] = useState<Notice | null>(null);
  const rows = Array.isArray(members.data) ? members.data : [];
  const selfId = viewer === "org" ? pairedDuoId(api) : null;
  const orgAdminCount = rows.filter((member) => member.orgRole === "org_admin").length;
  const rowElements = useRef(new Map<string, HTMLLIElement>());
  const inFlight = useRef(false);
  const answeringInFlight = useRef(false);

  /** duo#318: revokes or restores a member's answering — its own mutation and its own in-flight guard, parallel to `apply` above but with no step-down page swap to protect. */
  function applyAnswering(member: HostedOrgMember, enabled: boolean): void {
    if (answering.isPending || answeringInFlight.current) {
      return;
    }
    answeringInFlight.current = true;
    setNotice(null);
    answering.mutate(
      { duoId: member.duoId, enabled },
      {
        onSettled: () => {
          answeringInFlight.current = false;
        },
        onSuccess: ({ changed }) => {
          setNotice({
            tone: "ok",
            text: enabled
              ? changed
                ? `${member.name}'s duo can answer colleagues again.`
                : `${member.name}'s duo could already answer colleagues.`
              : changed
                ? `${member.name}'s duo no longer answers colleagues.`
                : `${member.name}'s duo already couldn't answer colleagues.`,
          });
        },
        onError: (error) => {
          if (viewer === "org" && error instanceof ApiRequestError && error.status === 403) {
            onRefused?.();
            return;
          }
          setNotice({
            tone: "error",
            text:
              knownRefusal(error) ??
              (error instanceof ApiRequestError && error.code === "not_found" ? `${member.name} isn't in ${orgName} any more. The list has been refreshed.` : error.message),
          });
        },
      },
    );
  }

  function apply(member: HostedOrgMember, appoint: boolean): void {
    // One mutation serves the whole list: a second confirm while one is in flight would replace its callbacks (a step-down would lose its page swap). The ref covers two clicks in one render, before `isPending` has shown.
    if (change.isPending || inFlight.current) {
      return;
    }
    inFlight.current = true;
    setNotice(null);
    change.mutate(
      { duoId: member.duoId, appoint },
      {
        onSettled: () => {
          inFlight.current = false;
        },
        onSuccess: ({ changed }) => {
          if (!appoint && member.duoId === selfId) {
            onSteppedDown?.();
            return;
          }
          setNotice({
            tone: "ok",
            text: appoint
              ? changed
                ? `${member.name} is now an org admin of ${orgName}.`
                : `${member.name} was already an org admin.`
              : changed
                ? `${member.name} is no longer an org admin. They stay in ${orgName} as a member.`
                : `${member.name} was not an org admin.`,
          });
        },
        onError: (error) => {
          if (viewer === "org" && error instanceof ApiRequestError && error.status === 403) {
            onRefused?.();
            return;
          }
          setNotice({
            tone: "error",
            text:
              knownRefusal(error) ??
              (error instanceof ApiRequestError && error.code === "not_found" ? `${member.name} isn't in ${orgName} any more. The list has been refreshed.` : error.message),
          });
        },
      },
    );
  }

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
            <MemberRow
              answeringBusy={answering.isPending}
              busy={change.isPending}
              isSelf={member.duoId === selfId}
              key={member.duoId}
              lastOrgAdminForOrgAdmin={viewer === "org" && member.orgRole === "org_admin" && orgAdminCount <= 1}
              member={member}
              onAppoint={() => apply(member, true)}
              onClosed={() => rowElements.current.get(member.duoId)?.focus()}
              onRevoke={() => apply(member, false)}
              onRevokeAnswering={() => applyAnswering(member, false)}
              onRestoreAnswering={() => applyAnswering(member, true)}
              orgName={orgName}
              rowRef={(element) => {
                if (element) {
                  rowElements.current.set(member.duoId, element);
                } else {
                  rowElements.current.delete(member.duoId);
                }
              }}
              viewer={viewer}
            />
          ))}
        </ul>
      ) : (
        <p className="type-provenance text-[var(--muted)]" data-testid="admin-members-empty">
          {emptyText}
        </p>
      )}
      {/* Always on the page, so what a change did is read out however the list moved. */}
      <div aria-live="polite" data-testid="admin-people-notice" role="status">
        {notice && <p className={`type-body ${notice.tone === "error" ? "text-[var(--refused)]" : ""}`}>{notice.text}</p>}
      </div>
    </section>
  );
}

function RenameOrg({ api, name: current, scope }: { api: DuoApiConfig; name: string; scope: OrgScope }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(current);
  const rename = useRenameOrg(api, scope);
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
          setName(current);
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
            rename.mutate(trimmed, { onSuccess: () => setEditing(false) });
          }
        }}
      >
        <label className="flex min-w-0 flex-col gap-1 type-body">
          New name
          <input className={field} onChange={(e) => setName(e.target.value)} ref={inputRef} value={name} />
        </label>
        <button className={primaryButton} disabled={rename.isPending || trimmed.length === 0 || trimmed === current} type="submit">
          {rename.isPending ? "Saving…" : "Save name"}
        </button>
        <button className={quietButton} onClick={() => setEditing(false)} type="button">
          Cancel
        </button>
      </form>
      {/* An org admin's route must not say which org has a name; the super admin sees every org's name, so the daemon's own words tell them more. */}
      <MutationError error={scope === null ? friendlyError(rename.error) : rename.error} />
    </div>
  );
}

/** One invite link into this org, shown once. An email locks it to that Google account. */
function InviteIntoOrg({ api, orgId, orgName, scope }: { api: DuoApiConfig; orgId: string; orgName: string; scope: OrgScope }) {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const create = useInviteIntoOrg(api, scope, orgId);
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
      <h2 className="type-heading">Invite someone into {orgName}</h2>
      <p className="type-provenance text-[var(--muted)]">
        The link lets one person create a duo of their own and join this org. Whoever opens it first uses it up.
      </p>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (trimmed && emailValid && !create.isPending) {
            create.mutate(
              { name: trimmed, ...(email.trim() ? { email: email.trim() } : {}) },
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
            {minted.name}&apos;s invite to {orgName}
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
      <MutationError error={friendlyError(create.error)} />
    </section>
  );
}

/** The super admin's page for an org that exists. Its people are asked for only now, so an address the list doesn't confirm never reaches the daemon. */
function OrgBody({ api, back, org, origin }: { api: DuoApiConfig; back: ReactNode; org: HostedOrg; origin: string }) {
  const members = useHostedOrgMembers(origin, api, org.id);
  if (isNotAdmin(members.error)) {
    return <NotAvailable />;
  }
  const scope = { origin, orgId: org.id };
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
        <RenameOrg api={api} name={org.name} scope={scope} />
      </header>
      <OrgPeople api={api} emptyText="No one has joined yet. Send an invite link below." members={members} orgId={org.id} orgName={org.name} scope={scope} viewer="super" />
      <InviteIntoOrg api={api} key={org.id} orgId={org.id} orgName={org.name} scope={scope} />
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

/** This org's invites that no one has used yet. Never the code: that was shown once, when it was made. */
function PendingInvites({ invites }: { invites: UseQueryResult<OrgPendingInvite[]> }) {
  const rows = Array.isArray(invites.data) ? invites.data : [];
  return (
    <section className="flex flex-col gap-3" data-testid="admin-pending-invites">
      <h2 className="type-heading">Pending invites</h2>
      {invites.isLoading ? (
        <p className="type-provenance text-[var(--muted)]" role="status">
          Loading invites…
        </p>
      ) : invites.error ? (
        <div className="flex flex-wrap items-center gap-3">
          <p className="type-provenance text-[var(--refused)]" data-testid="admin-invites-error" role="alert">
            {invites.error instanceof Error ? invites.error.message : "The server could not list this org's invites."}
          </p>
          <button className={quietButton} data-testid="admin-invites-retry" onClick={() => void invites.refetch()} type="button">
            Try again
          </button>
        </div>
      ) : rows.length > 0 ? (
        <ul className="flex flex-col gap-2">
          {rows.map((invite) => (
            <li className="shape-entry flex flex-col gap-1 px-4 py-3" data-testid="admin-pending-invite" key={invite.id}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="type-body">{invite.name}</span>
                {invite.email && <span className="type-identifier break-all text-[var(--muted)]">{invite.email}</span>}
              </div>
              <p className="type-provenance text-[var(--muted)]">
                Created <Timestamp iso={invite.createdAt} /> · expires <Timestamp iso={invite.expiresAt} />
              </p>
            </li>
          ))}
        </ul>
      ) : (
        <p className="type-provenance text-[var(--muted)]" data-testid="admin-pending-invites-empty">
          No invites waiting. A link you create shows here until someone uses it.
        </p>
      )}
    </section>
  );
}

/** An org admin's page for their own org, once the daemon has said they are one. */
function OwnOrgBody({ api, name, onSteppedDown, orgId }: { api: DuoApiConfig; name: string; onSteppedDown: () => void; orgId: string }) {
  const queryClient = useQueryClient();
  const members = useOwnOrgMembers(api, orgId);
  const invites = useOwnOrgInvites(api, orgId);
  const [refused, setRefused] = useState(false);
  if (isNotAdmin(members.error) || isNotAdmin(invites.error) || refused) {
    return <NotAvailable />;
  }
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6" data-testid="admin-org-page">
      <header className="flex flex-col gap-2">
        <h1 className="type-heading" data-testid="admin-org-name">
          {name}
        </h1>
        <p className="type-provenance text-[var(--muted)]">You&apos;re an org admin here. You and the org&apos;s other org admins manage it, and so does the super admin.</p>
        <RenameOrg api={api} name={name} scope={null} />
      </header>
      <OrgPeople
        api={api}
        emptyText="No one has joined yet. Send an invite link below."
        members={members}
        onRefused={() => {
          setRefused(true);
          void queryClient.invalidateQueries({ queryKey: queryKeys.orgOverview });
        }}
        onSteppedDown={onSteppedDown}
        orgId={orgId}
        orgName={name}
        scope={null}
        viewer="org"
      />
      <PendingInvites invites={invites} />
      <InviteIntoOrg api={api} orgId={orgId} orgName={name} scope={null} />
    </div>
  );
}

/**
 * An org admin's admin page: their own org and nothing else, whatever the address says (`#admin/<other>` is this
 * page too, and asks nothing about that id). The org and the role come from the daemon's answer for this duo, and the
 * page is drawn only while it says org admin, so a role taken away while the page is open ends it on the next answer.
 * Keyed by the org's id, so a different org starts from a clean page (no invite link made for the other one).
 */
function OwnOrgPage({ api, onSteppedDown }: { api: DuoApiConfig; onSteppedDown: (orgName: string) => void }) {
  const overview = useOrgOverview(api, true);
  if (overview.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  // A 401 (the revocation guard unpairs the app) outranks an earlier answer still in the cache; a failure to get any answer does not.
  if (isNotAdmin(overview.error)) {
    return <NotAvailable />;
  }
  if (overview.error && !overview.data) {
    return <RouteError api={api} error={overview.error} onRetry={() => void overview.refetch()} />;
  }
  const answer = overview.data;
  // "No org" and "not yours" are answers (`{ none: true }`), and outrank whatever the person was doing here.
  if (!answer || "none" in answer || answer.role !== "org_admin") {
    return <NotAvailable />;
  }
  return <OwnOrgBody api={api} key={answer.org.id} name={answer.org.name} onSteppedDown={() => onSteppedDown(answer.org.name)} orgId={answer.org.id} />;
}

/** After stepping down: the page is gone and the entry follows, so say so, plainly, where the person is looking. */
function SteppedDown({ orgName }: { orgName: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    ref.current?.focus();
  }, []);
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-3 p-6" data-testid="admin-stepped-down" ref={ref} role="status" tabIndex={-1}>
      <h1 className="type-heading">You&apos;re no longer an org admin</h1>
      <p className="type-body text-[var(--muted)]">
        You&apos;re still a member of {orgName}, and your duo is unchanged. The Admin entry leaves your app. To manage the org again, another org admin or the super admin can appoint you.
      </p>
      <a className="inline-flex min-h-11 items-center self-start type-body text-[var(--muted)]" href="#chats">
        Back to your chats
      </a>
    </div>
  );
}

/**
 * `origin` is null when this browser isn't signed in to a hosted server as an admin, and `role` is the admin
 * screens this person may open (`adminRoleOf`) — either missing is the same "not for you" answer as a 403,
 * without a request. A super admin's `orgId` opens one org (`#admin/<id>`); without it, the list. An org
 * admin has one org, so the address adds nothing for them.
 */
export function Admin({ api, origin, orgId, role }: { api: DuoApiConfig; origin: string | null; orgId: string | null; role: AdminRole }) {
  // Kept here, above the role: stepping down ends the role, and the page that noticed must not vanish before saying so.
  const [steppedDownFrom, setSteppedDownFrom] = useState<string | null>(null);
  if (steppedDownFrom !== null) {
    return <SteppedDown orgName={steppedDownFrom} />;
  }
  if (!origin || !role) {
    return <NotAvailable />;
  }
  if (role === "org") {
    return <OwnOrgPage api={api} onSteppedDown={setSteppedDownFrom} />;
  }
  // Keyed by the id: a hand-edited address from one org to another must not carry the first org's state (a minted invite link) into the second.
  return orgId ? <OrgPage api={api} key={orgId} orgId={orgId} origin={origin} /> : <OrgList api={api} origin={origin} />;
}
