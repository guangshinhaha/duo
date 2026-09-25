// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * Core #214's decision record (trust writes are exposeable in principle,
 * under five written requirements) carried exact replacement wording for
 * this repo, applied on the user's ratification. These tests pin that the
 * application happened and cannot silently revert: AR-17's arrow block now
 * refs the core record instead of ending at "no client path can write", and
 * vocabulary.md's autonomy-level entry no longer justifies read-only-ness
 * with a route's absence (the decision removed that reason while leaving
 * the surface read-only for this cut).
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

/** The doc hard-wraps at ~95 columns; the wording is verbatim, the wrapping is house style. */
function unwrap(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The AR-17 section only — from its heading to the next AR heading. */
function ar17(): string {
  const doc = read("docs/client-design.md");
  const start = doc.indexOf("### AR-17");
  const end = doc.indexOf("### AR-18");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return doc.slice(start, end);
}

describe("core #214 ratification bundle", () => {
  it("AR-17's arrow block carries the ratified wording, refing the core record", () => {
    const section = unwrap(ar17());
    expect(section).toContain("Trust-grid controls become possible once core exposes the shared module path");
    expect(section).toContain("trust-surface.md");
    expect(section).toContain("#179");
    expect(section).toContain("the type system and the store's CHECK constraint, not the route surface, are the enforcement");
    // The old ending — which stopped at "no client path can write" as if
    // CLI-only were the principle — is gone.
    expect(section).not.toMatch(/CLI could not\.\*\* ?$/);
  });

  it("vocabulary.md's autonomy-level entry keeps read-only for this cut, without the dead reason", () => {
    const doc = read("docs/vocabulary.md");
    const entry = unwrap(doc.slice(doc.indexOf("### autonomy level"), doc.indexOf("\n## ", doc.indexOf("### autonomy level"))));
    expect(entry).toContain("never as a control in this cut");
    expect(entry).toContain("read-only");
    expect(entry).toContain("shared module path");
    // The retired justification: writes were never refused-in-principle,
    // so "no route / core would refuse" must not come back as the reason.
    expect(entry).not.toMatch(/no route to change/i);
    expect(entry).not.toMatch(/core would refuse/);
  });
});
