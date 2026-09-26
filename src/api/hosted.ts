import { ApiRequestError, type DuoApiConfig } from "./client.js";
import type { ApiError, HostedConfig, HostedSignupResult } from "./types.js";

/**
 * Invite-only hosted mode (digital-duo's hosted daemon): one daemon origin
 * serves many people's duos, each under its own path segment. An invite link the
 * operator sends — `#join?host=<encoded daemon origin>&invite=<code>` —
 * signs its holder up for a duo of their own and pairs this browser to it.
 *
 * Hash, not query string, for the same reason the ask link uses one: the
 * invite code is a credential until it is spent, and a fragment never rides
 * along in a `Referer`.
 */
export interface JoinInvite {
  /** The daemon's origin, e.g. `https://duo-daemon-production.up.railway.app`. */
  readonly host: string;
  readonly invite: string;
}

/** Reads `#join?host=…&invite=…`; null when the hash isn't a join link or lacks either half. */
export function parseJoinHash(hash: string): JoinInvite | null {
  if (!hash.startsWith("#join")) {
    return null;
  }
  const query = hash.slice("#join".length).replace(/^\?/, "");
  const params = new URLSearchParams(query);
  const host = params.get("host")?.trim().replace(/\/+$/, "");
  const invite = params.get("invite")?.trim();
  if (!host || !invite) {
    return null;
  }
  try {
    const parsed = new URL(host);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return null;
    }
  } catch {
    return null;
  }
  return { host, invite };
}

// The invite shapes live here, not in types.ts: they carry a Google
// account's address (`email`), which the channel-vocabulary lint rule
// (eslint.config.js) only admits in the hosted account layer.
/** A row of `GET {origin}/hosted/invites` (admin only). The code itself is never listed — it exists only in the create answer. */
export interface HostedInviteRow {
  readonly id: string;
  readonly name: string;
  /** When set, only a sign-in with this email can use the invite. */
  readonly email: string | null;
  readonly createdAt: string;
  readonly expiresAt: string;
  readonly usedAt: string | null;
  readonly tenantId: string | null;
}

/** `POST {origin}/hosted/invites` — the only time the invite code (and its link) is ever shown. */
export interface MintedHostedInvite {
  readonly id: string;
  readonly name: string;
  readonly email: string | null;
  readonly expiresAt: string;
  readonly code: string;
  /** Null when the server doesn't know its own public and web URLs — then the code is all there is to hand over. */
  readonly link: string | null;
}

/** `POST {origin}/hosted/invites` body. */
export interface CreateInviteInput {
  readonly name: string;
  /** Locks the invite to this Google account's address. */
  readonly email?: string;
  readonly expiresInHours?: number;
}

/** Reads a daemon answer the way `apiRequest` does: a non-2xx body becomes an `ApiRequestError` with the daemon's own code. */
async function readAnswer<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let body: ApiError | undefined;
    try {
      body = (await response.json()) as ApiError;
    } catch {
      body = undefined;
    }
    throw new ApiRequestError(response.status, body);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return (await response.json()) as T;
}

function postJson(url: string, body: unknown, token?: string): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
}

/** The pairing a sign-in or sign-up answer amounts to: the daemon origin plus the duo's path, and the new device's token. */
function configFor(origin: string, result: HostedSignupResult): DuoApiConfig {
  return { baseUrl: `${origin}${result.basePath}`, token: result.token };
}

/**
 * The hosted daemon's origin this build was made for (`VITE_DUO_DAEMON_URL`),
 * trailing slash dropped — or null, in which case the app asks for an
 * address on Setup exactly as before hosted mode existed. Read per call, not
 * at module load, so a test can stub the env.
 */
export function configuredDaemonOrigin(): string | null {
  const raw = import.meta.env.VITE_DUO_DAEMON_URL?.trim();
  if (!raw) {
    return null;
  }
  try {
    return new URL(raw).origin;
  } catch {
    return null;
  }
}

/** `GET {origin}/hosted/config` — whether this server signs people in with Google, and as which app. */
export async function fetchHostedConfig(origin: string): Promise<HostedConfig> {
  return readAnswer<HostedConfig>(await fetch(`${origin}/hosted/config`));
}

/**
 * `POST {origin}/hosted/login` — a Google sign-in's ID token in, this
 * account's duo and a fresh device token out (each browser signing in is
 * its own revocable device). `no_duo` means the account has never joined.
 */
export async function logIn(origin: string, credential: string): Promise<{ config: DuoApiConfig; result: HostedSignupResult }> {
  const result = await readAnswer<HostedSignupResult>(await postJson(`${origin}/hosted/login`, { credential }));
  return { config: configFor(origin, result), result };
}

/**
 * `POST {host}/hosted/signup` — spends the invite, creates the duo, and
 * answers the first device token (shown once). No Authorization header:
 * the invite code (and, on a server with sign-in, the Google credential)
 * is the credential. Errors travel as `ApiRequestError` with the daemon's
 * own code (`invite_invalid`, `already_has_duo`, `invite_wrong_account`),
 * and a network failure stays a TypeError, as everywhere else in this client.
 */
export async function signUp(
  invite: JoinInvite,
  who: { name: string } | { credential: string },
): Promise<{ config: DuoApiConfig; result: HostedSignupResult }> {
  const result = await readAnswer<HostedSignupResult>(await postJson(`${invite.host}/hosted/signup`, { invite: invite.invite, ...who }));
  return { config: configFor(invite.host, result), result };
}

/** `GET {origin}/hosted/invites` — admin only; the admin's own device token is the credential. */
export async function listInvites(origin: string, token: string): Promise<HostedInviteRow[]> {
  return readAnswer<HostedInviteRow[]>(await fetch(`${origin}/hosted/invites`, { headers: { Authorization: `Bearer ${token}` } }));
}

/** `POST {origin}/hosted/invites` — the answer carries the code and link, once. */
export async function createInvite(
  origin: string,
  token: string,
  input: CreateInviteInput,
): Promise<MintedHostedInvite> {
  return readAnswer<MintedHostedInvite>(await postJson(`${origin}/hosted/invites`, input, token));
}

/**
 * Who this browser is signed in as on a hosted server — the name and admin
 * flag the sign-in answer carried, beside the stored connection. Per-device
 * convenience only, like the connection itself; the daemon re-checks admin
 * rights on every invite call, so this only decides what Settings shows.
 */
export interface HostedAccount {
  readonly origin: string;
  readonly ownerName: string;
  readonly isAdmin: boolean;
}

const ACCOUNT_KEY = "duo.hosted-account";

export function readHostedAccount(): HostedAccount | null {
  try {
    const raw = localStorage.getItem(ACCOUNT_KEY);
    return raw ? (JSON.parse(raw) as HostedAccount) : null;
  } catch {
    return null;
  }
}

export function writeHostedAccount(account: HostedAccount | null): void {
  try {
    if (account) {
      localStorage.setItem(ACCOUNT_KEY, JSON.stringify(account));
    } else {
      localStorage.removeItem(ACCOUNT_KEY);
    }
  } catch {
    // Blocked storage: Settings just won't show admin tools until next sign-in.
  }
}

/** The account record a sign-in or sign-up answer amounts to. */
export function accountFor(origin: string, result: HostedSignupResult): HostedAccount {
  return { origin, ownerName: result.ownerName, isAdmin: result.isAdmin === true };
}
