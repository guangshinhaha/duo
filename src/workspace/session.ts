import { useEffect, useState } from "react";
import type { WorkspaceSession } from "./matrix.js";

const STORAGE_KEY = "duo.workspace-session";

/**
 * #62: this device's workspace sign-in, remembered between launches — the
 * same per-device convenience stance as the pairing store (`api/config.ts`),
 * and deliberately a SEPARATE key: the workspace session (who you are, in an
 * org) and the duo pairing (which only you reach) are separate credentials
 * with separate lifetimes, and each ends without touching the other.
 */
function isSession(value: unknown): value is WorkspaceSession {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const { homeserverUrl, userId, accessToken, deviceId } = value as Record<string, unknown>;
  return [homeserverUrl, userId, accessToken, deviceId].every((field) => typeof field === "string" && field.length > 0);
}

function readStoredSession(): WorkspaceSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeStoredSession(session: WorkspaceSession | null): void {
  try {
    if (session) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));
    } else {
      localStorage.removeItem(STORAGE_KEY);
    }
  } catch {
    // Private window, blocked storage, etc. — the front door just asks again next launch.
  }
}

/** Where this device's workspace sign-in is remembered. Returns `null` until the member has signed in once on this device. */
export function useWorkspaceSession(): [WorkspaceSession | null, (session: WorkspaceSession | null) => void] {
  const [session, setSessionState] = useState<WorkspaceSession | null>(() => readStoredSession());

  useEffect(() => {
    writeStoredSession(session);
  }, [session]);

  return [session, setSessionState];
}
