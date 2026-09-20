/**
 * #27: the typed-but-unsent question, held outside the Composer so a route
 * switch (which unmounts the Duo surface) does not eat it. Module-level,
 * not localStorage: a half-typed question is a thought in progress, not a
 * record — it survives navigation within the session and dies with the app.
 */
let buffer = "";

export function readComposerBuffer(): string {
  return buffer;
}

export function writeComposerBuffer(text: string): void {
  buffer = text;
}
