/**
 * @vitest-environment node
 *
 * The mock daemon's contract tests (duo #16). The mock exists so the client
 * can run without the real daemon, which makes its own fidelity the whole
 * product: these assert the wire shapes — not the client's rendering of
 * them — against a real socket on an ephemeral port. Every shape asserted
 * here mirrors src/api/types.ts by hand, the same as the daemon's types
 * would.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createMockDaemon } from "../mock/daemon.mjs";

let server;
let base;

beforeAll(async () => {
  server = createMockDaemon().server;
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

afterAll(async () => {
  // Node's fetch pools keep-alive sockets; close() alone would wait on them
  // until the test run times out.
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
});

const auth = { Authorization: "Bearer mock-token", "Content-Type": "application/json" };
const get = (path) => fetch(`${base}${path}`, { headers: auth });
const post = (path, body) => fetch(`${base}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) });

describe("mock daemon — CORS and auth (issue #16 done-when D4/D5)", () => {
  it("serves /health without a token, CORS-stamped", async () => {
    const res = await fetch(`${base}/health`);
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("answers preflights with 204 and names the headers the client sends", async () => {
    const res = await fetch(`${base}/drafts`, { method: "OPTIONS" });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-methods")).toContain("POST");
    expect(res.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(res.headers.get("access-control-allow-headers")).toContain("Content-Type");
  });

  it("refuses a missing bearer token with the daemon error shape", async () => {
    const res = await fetch(`${base}/drafts`);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(typeof body.error.message).toBe("string");
    // The header rides on error responses too — the exact gap #167 describes.
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
  });
});

describe("mock daemon — the drafts loop (D2/D3)", () => {
  it("seeds drafts oldest-first with the fields the thread view groups by", async () => {
    const res = await get("/drafts");
    expect(res.status).toBe(200);
    const drafts = await res.json();
    expect(drafts.map((d) => d.id)).toEqual(["d-1", "d-3", "d-4", "d-2"]);
    for (const field of ["question", "threadContext", "draftText", "outcome", "refused", "escalationThreshold"]) {
      expect(field in drafts[0]).toBe(true);
    }
    const escalation = drafts.find((d) => d.id === "d-4");
    expect(escalation.escalated).toBe(true);
    expect(escalation.draftText).toBeNull();
  });

  it("carries provenance on every seeded draft — the channel-borne one in #169's full shape (#30)", async () => {
    // GET-only on purpose: the pending-filter test below asserts the
    // seed's exact draft set, so nothing before it may POST.
    const seeded = await (await get("/drafts")).json();
    // d-1 is the seeded channel-borne draft, with #169's full shape.
    expect(seeded.find((d) => d.id === "d-1").provenance).toEqual({
      origin: "channel",
      channelKind: "slack",
      askerRef: "U04ARLJ9P",
      threadId: "C07H3Q2NA",
      permalink: null,
    });
    // Everything else the seed holds is owner-asked history.
    for (const d of seeded.filter((d) => d.id !== "d-1")) {
      expect(d.provenance).toEqual({ origin: "owner" });
    }
  });

  it("filters outcome=pending to the unanswered drafts", async () => {
    const res = await get("/drafts?outcome=pending");
    const drafts = await res.json();
    expect(drafts.every((d) => d.outcome === null)).toBe(true);
    expect(drafts.map((d) => d.id)).toEqual(["d-4", "d-2"]);
  });

  it("posts a question and gets a DraftPipelineResult draft back", async () => {
    const res = await post("/drafts", { question: "What's our refund policy?", threadContext: "vendor" });
    expect(res.status).toBe(201);
    const result = await res.json();
    expect(result.kind).toBe("draft");
    expect(typeof result.draftId).toBe("string");
    expect(typeof result.text).toBe("string");
    expect(result.sources.length).toBeGreaterThan(0);
    expect(result.confidence).toEqual({ score: 0.82, passesThreshold: true, threshold: 0.55 });

    const drafts = await (await get("/drafts")).json();
    const stored = drafts.find((d) => d.id === result.draftId);
    expect(stored.threadContext).toBe("vendor");
    expect(stored.outcome).toBeNull();
    expect(stored.escalated).toBe(false);
    // POST /drafts is the owner's composer — its rows are owner-origin,
    // which is what the client's #30 vocabulary keys off.
    expect(stored.provenance).toEqual({ origin: "owner" });
  });

  it("routes 'refuse' to a refused escalation and 'should I' to a judgment one", async () => {
    const refused = await (await post("/drafts", { question: "Please refuse to touch payroll for me." })).json();
    expect(refused.kind).toBe("escalation");
    expect(refused.refused).toBe(true);
    expect(typeof refused.reason).toBe("string");
    expect("confidence" in refused).toBe(false);

    const judgment = await (await post("/drafts", { question: "Should I approve the transfer?" })).json();
    expect(judgment.kind).toBe("escalation");
    expect(judgment.refused).toBe(false);
  });

  it("records a sent outcome, defaulting sentText to the draft text", async () => {
    const res = await post("/drafts/d-2/outcome", { outcome: "sent" });
    expect(res.status).toBe(200);
    const record = await res.json();
    expect(record.outcome).toBe("sent");
    expect(record.sentText).toBe(record.draftText);
    const pending = await (await get("/drafts?outcome=pending")).json();
    expect(pending.some((d) => d.id === "d-2")).toBe(false);
  });

  it("queues a style candidate when an outcome is an edit", async () => {
    const created = await (await post("/drafts", { question: "Where's the design spec?" })).json();
    const edited = await (
      await post(`/drafts/${created.draftId}/outcome`, { outcome: "edited", sentText: "Spec's in the drive — link in the wiki." })
    ).json();
    expect(edited.outcome).toBe("edited");
    expect(edited.sentText).toBe("Spec's in the drive — link in the wiki.");

    const review = await (await get("/review")).json();
    const candidate = review.find((c) => c.draftId === created.draftId);
    expect(candidate.kind).toBe("style");
    expect(candidate.draftText).toBe(created.text);
    expect(candidate.status).toBe("pending");
  });

  it("answers an escalation once, returning a candidate id", async () => {
    const res = await post("/drafts/d-4/answer", { answer: "Approved this once; flag the next one." });
    expect(res.status).toBe(200);
    const { candidateId } = await res.json();
    expect(typeof candidateId).toBe("string");

    const record = await (await get("/drafts/d-4")).json();
    expect(record.outcome).toBe("escalation_answered");

    const again = await post("/drafts/d-4/answer", { answer: "twice" });
    expect(again.status).toBe(400);
    expect((await again.json()).error.code).toBe("not_escalated");
  });

  it("fabricates a daemon-side draft through the mock-only push route", async () => {
    const res = await post("/mock/push-draft", { question: "Did the contract renew?" });
    expect(res.status).toBe(201);
    const record = await res.json();
    expect(record.outcome).toBeNull();
    const drafts = await (await get("/drafts")).json();
    expect(drafts.some((d) => d.id === record.id)).toBe(true);
  });
});

describe("mock daemon — mirror, trust, audit, ask (D2/D6)", () => {
  it("moves rules between review buckets and returns the updated Rule", async () => {
    const approved = await (await post("/mirror/rules/r-9/approve", {})).json();
    expect(approved.reviewStatus).toBe("approved");

    const promoted = await (await post("/mirror/rules/r-12/promote", {})).json();
    expect(promoted.reviewStatus).toBe("approved");
    expect(promoted.status).toBe("confirmed");

    const listing = await (await get("/mirror/rules")).json();
    expect(listing.awaitingApproval.some((r) => r.id === "r-9")).toBe(false);
    expect(listing.approved.some((r) => r.id === "r-9")).toBe(true);
    expect(listing.weakSignals.some((r) => r.id === "r-12")).toBe(false);

    const unknown = await post("/mirror/rules/r-999/approve", {});
    expect(unknown.status).toBe(404);
  });

  it("serves the three public-answer outcomes on POST /ask", async () => {
    const answered = await (await post("/ask", { question: "What's the refund policy?" })).json();
    expect(answered.kind).toBe("answered");
    expect(answered.duo).toBe("personal");
    expect(typeof answered.text).toBe("string");
    expect(answered.text).toContain("Confidence: 0.84");
    expect(answered.sources.length).toBeGreaterThan(0);

    const passed = await (await post("/ask", { question: "Can you pass this to the owner?" })).json();
    expect(passed.kind).toBe("passed_on");
    expect(typeof passed.text).toBe("string");

    const declined = await (await post("/ask", { question: "What's her salary?" })).json();
    expect(declined.kind).toBe("declined_refused");
    expect(typeof declined.text).toBe("string");

    // The device-principal-only fields never reach an asker (digital-duo
    // #159 R8) — pinning their absence is what keeps this mock honest
    // about the asker's envelope rather than the CLI's richer shape.
    for (const outcome of [answered, passed, declined]) {
      expect(outcome).not.toHaveProperty("draftId");
      expect(outcome).not.toHaveProperty("confidence");
      expect(outcome).not.toHaveProperty("evidenceAgeDays");
      expect(outcome).not.toHaveProperty("ownerNotice");
    }
  });

  it("seeds the read-only surfaces in their wire shapes", async () => {
    const portrait = await (await get("/mirror/portrait")).json();
    expect(portrait.tooThin).toBe(false);
    expect(portrait.topicBreakdown[0]).toEqual({ topicId: "t-sched", label: "scheduling", count: 73, share: 0.34 });

    const grid = await (await get("/trust/grid")).json();
    expect(grid.some((row) => row.stale)).toBe(true);
    expect(grid.some((row) => !Object.hasOwn(row, "topicLabel"))).toBe(true);

    const audit = await (await get("/audit")).json();
    expect(audit.length).toBe(3);
    expect(audit.some((e) => e.declined)).toBe(true);
    expect(audit.some((e) => !e.askerResolved)).toBe(true);

    const duos = await (await get("/duos")).json();
    expect(duos).toEqual([{ kind: "personal" }]);
  });
});

// GET-only, and placed last on the shared daemon: earlier describes POST, so
// expectations are derived from a live un-paged GET rather than the seed —
// the walk must hold for whatever state the run has accumulated.
describe("mock daemon — paged history (duo #29, mirroring digital-duo #203)", () => {
  it("GET /drafts?limit walks backward through newest-first windows, losing nothing", async () => {
    const ascending = (await (await get("/drafts")).json()).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    expect(ascending.length).toBeGreaterThanOrEqual(4);

    // Page one is the newest window, newest-first — which ids, not just how many.
    const pageOne = await (await get("/drafts?limit=2")).json();
    expect(pageOne.map((d) => d.id)).toEqual([ascending.at(-1).id, ascending.at(-2).id]);

    // `before` is exclusive: feeding page one's oldest back returns the
    // adjacent older window, not a re-read.
    const cursorOne = encodeURIComponent(pageOne.at(-1).createdAt);
    const pageTwo = await (await get(`/drafts?limit=2&before=${cursorOne}`)).json();
    expect(pageTwo.map((d) => d.id)).toEqual([ascending.at(-3).id, ascending.at(-4).id]);

    // Walking to the beginning ends in an empty page, having seen every
    // draft exactly once — overlap would duplicate, a wrong cursor would gap.
    const seen = [...pageOne.map((d) => d.id), ...pageTwo.map((d) => d.id)];
    let cursor = pageTwo.at(-1).createdAt;
    for (let guard = 0; guard < 50; guard += 1) {
      const page = await (await get(`/drafts?limit=2&before=${encodeURIComponent(cursor)}`)).json();
      if (page.length === 0) {
        break;
      }
      seen.push(...page.map((d) => d.id));
      cursor = page.at(-1).createdAt;
    }
    expect(seen).toEqual(ascending.map((d) => d.id).reverse());
  });

  it("validates limit the way the real route does: non-negative integer, literally", async () => {
    for (const raw of ["abc", "2.5", "-1", "01", ""]) {
      const res = await get(`/drafts?limit=${encodeURIComponent(raw)}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
    // 0 is a valid non-negative integer in the real route — an empty page.
    const zero = await get("/drafts?limit=0");
    expect(zero.status).toBe(200);
    expect(await zero.json()).toEqual([]);
  });

  it("before without limit stays the plain ascending list, filtered", async () => {
    const ascending = (await (await get("/drafts")).json()).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const ceiling = encodeURIComponent(ascending.at(-2).createdAt); // everything except the newest
    const res = await get(`/drafts?before=${ceiling}`);
    expect(res.status).toBe(200);
    const older = await res.json();
    expect(older.map((d) => d.id)).toEqual(ascending.slice(0, -2).map((d) => d.id));
  });

  it("composes outcome filtering with the paged window", async () => {
    const pending = (await (await get("/drafts?outcome=pending")).json()).slice().sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    if (pending.length === 0) {
      return; // nothing pending left in this run's state; the composition is unpinnable
    }
    const res = await get("/drafts?outcome=pending&limit=1");
    expect(res.status).toBe(200);
    const page = await res.json();
    expect(page.map((d) => d.id)).toEqual([pending.at(-1).id]);
  });
});
