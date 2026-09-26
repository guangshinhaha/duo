import { useEffect, useRef } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { usePendingT4 } from "../api/queries.js";
import { notifyConfirmationWaiting } from "../notifications.js";

/**
 * #52 AC1: a pending confirmation reaches the owner. Renders nothing; while
 * the app is open it holds the pending-confirmations read (polled — the
 * daemon has no push for this, §1.7) and, when a request the owner has not
 * yet been told about appears, asks for the native notification and calls
 * `onArrived` (the shell's polite announcement).
 *
 * "Told about" is per request id, remembered for this run: a re-read that
 * shows the same request is not news, a second request is, and a request
 * already waiting when the app opens counts — the owner was not there when
 * it was raised, which is the whole reason it needs a notification. Ids
 * that leave the list are forgotten, so the memory stays the size of the
 * list.
 *
 * Only a list read from the daemon in THIS run is announced: a list
 * rehydrated from the persisted cache may name a request that was
 * confirmed elsewhere since, and notifying about it would be a false alarm
 * over a stale record.
 *
 * It only ever notifies. Nothing here holds the confirm hook — a
 * notification, an announcement and a badge are all ways to be told, and
 * none is a way to confirm.
 */
export function ConfirmationWatcher({ api, onArrived }: { api: DuoApiConfig; onArrived: () => void }) {
  const { data, isFetchedAfterMount, isError } = usePendingT4(api);
  const told = useRef<Set<string>>(new Set());
  const onArrivedRef = useRef(onArrived);
  onArrivedRef.current = onArrived;

  useEffect(() => {
    if (!data || !isFetchedAfterMount || isError) {
      return;
    }
    const ids = new Set(data.map((request) => request.id));
    const fresh = [...ids].filter((id) => !told.current.has(id));
    told.current = new Set([...told.current].filter((id) => ids.has(id)));
    for (const id of fresh) {
      told.current.add(id);
    }
    if (fresh.length > 0) {
      void notifyConfirmationWaiting();
      onArrivedRef.current();
    }
  }, [data, isFetchedAfterMount, isError]);

  return null;
}
