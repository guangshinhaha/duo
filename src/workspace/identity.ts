/**
 * #62: the workspace's user-id grammar, mirrored from the core's
 * identity/directory module (digital-duo #187, `src/workspace/directory.ts`):
 * a duo's Matrix user id is `@duo-<owner-localpart>:<server>` beside the
 * owner's `@<owner-localpart>:<server>`, and the derivation is a bijection on
 * user ids by construction — two owners cannot contest one duo, one duo
 * cannot belong to two people. Attribution in the client renders from this
 * STRUCTURE, never from display names: a display name is a profile's claim
 * about itself (self-service on Matrix, spoofable), while the `duo-`
 * localpart namespace is reserved by the convention.
 */

/** The localpart prefix that marks a Matrix user as a duo (workspace-platform record §6). */
export const DUO_LOCALPART_PREFIX = "duo-";

/** The shaped id this module derives over: `@localpart:server` with both parts non-empty. */
const USER_ID_PATTERN = /^@([^:]+):(.+)$/;
/** The looser form localpart extraction keys off: `@localpart:` with any (even empty) tail. */
const LOCALPART_PATTERN = /^@([^:]+):/;

/**
 * The localpart of a Matrix user id — `@alice:workspace` → `alice`. Anything
 * unshapely is returned unchanged so it fails to resolve downstream rather
 * than crashing the render — the same safe default the core's grammar takes.
 */
export function localpartOf(userId: string): string {
  const match = LOCALPART_PATTERN.exec(userId);
  return match ? match[1]! : userId;
}

/** Whether a Matrix user id is duo-shaped under the platform record's convention (`@duo-…:…`). */
export function isDuoUserId(userId: string): boolean {
  return duoOwnerUserIdOf(userId) !== null;
}

/**
 * The duo user id the convention assigns a person: `@alice:workspace` →
 * `@duo-alice:workspace`. Null when the id isn't `@local:server` shaped —
 * nothing to derive from.
 */
export function duoUserIdFor(personUserId: string): string | null {
  const match = USER_ID_PATTERN.exec(personUserId);
  return match ? `@${DUO_LOCALPART_PREFIX}${match[1]}:${match[2]}` : null;
}

/**
 * The owner user id a duo-shaped id points back at: `@duo-alice:workspace` →
 * `@alice:workspace`. Null for non-duo-shaped or unshapely ids.
 */
export function duoOwnerUserIdOf(duoUserId: string): string | null {
  const match = USER_ID_PATTERN.exec(duoUserId);
  if (!match || !match[1]!.startsWith(DUO_LOCALPART_PREFIX)) {
    return null;
  }
  return `@${match[1]!.slice(DUO_LOCALPART_PREFIX.length)}:${match[2]}`;
}

/**
 * The attribution label a duo-shaped sender renders with — the owner's
 * localpart (`@duo-carol:…` → "carol"), the structural fact behind
 * "carol's duo". Null for a plain person: the caller renders those by their
 * own name, and must not lean on this helper for them.
 */
export function duoOwnerLabel(duoUserId: string): string | null {
  const owner = duoOwnerUserIdOf(duoUserId);
  return owner === null ? null : localpartOf(owner);
}

/**
 * The homeserver part of a Matrix user id — `@alice:acme.example` →
 * "acme.example". This client's organisation boundary IS the homeserver
 * (one org, one homeserver, the ratified platform decision core PR #194
 * records; #235's org wall is federation refusing a foreign one) — so this
 * is the fact a person's "org" means, never a claim a profile makes about
 * itself. Empty for an unshapely id.
 */
export function serverNameOf(userId: string): string {
  const match = USER_ID_PATTERN.exec(userId);
  return match ? match[2]! : "";
}

/**
 * How a directory entry reads, wherever the workspace's people search
 * surfaces (the pencil dialog, #63; the one search box, #207): a duo by its
 * owner, from the id's grammar — "carol's duo" — never by the display name
 * it chose; a person by their name.
 */
export function directoryEntryLabel(entry: { readonly userId: string; readonly name: string }): string {
  if (isDuoUserId(entry.userId)) {
    return `${duoOwnerLabel(entry.userId) ?? localpartOf(entry.userId)}'s duo`;
  }
  return entry.name;
}
