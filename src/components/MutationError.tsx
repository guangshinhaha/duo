/** A failed mutation with no feedback looks identical to a button that silently did nothing — the owner can't tell whether Send actually sent. Renders nothing when there's no error, so call sites don't need their own conditional. */
export function MutationError({ error }: { error: Error | null }) {
  if (!error) {
    return null;
  }
  return (
    // #39: role="status" — a failed outcome announces politely; it is
    // information the owner needs at their own pace, not an interruption
    // (the button still on screen is the retry path).
    <p className="type-provenance text-[var(--refused)]" data-testid="mutation-error" role="status">
      {error.message}
    </p>
  );
}
