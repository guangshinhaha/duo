import type { DuoApiConfig } from "../api/client.js";
import { useDuos } from "../api/queries.js";

/*
 * #40, as reshaped after #57/#59: the sidebar is conversations now, not a
 * duo list — what survives is the slice this component renders, where the
 * hardcoded "Duo" wordmark stood. Role duos do not appear here, and that
 * is the daemon's shape, not a choice this client made: GET /duos reports
 * the personal duo and any shared duo this device is trusted with, and
 * nothing in the wire names a role duo. A roster that invented them would
 * be the client posing as the core's registry; if the core ever
 * enumerates them, this list renders them the day it does.
 *
 * The entries are labels, not links: a shared duo has no surface of its
 * own in this cut, and a control that goes nowhere is a lie.
 */
export function DuoRoster({ api }: { api: DuoApiConfig }) {
  const { data } = useDuos(api);
  const duos = data ?? [];
  if (duos.length === 0) {
    // An unanswered /duos is an offline daemon or a quiet one — the
    // offline bar is the honest signal for the first, and a wordmark is
    // not an error surface. The plain name keeps the sidebar's shape.
    return (
      <div data-testid="duo-wordmark" className="mb-2 px-2 type-provenance uppercase text-[var(--faint)]">
        Duo
      </div>
    );
  }
  return (
    <div data-testid="duo-roster" className="mb-2 flex flex-col gap-1 px-2">
      {/* The personal kind carries no fields — its label is the client's
          one fixed string for "yours". The shared kind's label is the
          daemon's own ownerName, composed into whose-it-is: the shared
          duo must never read as your own. */}
      {duos.map((duo) => (
        <div
          key={duo.kind === "shared" ? `shared:${duo.ownerId}` : "personal"}
          className="type-provenance text-[var(--faint)]"
        >
          {duo.kind === "shared" ? `${duo.ownerName}'s duo` : "Your duo"}
        </div>
      ))}
    </div>
  );
}
