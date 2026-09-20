import type { DraftDelivery } from "../api/types.js";

/**
 * #21: whether a sent answer actually arrived. The daemon records the
 * delivery attempt when a sent/edited draft is handed back to its origin
 * channel (digital-duo #170) and this renders what came back — nothing is
 * inferred here, and `null` (never sent, or self-asked with nowhere to go)
 * renders nothing at all. The failed reason is the daemon's own string,
 * verbatim; and a failure is about transport only — the outcome and the
 * text it sent stay recorded everywhere they already rendered. No retry
 * control exists here: the daemon exposes none, and a resend is not a
 * client behaviour to invent.
 */
export function DeliveryStateLine({ delivery }: { delivery: DraftDelivery | null | undefined }) {
  // `undefined` is a persisted cache older than the field (the same
  // staleness belt provenance has): it degrades like "never attempted".
  if (!delivery) {
    return null;
  }
  const failed = delivery.state === "failed";
  return (
    <p className={failed ? "type-provenance text-[var(--refused)]" : "type-provenance text-[var(--faint)]"} data-testid="delivery-state">
      {failed ? `Couldn’t deliver — ${delivery.reason}` : delivery.state === "pending" ? "In flight." : "Delivered."}
    </p>
  );
}
