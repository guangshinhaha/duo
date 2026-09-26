// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/*
 * #154: what a notification says is a privacy fact. The page a person reads
 * must cover it, and must not promise what does not exist.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const page = (readFileSync(join(root, "public/privacy.html"), "utf8") as string).replace(/\s+/g, " ");

describe("the privacy page covers notifications (#154)", () => {
  const section = page.slice(page.indexOf("<h2>Notifications</h2>"), page.indexOf("<h2>Your choices</h2>"));

  it("has a Notifications section", () => {
    expect(page).toContain("<h2>Notifications</h2>");
    expect(section.length).toBeGreaterThan(200);
  });

  it("says what a Mac notification carries and that it stays on the Mac", () => {
    expect(section).toContain("made on your Mac");
    expect(section).toContain("Nothing goes through Apple or Google");
    expect(section).toContain("doesn't include what was asked or what your duo wrote");
  });

  it("says phone push is not part of the pilot yet, and the rule it must meet before it is", () => {
    expect(section).toContain("aren't part of the pilot yet");
    expect(section).toContain("carries only a draft's ID and a fixed line");
    expect(section).toContain("never the question or the draft");
    // The words that do appear on the phone can show on its lock screen.
    expect(section).toContain("lock screen");
  });
});
