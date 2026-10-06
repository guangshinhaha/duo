/**
 * #268: Edit on an autonomous reply stops it and opens it in the editor. The
 * stop happens on one surface (the live strip) and the editor on another (the
 * draft's own page), so the one-shot "open this one editing" travels here, in
 * memory: taken once by the first decision surface that mounts for the draft,
 * and never persisted — a reload is not a request to edit.
 */
const pending = new Set<string>();

export function requestEditOnOpen(draftId: string): void {
  pending.add(draftId);
}

/** True exactly once after `requestEditOnOpen(draftId)`. */
export function takeEditOnOpen(draftId: string): boolean {
  return pending.delete(draftId);
}
