/**
 * #62: what a signed-in member with no paired duo sees wherever a duo
 * surface would be — the explanation and the offer, never a demand
 * (AC2: messaging works fully; pairing is offered rather than required).
 * Rendered full where a route lives (`#waiting` and friends reached by URL),
 * condensed in the sidebar beside the surfaces the member does have.
 */
export function NoDuoPanel({ onPairDuo, condensed = false }: { onPairDuo: () => void; condensed?: boolean }) {
  return (
    <section className="flex flex-col gap-3 p-3" data-testid="no-duo">
      {!condensed && <h2 className="type-heading">Your duo</h2>}
      <p className="type-body text-[var(--muted)]">No duo is connected on this device.</p>
      {!condensed && (
        <p className="type-body text-[var(--muted)]">
          Your conversations don&apos;t need one — a duo is your own private second opinion, paired from a token your Mac prints with{" "}
          <code>duo pair new</code>.
        </p>
      )}
      <button
        className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body text-[var(--text)]"
        data-testid="no-duo-pair"
        onClick={onPairDuo}
      >
        Pair your duo
      </button>
    </section>
  );
}
