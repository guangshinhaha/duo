import { configuredDaemonOrigin } from "../api/hosted.js";

/**
 * #127: how this device gets its workspace session.
 *
 * - `manual`: a personal daemon. The member types a homeserver, username and
 *   password (`WorkspaceSignInForm`) — the door that has always been here.
 * - `hosted-pending`: a hosted build (`VITE_DUO_DAEMON_URL` set). The
 *   homeserver is the operator's business, so the form is never shown; the
 *   workspace is meant to connect by itself after Google sign-in, which
 *   isn't wired yet — until then the surfaces say it isn't set up.
 *
 * SEAM for the auto-connect half of #127 (blocked on digital-duo#233, the
 * daemon route that hands a signed-in duo its Matrix session): this is where
 * it plugs in. It will add `connecting` / `connected` / `failed` states here,
 * fetch the session from the daemon and hand it to `useWorkspaceSession`'s
 * setter (refreshing on expiry, clearing on sign out). Callers only branch on
 * `kind`, so none of them change when that lands.
 */
export type WorkspaceAccess = { kind: "manual" } | { kind: "hosted-pending" };

/** Read per call, not at module load, so a test can stub the env. */
export function useWorkspaceAccess(): WorkspaceAccess {
  return configuredDaemonOrigin() ? { kind: "hosted-pending" } : { kind: "manual" };
}
