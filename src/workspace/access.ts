import { createContext, createElement, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { DuoApiConfig } from "../api/client.js";
import {
  configuredDaemonOrigin,
  fetchWorkspaceSession,
  pairedHostedAccount,
  readHostedAccount,
  revokeWorkspaceSession,
  WorkspaceSessionError,
  type HostedWorkspaceSession,
} from "../api/hosted.js";
import type { WorkspaceSession } from "./matrix.js";

/**
 * #127: how this device gets its workspace session.
 *
 * - `manual`: a personal daemon. The member types a homeserver, username and
 *   password (`WorkspaceSignInForm`) — the door that has always been here.
 * - `hosted-*`: a hosted build (`VITE_DUO_DAEMON_URL` set) whose device is
 *   signed in to a hosted account. The workspace is the operator's business,
 *   so the form is never shown; after Google sign-in the app asks the daemon
 *   for the person's own session and connects with it (`useHostedWorkspace`).
 *   The kinds say where that has got to:
 *     connecting      asking the daemon
 *     connected       a session is in hand (the connection itself follows)
 *     not-set-up      the operator has not set a workspace up (404), or this
 *                     account has none to give — nothing to do, nothing to retry
 *     retrying        the workspace is not ready (`pending`: the person's
 *                     account is still being made) or not reachable
 *                     (`unreachable`); the app tries again by itself
 *     signed-out      the daemon no longer knows this device (401)
 *
 * A hosted build's Advanced "connect by address" door pairs a personal
 * daemon and clears the hosted account (`connectManually`); that device is
 * `manual` again, form and all (#127 AC4). So Conversations and Settings
 * read the account as well as the build flag. The front door (`Setup`)
 * reads the flag alone (`isHostedBuild`): nobody has signed in there yet.
 */
export type WorkspaceAccess =
  | { kind: "manual" }
  | { kind: "hosted-connecting" }
  | { kind: "hosted-connected" }
  | { kind: "hosted-not-set-up" }
  | { kind: "hosted-retrying"; why: "pending" | "unreachable" }
  | { kind: "hosted-signed-out" };

/** True for every hosted kind: the homeserver form is never offered. */
export function isHostedAccess(access: WorkspaceAccess): boolean {
  return access.kind !== "manual";
}

/** What a hosted build with a hosted account amounts to when nothing is fetching (a surface rendered on its own): the form stays hidden. */
function staticAccess(): WorkspaceAccess {
  return isHostedBuild() && readHostedAccount() ? { kind: "hosted-connecting" } : { kind: "manual" };
}

const WorkspaceAccessContext = createContext<WorkspaceAccess | null>(null);

/** The one place the hosted session is fetched (`AppShell`); every surface below reads what it found. */
export function WorkspaceAccessProvider({ access, children }: { access: WorkspaceAccess; children: ReactNode }) {
  return createElement(WorkspaceAccessContext.Provider, { value: access }, children);
}

/** Read per call, not at module load, so a test can stub the env. */
export function useWorkspaceAccess(): WorkspaceAccess {
  const provided = useContext(WorkspaceAccessContext);
  return provided ?? staticAccess();
}

/** True when this build was made for a hosted server, signed in or not. */
export function isHostedBuild(): boolean {
  return configuredDaemonOrigin() !== null;
}

// ─── the hosted session ─────────────────────────────────────────────────────

/** Ask again this long before the session's `expiresAt` (the daemon says: within an hour). */
const REFRESH_LEAD_MS = 60 * 60 * 1000;
/** Never re-ask sooner than this because of an expiry — a session that is already near its end must not become a request loop. */
const MIN_REFRESH_MS = 30_000;
/** A timer's ceiling (a 32-bit signed millisecond count). */
const MAX_TIMER_MS = 2_147_483_647;
/** The daemon's own advice when it does not say (`Retry-After: 60`). */
const DEFAULT_RETRY_MS = 60_000;
/** A 429 is a per-address limiter measured in minutes: waiting a minute again would only be counted against it. */
const RATE_LIMITED_RETRY_MS = 5 * 60_000;
/** Retries on a network failure: 5s, 10s, 20s, 40s, then a minute — never faster than that. */
const BACKOFF_START_MS = 5_000;
const BACKOFF_CEILING_MS = 60_000;
/**
 * The workspace refused the credential just handed out. The daemon checks a
 * cached credential against the workspace at most once per 5 seconds, so a
 * person who signed out and in again inside that window can be handed the
 * credential they just signed out: the first refusal asks again at once (a new
 * one, usually), the second waits out that window, and after that it is a
 * minute — a loop can never mint faster than that.
 */
const REJECTION_DELAYS_MS = [0, 6_000];

/** How the connection held by the app went — what `report` is told. */
export type ConnectionOutcome = "up" | "rejected" | "failed";

export interface HostedWorkspace {
  readonly access: WorkspaceAccess;
  /** This device's session, in memory only — null until the daemon has answered, and whenever the account is not the paired one. */
  readonly session: WorkspaceSession | null;
  /** Changes whenever the connection must be made again (a first session, a credential that stopped working); a routine renewal does not change it. */
  readonly reconnectKey: number;
  /** The app says how connecting with `session` went, so a refusal is answered with a fresh session and a failure is tried again. */
  report(outcome: ConnectionOutcome): void;
  /** Ends the session at the workspace, then forgets it. The existing sign-out (`setApi(null)`) calls it. */
  signOut(): void;
}

interface Held {
  readonly session: WorkspaceSession;
  readonly expiresAt: string;
}

type Phase = "connecting" | "ready" | "not-set-up" | "pending" | "unreachable" | "signed-out";

function workspaceSessionOf(fresh: HostedWorkspaceSession): WorkspaceSession {
  return { homeserverUrl: fresh.homeserverUrl, userId: fresh.userId, accessToken: fresh.accessToken, deviceId: fresh.deviceId };
}

/** How long until the next routine renewal: an hour before expiry, never sooner than `MIN_REFRESH_MS`, and a sane time when `expiresAt` is unreadable. */
export function refreshDelayMs(expiresAt: string, now: number): number {
  const at = Date.parse(expiresAt);
  const wait = Number.isNaN(at) ? 30 * 60_000 : at - REFRESH_LEAD_MS - now;
  return Math.min(Math.max(wait, MIN_REFRESH_MS), MAX_TIMER_MS);
}

/**
 * #127: after Google sign-in, the workspace connects by itself. For a hosted
 * build with a signed-in hosted account this asks the paired daemon for the
 * person's own workspace session, keeps it in MEMORY ONLY (never localStorage,
 * IndexedDB or the query cache: a reload asks again), and renews it about an
 * hour before it expires. The device token that authorises the ask goes to the
 * paired daemon's origin and to no other (`pairedHostedAccount`).
 *
 * Called once, by `AppShell`. `onUnauthorized` is the daemon saying it no
 * longer knows this device (401) — the shell answers as it does for any
 * revoked device.
 */
export function useHostedWorkspace(api: DuoApiConfig | null, onUnauthorized: () => void): HostedWorkspace {
  const account = isHostedBuild() ? pairedHostedAccount(api) : null;
  const origin = account && api ? account.origin : null;
  const token = origin && api ? api.token : null;
  // The account record decides whether this is a hosted device at all, even
  // when the paired origin does not match it (then nothing is ever sent).
  const hostedDevice = isHostedBuild() && readHostedAccount() !== null;

  const [state, setState] = useState<{ owner: string; phase: Phase; held: Held | null; reconnectKey: number }>({
    owner: "",
    phase: "connecting",
    held: null,
    reconnectKey: 0,
  });
  const ownerId = origin && token ? `${origin}\n${token}` : "";

  const heldRef = useRef<Held | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const needsReconnectRef = useRef(false);
  const rejectionsRef = useRef(0);
  const failuresRef = useRef(0);
  const loadRef = useRef<(() => void) | null>(null);
  const onUnauthorizedRef = useRef(onUnauthorized);
  onUnauthorizedRef.current = onUnauthorized;
  const reconnectCounterRef = useRef(0);

  const releaseHeld = useCallback((): void => {
    const held = heldRef.current;
    heldRef.current = null;
    if (held) {
      void revokeWorkspaceSession(held.session);
    }
  }, []);

  useEffect(() => {
    // A session held for another account or server (or for none any more) is
    // not this one's: end it at the workspace and forget it. This is not a
    // cleanup function on purpose — unmounting the app is not signing out.
    releaseHeld();
    needsReconnectRef.current = false;
    rejectionsRef.current = 0;
    failuresRef.current = 0;
    if (!origin || !token) {
      loadRef.current = null;
      setState((current) => (current.owner === "" && current.held === null ? current : { owner: "", phase: "connecting", held: null, reconnectKey: current.reconnectKey }));
      return;
    }
    let cancelled = false;
    let busy = false;
    const controller = new AbortController();
    const schedule = (ms: number): void => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
      }
      timerRef.current = setTimeout(() => void load(), Math.min(ms, MAX_TIMER_MS));
    };
    const settle = (phase: Phase, held: Held | null, reconnect: boolean): void => {
      if (reconnect) {
        reconnectCounterRef.current += 1;
      }
      setState({ owner: ownerId, phase, held, reconnectKey: reconnectCounterRef.current });
    };
    const load = async (): Promise<void> => {
      if (cancelled || busy) {
        return;
      }
      busy = true;
      try {
        const fresh = await fetchWorkspaceSession(origin, token, controller.signal);
        if (cancelled) {
          return;
        }
        failuresRef.current = 0;
        const session = workspaceSessionOf(fresh);
        const first = heldRef.current === null;
        const reconnect = first || needsReconnectRef.current;
        needsReconnectRef.current = false;
        const held: Held = { session, expiresAt: fresh.expiresAt };
        heldRef.current = held;
        settle("ready", held, reconnect);
        schedule(refreshDelayMs(fresh.expiresAt, Date.now()));
      } catch (error) {
        if (cancelled) {
          return;
        }
        // A connection that is up is left alone while a renewal is retried;
        // one that is not shows what is wrong instead.
        const connectionDown = heldRef.current === null || needsReconnectRef.current;
        if (error instanceof WorkspaceSessionError) {
          if (error.status === 401) {
            settle("signed-out", null, false);
            onUnauthorizedRef.current();
            return;
          }
          if (error.status === 404 || error.status === 403) {
            // Not set up (or no account to give): the feature is hidden, not retried.
            if (connectionDown) {
              settle("not-set-up", heldRef.current, false);
            } else {
              schedule(DEFAULT_RETRY_MS);
            }
            return;
          }
          if (connectionDown) {
            settle(error.code === "workspace_pending" ? "pending" : "unreachable", heldRef.current, false);
          }
          schedule(error.retryAfterMs ?? (error.status === 429 ? RATE_LIMITED_RETRY_MS : DEFAULT_RETRY_MS));
          return;
        }
        // A network failure, a timeout, an answer that is not the documented shape.
        if (connectionDown) {
          settle("unreachable", heldRef.current, false);
        }
        schedule(Math.min(BACKOFF_START_MS * 2 ** failuresRef.current, BACKOFF_CEILING_MS));
        failuresRef.current += 1;
      } finally {
        busy = false;
      }
    };
    loadRef.current = () => void load();
    void load();
    return () => {
      cancelled = true;
      controller.abort();
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      loadRef.current = null;
    };
    // The credential is the identity: a different account or server starts over.
  }, [origin, token, ownerId, releaseHeld]);

  const report = useCallback((outcome: ConnectionOutcome): void => {
    if (!heldRef.current || !loadRef.current) {
      return;
    }
    if (outcome === "up") {
      rejectionsRef.current = 0;
      failuresRef.current = 0;
      setState((current) => (current.phase === "ready" ? current : { ...current, phase: "ready" }));
      return;
    }
    needsReconnectRef.current = true;
    const load = loadRef.current;
    let wait: number;
    if (outcome === "rejected") {
      const nth = rejectionsRef.current;
      rejectionsRef.current += 1;
      wait = REJECTION_DELAYS_MS[nth] ?? DEFAULT_RETRY_MS;
      setState((current) => ({ ...current, phase: "connecting" }));
    } else {
      wait = Math.min(BACKOFF_START_MS * 2 ** failuresRef.current, BACKOFF_CEILING_MS);
      failuresRef.current += 1;
      setState((current) => ({ ...current, phase: "unreachable" }));
    }
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
    }
    timerRef.current = setTimeout(load, wait);
  }, []);

  const signOut = useCallback((): void => {
    releaseHeld();
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setState((current) => (current.held === null ? current : { ...current, held: null, phase: "connecting" }));
  }, [releaseHeld]);

  // What is exposed belongs to the account that is paired right now: a session
  // held for another one is never shown, in the one render before the effect above forgets it.
  const current = state.owner === ownerId && ownerId !== "" ? state : null;
  const session = current?.held?.session ?? null;
  const access = useMemo<WorkspaceAccess>(() => {
    if (!hostedDevice) {
      return { kind: "manual" };
    }
    if (!current) {
      // Hosted, but no paired account to ask for (or not asked yet).
      return ownerId === "" ? { kind: "hosted-not-set-up" } : { kind: "hosted-connecting" };
    }
    switch (current.phase) {
      case "ready":
        return { kind: "hosted-connected" };
      case "not-set-up":
        return { kind: "hosted-not-set-up" };
      case "pending":
        return { kind: "hosted-retrying", why: "pending" };
      case "unreachable":
        return { kind: "hosted-retrying", why: "unreachable" };
      case "signed-out":
        return { kind: "hosted-signed-out" };
      case "connecting":
        return { kind: "hosted-connecting" };
    }
  }, [hostedDevice, current, ownerId]);

  return { access, session, reconnectKey: current?.reconnectKey ?? 0, report, signOut };
}
