import type { ReactNode } from "react";
import { useAssertNotInsideDuoMessage } from "./DuoMessage.js";

/**
 * A person's message in a shared room (#60) — the counterpart to
 * `RoomDuoMessage`. It takes the author's name because in a multi-party
 * room the reader is usually not the author, and its container is the same
 * plain bubble shape as `OwnerMessage`'s: people are people, and the only
 * distinction AR-13 demands is person-vs-duo, never person-vs-person.
 *
 * It calls the same runtime guard as `OwnerMessage`: a person's identity
 * must never render inside a duo-authored message, in either direction of
 * the pair.
 */
export function RoomPersonMessage({ authorName, children }: { authorName: string; children: ReactNode }) {
  useAssertNotInsideDuoMessage("RoomPersonMessage");
  return (
    <div
      data-testid="room-person-message"
      className="rounded-[var(--r-lg)] border border-[var(--edge)] bg-[var(--surface)] px-4 py-3 text-[var(--text)]"
    >
      <div className="mb-1 text-xs font-medium tracking-wide text-[var(--muted)]" data-testid="room-person-message-author">
        {authorName}
      </div>
      <div>{children}</div>
    </div>
  );
}
