import { useEffect, useRef } from "react";
import { notifyLaterItemDue } from "../notifications.js";
import { dueLaterItems, markLaterFired, useLaterItems } from "../shell/later.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";

const POLL_MS = 20_000;

/**
 * duo#299 AC2, honestly scoped: "reminders arrive even if the app is
 * closed" needs something that runs with nobody watching — a server-side
 * scheduler and a push channel, same shape digital-duo#251 built for drafts.
 * That does not exist for Later (nor for anything else in this client —
 * `docs/push.md` says the same of phone push), and building it is a
 * daemon change, out of this issue's own repo. What this gives instead:
 * while ANY device has the app open — foreground, or the Mac's menu-bar
 * tray process, which stays resident after the window closes
 * (`docs/mac-shell.md`) — a due reminder fires within `POLL_MS`, including
 * one that came due while nothing was open (checked again the moment this
 * mounts). A reminder saved and then missed entirely (the app never once
 * open between save and due time) simply waits in the Later list for the
 * next time it is — the honest degradation, not a silent drop: `firedAt`
 * stays null, so nothing here ever marks it told without having told it.
 *
 * `firedAt` is this account's own record (`duo.later.items`), so two
 * devices open at once don't double-fire: whichever gets there first
 * writes it, and the account-data subscription both hold means the other
 * reads the write before its own poll would have fired.
 */
export function LaterReminderWatcher({ connection }: { connection: WorkspaceConnection | null }) {
  const later = useLaterItems(connection);
  const itemsRef = useRef(later.items);
  itemsRef.current = later.items;
  const updateRef = useRef(later.update);
  updateRef.current = later.update;

  useEffect(() => {
    if (connection === null) {
      return;
    }
    const check = (): void => {
      const due = dueLaterItems(itemsRef.current);
      if (due.length === 0) {
        return;
      }
      let next = itemsRef.current;
      for (const item of due) {
        void notifyLaterItemDue(item.preview);
        next = markLaterFired(next, item.id);
      }
      updateRef.current(next);
    };
    check();
    const timer = window.setInterval(check, POLL_MS);
    return () => window.clearInterval(timer);
  }, [connection]);

  return null;
}
