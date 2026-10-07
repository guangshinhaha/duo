/**
 * #66: the client's own sharing policy — what this app will put on the wire,
 * named and distinct from what any duo will do with it afterwards. Sharing
 * is a people act: a file message renders for the room, downloads for the
 * room, and nothing about it reaches any daemon's corpus (the structural
 * pin lives in test/WorkspaceMatrixSeam.test.ts's scans — no share-path
 * module imports the daemon's api).
 *
 * The numbers below are SHARE limits, not grounding limits. The daemon's
 * attachment grounding door (core #190, `docs/workspace/attachments.md` §7)
 * caps what a duo will READ at 32 KiB of text per attachment — a different
 * door, owned by the duo's owner, surfaced in the composer's hint rather
 * than enforced here. These limits are larger on purpose: a shared file is
 * for people's eyes, and a document that a duo could ground is a subset of
 * what a person may share, never the definition of it.
 */

/**
 * The largest image this app shares — 8 MiB. Camera photos and screenshots
 * land in a few MiB; beyond that the homeserver's own limits are the right
 * refusal, not a long upload this device babysits.
 */
export const SHARE_IMAGE_LIMIT_BYTES = 8 * 1024 * 1024;

/**
 * The largest file of any other type this app shares — 16 MiB: enough for a
 * deck, a log, or a report; deliberately far above the 32 KiB a duo will
 * read (that cap is the duo's, and the composer's hint names it as such).
 */
export const SHARE_FILE_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * How many files one message may carry — 3, matching the duo's grounding
 * door (at most 3 attachments per question), so a member who attaches three
 * and asks gets exactly the ride the convention promises.
 */
export const SHARE_ATTACHMENTS_LIMIT = 3;

/** Whether a MIME type shares as an image (`m.image`, thumbnail render) — the browser's own claim, never guessed from a filename. */
export function isImageType(mimeType: string): boolean {
  return mimeType.startsWith("image/");
}

/** #294: whether a MIME type is this app's own recorded voice note (`m.audio`) — the browser's own claim from `MediaRecorder`, never guessed. */
export function isAudioType(mimeType: string): boolean {
  return mimeType.startsWith("audio/");
}

/** #294: the longest voice note this app records — 5 minutes. A hold-to-record gesture that runs longer is cut off rather than building an attachment nobody will share the size of. */
export const VOICE_NOTE_LIMIT_MS = 5 * 60_000;

/** The share limit a MIME type runs against. */
export function shareLimitOf(mimeType: string): number {
  return isImageType(mimeType) ? SHARE_IMAGE_LIMIT_BYTES : SHARE_FILE_LIMIT_BYTES;
}

/** A byte count in honest binary units — `32 B`, `12.4 KiB`, `8 MiB`. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  const kibibytes = bytes / 1024;
  if (kibibytes < 1024) {
    return `${kibibytes >= 10 ? Math.round(kibibytes) : Math.round(kibibytes * 10) / 10} KiB`;
  }
  const mebibytes = kibibytes / 1024;
  return `${mebibytes >= 10 ? Math.round(mebibytes) : Math.round(mebibytes * 10) / 10} MiB`;
}

/** What the composer stages for sending: the file's own facts and its bytes, read once at attach time. */
export interface StagedShare {
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  readonly bytes: ArrayBuffer;
  /** #294: set only for a recorded voice note — the clip's own length, read from `MediaRecorder`'s timing, not guessed from byte size. */
  readonly durationMs?: number;
  /** #294: the transcript the browser's own speech recognition produced while recording, when it produced one at all — null is honest ("no transcript"), never an empty string standing in for it. */
  readonly transcript?: string | null;
}

/** Reads a picked file into what the seam takes — the browser's type claim carried as-is, never guessed. */
export async function stageFile(file: File): Promise<StagedShare> {
  return { name: file.name, mimeType: file.type, size: file.size, bytes: await file.arrayBuffer() };
}

/**
 * #294: reads a recorded voice note into what the seam takes — the same
 * `stage()` door #66 built for a picked file, one more way in. `durationMs`
 * and `transcript` ride alongside the bytes because both are already known
 * the moment recording stops (the clip's own timing; the Web Speech API's
 * running result) and have nowhere else to come from once the blob is just
 * bytes. The name is fixed and dated, matching how this app already names
 * nothing a member typed themselves (recordings have no filename to lose).
 */
export async function stageRecordedAudio(blob: Blob, durationMs: number, transcript: string | null): Promise<StagedShare> {
  const mimeType = blob.type.length > 0 ? blob.type : "audio/webm";
  return {
    name: `Voice note ${new Date().toISOString().replace(/[:.]/g, "-")}.webm`,
    mimeType,
    size: blob.size,
    bytes: await blob.arrayBuffer(),
    durationMs,
    transcript,
  };
}

/**
 * The honest refusal for a file this app will not share, naming the limit it
 * broke — or null when the file may stage. A refusal states the share limit
 * and keeps everything: the file is not added, the message is not sent, and
 * the words the member typed stay in the composer.
 */
export function shareRefusalOf(file: { name: string; size: number; mimeType: string }, stagedCount: number): string | null {
  if (stagedCount >= SHARE_ATTACHMENTS_LIMIT) {
    return `${file.name} wasn't added — a message carries at most ${SHARE_ATTACHMENTS_LIMIT} attachments.`;
  }
  const limit = shareLimitOf(file.mimeType);
  if (file.size > limit) {
    return `${file.name} is ${formatBytes(file.size)} — conversation ${isImageType(file.mimeType) ? "image" : "file"} shares cap at ${formatBytes(limit)}.`;
  }
  return null;
}

/**
 * The honest refusal for a picture this app will not set as a group
 * conversation's own (#223) — the same file-upload path a shared image
 * runs through (the browser's own type claim, the image share limit), plus
 * one rule a shared image doesn't need: a conversation's picture must
 * itself be an image, never a generic file. Null when the picture may
 * upload.
 */
export function avatarRefusalOf(file: { name: string; size: number; mimeType: string }): string | null {
  if (!isImageType(file.mimeType)) {
    return `${file.name} isn't a picture — a conversation picture must be an image.`;
  }
  return shareRefusalOf(file, 0);
}
