import { useEffect, useState } from "react";
import type { PresenceState, WorkspaceConnection } from "../workspace/matrix.js";

/** One person's reading, as `usePeoplePresence` reports it. */
export interface PersonPresence {
  readonly presence: PresenceState;
  readonly statusMessage: string | null;
}

/**
 * #287: online/away/offline, and a custom status line, for every person
 * `userIds` names — read once off whatever this account's sync already
 * knows (`presenceOf`/`statusMessageOf`), then kept live
 * (`subscribePresence`) for the rest of this hook's life. One subscription
 * however many ids are watched, so a conversation list and a room header
 * reading the SAME person see the same thing at the same time rather than
 * two independent polls drifting apart.
 *
 * A person with no entry in the returned map is "nothing known yet" — this
 * account has never synced any presence for them at all (a homeserver with
 * presence turned off, or someone it doesn't yet share a room with) —
 * which is why a caller checking "is this person online" reads the map's
 * absence, never assumes `offline`.
 */
export function usePeoplePresence(connection: WorkspaceConnection | null | undefined, userIds: readonly string[]): ReadonlyMap<string, PersonPresence> {
  const [presence, setPresence] = useState<ReadonlyMap<string, PersonPresence>>(new Map());
  // Arrays are a fresh identity every render; the effect keys off the ids
  // actually watched, not the array wrapping them, the same "key, not
  // identity" convention `waitingByRoom`'s own memoisation uses elsewhere.
  const key = userIds.join(",");

  useEffect(() => {
    if (!connection) {
      setPresence(new Map());
      return;
    }
    const ids = key === "" ? [] : key.split(",");
    const initial = new Map<string, PersonPresence>();
    for (const userId of ids) {
      const state = connection.presenceOf?.(userId) ?? null;
      if (state !== null) {
        initial.set(userId, { presence: state, statusMessage: connection.statusMessageOf?.(userId) ?? null });
      }
    }
    setPresence(initial);
    const unsubscribe = connection.subscribePresence?.((userId, nextPresence, statusMessage) => {
      setPresence((current) => {
        const next = new Map(current);
        next.set(userId, { presence: nextPresence, statusMessage });
        return next;
      });
    });
    return () => unsubscribe?.();
  }, [connection, key]);

  return presence;
}
