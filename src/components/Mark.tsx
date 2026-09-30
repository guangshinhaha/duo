/**
 * The mark (docs/design-language.md §3.1): a solid bar for you and a
 * hairline for your duo, side by side. It is the duo's avatar wherever a
 * duo needs one — yours or a colleague's — and a duo never gets initials or
 * a photo, which is what keeps a duo from being mistaken for a person.
 * Decorative: the surrounding label carries the name. While the duo is
 * working its hairline loops.
 */
export function Mark({ working = false }: { working?: boolean }) {
  return (
    // `working` is the duo drafting or answering: the hairline draws and retracts, the one loop in the product (§3.1).
    <span data-testid="duo-mark" aria-hidden="true" className="duo-mark" data-working={working ? "" : undefined}>
      <i />
      <i />
    </span>
  );
}
