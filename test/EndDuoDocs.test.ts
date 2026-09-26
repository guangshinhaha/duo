// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #55: the docs describe the kill switch the code implements — the verb is
 * in the vocabulary under the name the control carries, and the route
 * contract records the two facts a future reader would otherwise have to
 * rediscover: a failure is not always "not ended", and the 401 after an end
 * is the ending, not a revocation.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (relative: string): string => readFileSync(join(root, relative), "utf8");

describe("#55 — the docs match the control", () => {
  it("the vocabulary defines 'end this duo' as its own verb, apart from 'forget this device'", () => {
    const doc = read("docs/vocabulary.md");
    expect(doc).toMatch(/^### end this duo$/m);
    expect(doc).toMatch(/^### forget this device$/m);
    expect(doc).toMatch(/never confused with "forget this device"/);
  });

  it("the control carries the name the vocabulary gives it", () => {
    const source = read("src/components/EndDuoSection.tsx");
    expect(source).toContain("End this duo…");
    expect(source).toContain("End this duo?");
    expect(source).toContain("End this duo for good");
  });

  it("the route contract records the describe-first shape, the not-always-'not ended' failure, and the 401 that is the ending", () => {
    const doc = read("docs/client-tech-design.md");
    expect(doc).toMatch(/\*\*Ending the duo \(#55\)\.\*\*/);
    expect(doc).toContain("`{ decidedBy, confirmed: false }`");
    expect(doc).toContain("`{ decidedBy, confirmed: true }`");
    expect(doc).toMatch(/A failure is not always "not ended"/);
    expect(doc).toMatch(/exactly a revoked token/);
    expect(doc).toMatch(/Offline is disabled, never queued/);
  });
});
