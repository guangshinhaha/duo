import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { apiRequest, type DuoApiConfig } from "./client.js";
import type { EndDuoResult } from "./types.js";

/**
 * #55: ending the duo from a paired device — `POST /lifecycle/end`
 * (digital-duo #181). The route is the CLI's `duo lifecycle end`, with its
 * two protections kept: it names who decided it (`decidedBy`, non-empty),
 * and it only DESCRIBES what would go until `confirmed` is literally
 * `true`. Both halves are hooks here because both are mutations: neither
 * is a cacheable read (the description is a POST, and must never land in
 * the persisted query cache), and neither invalidates anything on success
 * — after a confirmed end every token is dead, so a refetch could only
 * earn a 401; App clears the cache instead.
 */

/** How long an end may run before the client stops waiting — deletion is fast, but a wedged request must not pin the dialog forever. */
const END_TIMEOUT_MS = 30_000;

/** The daemon answered 200 to a confirmed request without `confirmed: true` — a description, not a deletion. Nothing was ended, and the client must not act as though it were. */
export class EndNotConfirmedError extends Error {
  constructor() {
    super("Your duo answered but did not confirm ending, so it was not ended.");
    this.name = "EndNotConfirmedError";
  }
}

function postEnd(api: DuoApiConfig, decidedBy: string, confirmed: boolean): Promise<EndDuoResult> {
  return apiRequest<EndDuoResult>(api, "/lifecycle/end", {
    method: "POST",
    body: JSON.stringify({ decidedBy, confirmed }),
    timeoutMs: END_TIMEOUT_MS,
  });
}

/** What would go, as the daemon itself lists it — `confirmed: false`, so nothing is deleted by asking. Run when the confirmation opens, so every claim it makes is the daemon's. */
export function useDescribeEnd(api: DuoApiConfig, decidedBy: string) {
  return useMutation({ mutationFn: () => postEnd(api, decidedBy, false) });
}

/**
 * The end itself. Resolves only for a daemon that says `confirmed: true`;
 * anything else rejects, so success means exactly "the daemon deleted it".
 * `onEnded` is the HOOK's callback, not the call's: a request already in
 * flight when another request's 401 unmounts the dialog (the daemon drops
 * every token the moment it ends) must still be heard, and only the hook's
 * callbacks outlive the component that made the call.
 */
export function useEndDuo(api: DuoApiConfig, decidedBy: string, onEnded?: () => void) {
  return useMutation({
    mutationFn: async () => {
      const result = await postEnd(api, decidedBy, true);
      if (result.confirmed !== true) {
        throw new EndNotConfirmedError();
      }
      return result;
    },
    onSuccess: () => onEnded?.(),
  });
}

const ENDED_KEY = "duo.ended";

/** When this device ended its duo. Per-device by construction: the daemon cannot say "ended" afterwards (every token is dead, so it can only say 401), which makes this device's own memory the only honest source for the notice. */
export interface EndedMarker {
  endedAt: string;
}

function readEnded(): EndedMarker | null {
  try {
    const raw = localStorage.getItem(ENDED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    return typeof parsed === "object" && parsed !== null && typeof (parsed as EndedMarker).endedAt === "string"
      ? { endedAt: (parsed as EndedMarker).endedAt }
      : null;
  } catch {
    return null;
  }
}

function writeEnded(marker: EndedMarker | null): void {
  try {
    if (marker) {
      localStorage.setItem(ENDED_KEY, JSON.stringify(marker));
    } else {
      localStorage.removeItem(ENDED_KEY);
    }
  } catch {
    // Blocked storage — the notice then lasts this launch only, which is still true while it shows.
  }
}

/** The ended marker, remembered between launches like the pairing beside it (`api/config.ts`) — and cleared by the next pairing, which is a different duo. */
export function useEndedMarker(): [EndedMarker | null, (marker: EndedMarker | null) => void] {
  const [marker, setMarker] = useState<EndedMarker | null>(readEnded);
  useEffect(() => {
    writeEnded(marker);
  }, [marker]);
  return [marker, setMarker];
}

/** What every surface says once this device has ended its duo — one wording, so Setup and the member shell cannot drift. */
export function endedNoticeText(marker: EndedMarker): string {
  const when = new Date(marker.endedAt);
  const at = Number.isNaN(when.getTime()) ? "" : ` on ${when.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  return (
    `Your duo was ended from this device${at}. Its knowledge and everything derived from it were deleted, ` +
    "and no paired device can reach it any more. If you set up a new duo on your Mac, you can pair it here."
  );
}
