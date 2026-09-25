// @ts-expect-error no node types by design
import { readFileSync, readdirSync } from "node:fs";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

/*
 * #51-queue / §1.4 backfill: the route-contract table in
 * client-tech-design.md is the client repo's map of what the daemon
 * serves, and it had drifted to a minority of the real inventory. These
 * tests hold it against two anchors so the drift cannot silently return:
 *
 *  - the served inventory, transcribed mechanically from the core repo's
 *    src/serve/server.ts (+ ws.ts) at main @ 83a2195 — regenerate by
 *    re-reading that file and re-listing its app.<method>(<generics>)("…")
 *    registrations when the core lands new routes;
 *  - the routes this client itself calls, extracted live from src/api at
 *    test time, so a new client call can never land without its doc row.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function read(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

/** The §1.4 table only — the section between its heading and §1.5. */
function routeTable(): string {
  const doc = read("docs/client-tech-design.md");
  const start = doc.indexOf("## 1.4 Route contracts");
  const end = doc.indexOf("## 1.5 Errors");
  expect(start, "§1.4 heading exists").toBeGreaterThan(-1);
  expect(end, "§1.5 heading follows").toBeGreaterThan(start);
  return doc.slice(start, end);
}

type Row = { method: string; path: string; returns: string };

function tableRows(): Row[] {
  const rows: Row[] = [];
  for (const match of routeTable().matchAll(/^\| `(GET|POST)` \| `([^`]+)` \| (.+) \|/gm)) {
    rows.push({ method: match[1]!, path: match[2]!, returns: match[3]! });
  }
  return rows;
}

/** Both sides' dynamic segments collapse to ":" so `/drafts/:id` and `/drafts/${x}` compare equal. */
function normalizePath(path: string): string {
  const [pathname] = path.split("?");
  return pathname!
    .split("/")
    .map((segment) => (segment.startsWith(":") || segment.startsWith("${") ? ":" : segment))
    .join("/");
}

/** Every core-repo registration, method and path, as of main @ 83a2195. */
const SERVED: [method: string, path: string][] = [
  ["GET", "/health"],
  ["GET", "/duos"],
  ["GET", "/channels"],
  ["GET", "/channels/policy"],
  ["POST", "/channels/policy/mute"],
  ["POST", "/channels/policy/unmute"],
  ["GET", "/devices"],
  ["POST", "/devices/:id/revoke"],
  ["GET", "/drafts"],
  ["GET", "/drafts/:id"],
  ["POST", "/drafts"],
  ["POST", "/ask"],
  ["POST", "/drafts/:id/outcome"],
  ["POST", "/drafts/:id/answer"],
  ["GET", "/review"],
  ["POST", "/review/:id/approve"],
  ["POST", "/review/:id/reject"],
  ["GET", "/mirror/portrait"],
  ["GET", "/knowledge"],
  ["GET", "/mirror/rules"],
  ["GET", "/mirror/rules/:id"],
  ["GET", "/mirror/refusals"],
  ["POST", "/mirror/rules/:id/:action"],
  ["GET", "/trust/grid"],
  ["GET", "/actions/t4/pending"],
  ["POST", "/actions/t4/:id/confirm"],
  ["GET", "/actions/attempts"],
  ["GET", "/lifecycle"],
  ["POST", "/lifecycle/end"],
  ["POST", "/corpus/import-paste"],
  ["POST", "/corpus/embed"],
  ["GET", "/corpus/embed"],
  ["GET", "/search"],
  ["POST", "/escalations/digest"],
  ["GET", "/escalations/history"],
  ["GET", "/escalations/rate"],
  ["GET", "/audit"],
  ["GET", "/ws"],
];

describe("§1.4 route contracts", () => {
  it("documents every route the daemon serves", () => {
    const documented = new Set(tableRows().map((row) => `${row.method} ${normalizePath(row.path)}`));
    for (const [method, path] of SERVED) {
      expect(documented, `${method} ${path} has a row`).toContain(`${method} ${normalizePath(path)}`);
    }
  });

  it("documents every route this client calls", () => {
    // A client template's `${…}` segments are wildcards — `/review/${id}/${action}`
    // is covered by the named rows `/review/:id/approve` and `/review/:id/reject`.
    const covered = (called: string) =>
      tableRows().some((row) => {
        const rowSegments = normalizePath(row.path).split("/");
        const calledSegments = called.split("/");
        return (
          rowSegments.length === calledSegments.length &&
          calledSegments.every((segment, i) => segment === ":" || segment === rowSegments[i])
        );
      });
    const called = new Set<string>(["/ws"]); // ws.ts builds its URL by pathname concat
    for (const entry of readdirSync(join(root, "src", "api"), { recursive: true })) {
      const content = read(join("src", "api", String(entry)));
      for (const literal of content.matchAll(/[`"']\/[a-z][^`"'\n]*[`"']/g)) {
        called.add(normalizePath(literal[0].slice(1, -1)));
      }
    }
    for (const path of called) {
      expect(covered(path), `client-called ${path} has a row`).toBe(true);
    }
  });

  it("names the #176 shapes the handoff pinned", () => {
    const rows = tableRows();
    const importPaste = rows.find((row) => row.method === "POST" && normalizePath(row.path) === "/corpus/import-paste");
    expect(importPaste?.returns).toContain("PasteImportSummary");
    for (const embedRow of rows.filter((row) => normalizePath(row.path) === "/corpus/embed")) {
      expect(embedRow.returns).toContain("EmbedJobStatus");
    }
  });
});
