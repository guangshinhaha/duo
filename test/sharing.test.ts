import { describe, expect, it } from "vitest";
import {
  SHARE_ATTACHMENTS_LIMIT,
  SHARE_FILE_LIMIT_BYTES,
  SHARE_IMAGE_LIMIT_BYTES,
  avatarRefusalOf,
  formatBytes,
  isImageType,
  shareRefusalOf,
  stageFile,
} from "../src/workspace/sharing.js";

/*
 * #66: this app's own sharing policy, named and distinct from any duo's
 * grounding door. The share limits are what this client puts on the wire
 * for people; the daemon's attachment grounding cap (core #190,
 * `docs/workspace/attachments.md` §7 — 32 KiB of text per attachment) is a
 * different door, owned by the duo's owner, and the composer's hint names
 * it as such. These tests pin the separation structurally: sharing limits
 * are strictly larger, and every refusal names its own limit.
 */

/** The daemon's grounding cap — the number the share limits must stay distinct from. */
const GROUNDING_CAP_BYTES = 32 * 1024;

describe("the share limits are their own door, not the duo's", () => {
  it("share limits are strictly larger than the daemon's 32 KiB grounding cap — sharing is not grounding", () => {
    expect(SHARE_IMAGE_LIMIT_BYTES).toBeGreaterThan(GROUNDING_CAP_BYTES);
    expect(SHARE_FILE_LIMIT_BYTES).toBeGreaterThan(GROUNDING_CAP_BYTES);
  });

  it("an image and a file run against their own limits", () => {
    expect(isImageType("image/png")).toBe(true);
    expect(isImageType("image/jpeg")).toBe(true);
    expect(isImageType("text/plain")).toBe(false);
    expect(isImageType("")).toBe(false); // an unknown type is a file card, never a guessed image
  });
});

describe("share refusals name the limit they broke", () => {
  it("an oversized image names the image limit", () => {
    expect(shareRefusalOf({ name: "photo.png", size: 9 * 1024 * 1024, mimeType: "image/png" }, 0)).toBe(
      "photo.png is 9 MiB — conversation image shares cap at 8 MiB.",
    );
  });

  it("an oversized file names the file limit, which is not the grounding cap", () => {
    const refusal = shareRefusalOf({ name: "deck.pdf", size: 17 * 1024 * 1024, mimeType: "application/pdf" }, 0);
    expect(refusal).toBe("deck.pdf is 17 MiB — conversation file shares cap at 16 MiB.");
    expect(refusal).not.toContain("32");
  });

  it("a fourth attachment names the count", () => {
    expect(shareRefusalOf({ name: "notes.txt", size: 100, mimeType: "text/plain" }, SHARE_ATTACHMENTS_LIMIT)).toBe(
      "notes.txt wasn't added — a message carries at most 3 attachments.",
    );
  });

  it("a file within its limits and under the count stages without a word", () => {
    expect(shareRefusalOf({ name: "notes.txt", size: 12_000, mimeType: "text/plain" }, 0)).toBeNull();
    // A file above the duo's 32 KiB reading cap still shares — the duo's
    // door is the duo's, and a refusal here would conflate the two.
    expect(shareRefusalOf({ name: "big.txt", size: 100_000, mimeType: "text/plain" }, 0)).toBeNull();
  });
});

describe("a conversation's picture (#223) reuses the share path's own rules, plus its own image-only one", () => {
  it("refuses a non-image outright, never reaching the size check", () => {
    expect(avatarRefusalOf({ name: "notes.txt", size: 100, mimeType: "text/plain" })).toBe(
      "notes.txt isn't a picture — a conversation picture must be an image.",
    );
  });

  it("an oversized image still names the same image limit a shared image would", () => {
    expect(avatarRefusalOf({ name: "team.png", size: 9 * 1024 * 1024, mimeType: "image/png" })).toBe(
      "team.png is 9 MiB — conversation image shares cap at 8 MiB.",
    );
  });

  it("an image within the limit uploads without a word", () => {
    expect(avatarRefusalOf({ name: "team.png", size: 100_000, mimeType: "image/png" })).toBeNull();
  });
});

describe("byte counts read honestly", () => {
  it("formats binary units", () => {
    expect(formatBytes(32)).toBe("32 B");
    expect(formatBytes(32 * 1024)).toBe("32 KiB");
    expect(formatBytes(1.5 * 1024 * 1024)).toBe("1.5 MiB");
    expect(formatBytes(9 * 1024 * 1024)).toBe("9 MiB");
  });
});

describe("staging reads the file's own facts", () => {
  it("carries the browser's type claim and the bytes, never a guess", async () => {
    const file = new File([new Uint8Array([1, 2, 3])], "notes.txt", { type: "text/plain" });
    const staged = await stageFile(file);
    expect(staged).toEqual({ name: "notes.txt", mimeType: "text/plain", size: 3, bytes: expect.any(ArrayBuffer) });
    expect(new Uint8Array(staged.bytes)).toEqual(new Uint8Array([1, 2, 3]));
  });
});
