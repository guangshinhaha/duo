import { ApiRequestError, type DuoApiConfig } from "./client.js";
import type { ApiError, HostedSignupResult } from "./types.js";

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

/**
 * `POST {host}/hosted/signup` — spends the invite, creates the duo, and
 * answers the first device token (shown once). No Authorization header:
 * the invite code is the credential. Errors travel as `ApiRequestError`
 * with the daemon's own code (`invite_invalid`, `bad_request`), and a
 * network failure stays a TypeError, as everywhere else in this client.
 */
export async function signUp(invite: JoinInvite, name: string): Promise<{ config: DuoApiConfig; result: HostedSignupResult }> {
  const response = await fetch(`${invite.host}/hosted/signup`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ invite: invite.invite, name }),
  });
  if (!response.ok) {
    let body: ApiError | undefined;
    try {
      body = (await response.json()) as ApiError;
    } catch {
      body = undefined;
    }
    throw new ApiRequestError(response.status, body);
  }
  const result = (await response.json()) as HostedSignupResult;
  return { config: { baseUrl: `${invite.host}${result.basePath}`, token: result.token }, result };
}
