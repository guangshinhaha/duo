/**
 * The mark (docs/design-language.md §3.1): a solid bar for you and a
 * hairline for your duo, side by side. It is the duo's avatar wherever a
 * duo needs one — yours or a colleague's — and a duo never gets initials or
 * a photo, which is what keeps a duo from being mistaken for a person.
 * Decorative: the surrounding label carries the name.
 */
export function Mark() {
  return (
    <span data-testid="duo-mark" aria-hidden="true" className="duo-mark">
      <i />
      <i />
    </span>
  );
}
