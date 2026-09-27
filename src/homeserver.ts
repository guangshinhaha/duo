/**
 * The one rule for a workspace address, whichever door it came through (the
 * form a member types into, or the answer of a hosted daemon): https only, and
 * the origin is what is used. The token rides this address — on every sync and
 * on the logout — so plaintext is not a configuration, it's a leak, and
 * connecting and signing out must name the same base URL.
 *
 * Kept in its own file, outside both `src/api` and `src/workspace` (which must
 * not reach each other), so the hosted door can use it without pulling the
 * Matrix SDK into the main bundle; `matrix.ts` re-exports it.
 */
export function normalizeHomeserverUrl(raw: string): string {
  const url = new URL(raw.trim());
  if (url.protocol !== "https:") {
    // The platform record's own rule for workspace URLs, mirrored from the
    // core's settings validation: the token rides this URL, so plaintext is
    // not a configuration, it's a leak.
    throw new Error(`The workspace address must start with https — sign-in details travel it in the clear otherwise (got ${JSON.stringify(url.protocol)}).`);
  }
  return url.origin;
}
