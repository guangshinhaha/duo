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
    expect(drafts.map((d) => d.id)).toEqual(["e-1", "e-3", "e-4", "e-2", "d-1", "d-3", "d-4", "d-2"]);
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
    // d-1 is the seeded channel-borne draft, with #169's full shape —
    // permalink included, so #20's one-click-back is demoable against the mock.
    expect(seeded.find((d) => d.id === "d-1").provenance).toEqual({
      origin: "channel",
      channelKind: "slack",
      askerRef: "U04ARLJ9P",
      threadId: "C07H3Q2NA",
      permalink: "https://acme.slack.com/archives/C07H3Q2NA/p1726482364000100",
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
    // A draft arriving over /ws daemon-side is channel-borne (#169): the
    // owner's composer is the only owner-origin writer.
    expect(record.provenance).toEqual({
      origin: "channel",
      channelKind: "slack",
      askerRef: "U04ARLJ9P",
      threadId: "C07H3Q2NA",
      permalink: null,
    });
    const drafts = await (await get("/drafts")).json();
    expect(drafts.some((d) => d.id === record.id)).toBe(true);
  });

  it("records delivery through the origin channel when a channel draft is sent (#21)", async () => {
    // The seeded channel draft already went out clean.
    const seeded = await (await get("/drafts/d-1")).json();
    expect(seeded.delivery).toEqual({ state: "delivered" });

    // A fresh channel draft (the push route fabricates them channel-borne):
    // the mock connects no adapter, so recording "sent" records the same
    // honest failure a daemon with no adapter would — the core's own words.
    const pushed = await (await post("/mock/push-draft", { question: "Can you send the invoice?" })).json();
    await post(`/drafts/${pushed.id}/outcome`, { outcome: "sent" });
    const sent = await (await get(`/drafts/${pushed.id}`)).json();
    expect(sent.delivery).toEqual({ state: "failed", reason: 'no connected adapter for channel kind "slack"' });

    // An owner-asked draft delivers nothing — nowhere to deliver, not an error.
    const ownerAsk = await post("/drafts", { question: "What is our refund policy?" });
    const { draftId } = await ownerAsk.json();
    await post(`/drafts/${draftId}/outcome`, { outcome: "sent" });
    const ownerRecord = await (await get(`/drafts/${draftId}`)).json();
    expect(ownerRecord.delivery).toBeNull();

    // And "discarded" means nothing was sent — no delivery to record.
    const discarded = await (await post("/mock/push-draft", { question: "Draft me a status update" })).json();
    await post(`/drafts/${discarded.id}/outcome`, { outcome: "discarded" });
    const discardedRecord = await (await get(`/drafts/${discarded.id}`)).json();
    expect(discardedRecord.delivery).toBeNull();
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

  it("serves GET /mirror/rules/:id as RuleWithEvidence — the rule and the exchanges it cites (#182)", async () => {
    const res = await get("/mirror/rules/r-15");
    expect(res.status).toBe(200);
    const detail = await res.json();
    expect(detail.rule.id).toBe("r-15");
    expect(detail.evidence.length).toBe(detail.rule.supportCount);
    for (const exchange of detail.evidence) {
      expect(typeof exchange.qaPairId).toBe("string");
      expect(typeof exchange.questionText).toBe("string");
      expect(typeof exchange.answerText).toBe("string");
    }
    expect((await get("/mirror/rules/r-999")).status).toBe(404);
  });

  it("serves GET /mirror/refusals as { decided, refusals } — file state, not a list alone (#182)", async () => {
    const res = await get("/mirror/refusals");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.decided).toBe(true);
    expect(body.refusals.length).toBeGreaterThan(0);
    for (const refusal of body.refusals) {
      expect(typeof refusal.heading).toBe("string");
      expect(typeof refusal.reason).toBe("string");
    }
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
    // #40: the seed now carries both wire shapes — the shared duo is what
    // a trusted device sees, so the roster's two labels are exercisable
    // against the mock, not only against unit stubs.
    expect(duos).toEqual([{ kind: "personal" }, { kind: "shared", ownerId: "owner-1", ownerName: "River" }]);
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

describe("mock daemon — the correction queue's disposition routes (duo #44, mirroring digital-duo #173)", () => {
  it("lists every status bare, and filters on ?status=, the way listCorrectionCandidates does", async () => {
    const bare = await (await get("/review")).json();
    // The seed's c-1 is pending; anything earlier tests queued is pending
    // too — so bare (all statuses) is a superset of the pending filter.
    const pending = await (await get("/review?status=pending")).json();
    expect(bare.length).toBeGreaterThanOrEqual(pending.length);
    expect(pending.every((c) => c.status === "pending")).toBe(true);
    // Ascending by creation, the daemon's order — never newest-first.
    const times = bare.map((c) => c.createdAt);
    expect([...times].sort()).toEqual(times);
  });

  it("approves a pending candidate: status flips, reviewedAt stamps, the candidate comes back", async () => {
    const before = await (await get("/review?status=pending")).json();
    if (before.length === 0) {
      return; // this run's queue was emptied by earlier tests; nothing to pin
    }
    const target = before[0];
    const res = await post(`/review/${target.id}/approve`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.candidate.id).toBe(target.id);
    expect(body.candidate.status).toBe("approved");
    expect(body.candidate.reviewedAt).not.toBeNull();
    // The route returns the write result beside the candidate, as #173 does.
    expect(body.result.kind).toBe(target.kind);

    const after = await (await get("/review?status=pending")).json();
    expect(after.some((c) => c.id === target.id)).toBe(false);
  });

  it("rejecting works the same, and the daemon's 409 is the honest word for a double decision", async () => {
    const before = await (await get("/review?status=pending")).json();
    if (before.length === 0) {
      return;
    }
    const target = before[0];
    const rejected = await post(`/review/${target.id}/reject`);
    expect(rejected.status).toBe(200);
    expect((await rejected.json()).candidate.status).toBe("rejected");

    // Decide it again — the mock is in memory, so the row remembers.
    const again = await post(`/review/${target.id}/approve`);
    expect(again.status).toBe(409);
    const error = (await again.json()).error;
    expect(error.code).toBe("CandidateAlreadyReviewedError");
    expect(error.message).toBe(`Correction candidate "${target.id}" was already reviewed (status: "rejected")`);
  });

  it("an unknown id is the review layer's own 404", async () => {
    const res = await post("/review/nope/approve");
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe('No pending correction candidate with id "nope"');
  });
});

describe("mock daemon — the knowledge read (duo #45, mirroring digital-duo #175)", () => {
  it("composes the corpus slice from the portrait it already serves — one verdict, not two", async () => {
    const knowledge = await (await get("/knowledge")).json();
    const portrait = await (await get("/mirror/portrait")).json();
    // The knowledge screen's corpus fields are the portrait's own — the
    // same tooThin, the same topics, the same threshold. If these ever
    // diverge, the mock is serving two verdicts about one corpus.
    expect(knowledge.corpus).toEqual({
      tooThin: portrait.tooThin,
      minimumQuestionsToCharacterize: portrait.minimumQuestionsToCharacterize,
      totalQuestions: portrait.totalQuestions,
      periodStart: portrait.periodStart,
      periodEnd: portrait.periodEnd,
      topicBreakdown: portrait.topicBreakdown,
    });
  });

  it("counts rules from the buckets it already serves, and names its providers", async () => {
    const knowledge = await (await get("/knowledge")).json();
    const rules = await (await get("/mirror/rules")).json();
    // pending = everything awaiting a decision in any bucket; the decided
    // statuses count their own buckets; superseded is nothing the mock mints.
    expect(knowledge.rules.byReviewStatus).toEqual({
      pending: rules.awaitingApproval.length + rules.weakSignals.length + rules.inconsistent.length,
      approved: rules.approved.length,
      rejected: rules.rejected.length,
      superseded: 0,
    });
    expect(typeof knowledge.providers.inference).toBe("string");
    expect(knowledge.providers.embedding).toHaveProperty("model");
    expect(knowledge.records.total).toBeGreaterThan(0);
  });

  it("reports usage with the daemon's own arithmetic — rates that match their counts", async () => {
    const knowledge = await (await get("/knowledge")).json();
    const usage = knowledge.sharedUsage;
    expect(usage.answerRate).toBeCloseTo(usage.answeredCount / usage.totalQuestions, 10);
    expect(usage.summary).toMatch(/shared duo/i);
    if (usage.totalQuestions === 0) {
      // The core's exact never-used line — the one place that sentence is
      // guaranteed (core #71 AC4).
      expect(usage.summary).toBe("The shared duo is not being used.");
    }
  });
});

describe("mock daemon — corpus search (duo #46, mirroring digital-duo #174)", () => {
  it("ranks by the mock's documented heuristic and stamps ranks the daemon's way", async () => {
    const res = await get(`/search?q=${encodeURIComponent("vendor")}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.results.length).toBeGreaterThan(0);
    // Rank is the position in the full ranked list, 0-based — the cursor
    // contract pages by "last rank + 1".
    expect(body.results.map((r) => r.rank)).toEqual(body.results.map((_, i) => i));
    // The mock's heuristic: more occurrences of the term rank first (the
    // real thing fuses FTS and vectors; substring counting is enough to
    // exercise the ordering and paging contracts).
    const counts = body.results.map((r) => (r.record.text.toLowerCase().match(/vendor/g) ?? []).length);
    expect([...counts].sort((a, b) => b - a)).toEqual(counts);
    // Enough context to recognise each one rides along.
    for (const r of body.results) {
      expect(r.record.source).toBeTruthy();
      expect(r.record.text.length).toBeGreaterThan(0);
    }
    expect(body.usedEmbeddings).toBe(true);
  });

  it("pages with cursor the way the daemon does: default limit 10, ranks continue", async () => {
    const full = await (await get(`/search?q=${encodeURIComponent("duo")}`)).json();
    // The seed has exactly twelve records mentioning "duo", so the default
    // limit cuts the first page at ten and leaves two.
    expect(full.results).toHaveLength(10);
    const second = await (await get(`/search?q=${encodeURIComponent("duo")}&cursor=10`)).json();
    // Ranks continue where page one ended — the position in the full list,
    // not a re-ranking — and seed order is the tiebreak, so the tail is
    // exactly the last two seeded records.
    expect(second.results.map((r) => r.rank)).toEqual([10, 11]);
    expect(second.results.map((r) => r.record.id)).toEqual(["rec-10", "rec-11"]);
  });

  it("validates the query string with the daemon's own words", async () => {
    const blank = await get("/search");
    expect(blank.status).toBe(400);
    expect((await blank.json()).error.message).toBe("q is required and must not be blank");
    const spaces = await get(`/search?q=${encodeURIComponent("   ")}`);
    expect(spaces.status).toBe(400);
    for (const raw of ["0", "101", "abc"]) {
      const res = await get(`/search?q=duo&limit=${raw}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toBe("limit must be an integer between 1 and 100");
    }
    for (const raw of ["-1", "x"]) {
      const res = await get(`/search?q=duo&cursor=${raw}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toBe("cursor must be a non-negative integer");
    }
  });

  it("a query matching nothing is an empty result, not an error", async () => {
    const res = await get(`/search?q=${encodeURIComponent("zzzyyyxxx")}`);
    expect(res.status).toBe(200);
    expect((await res.json()).results).toEqual([]);
  });
});

describe("mock daemon — channels and their policy (duo #47, mirroring digital-duo #171 and #172)", () => {
  it("serves one row per adapter in ChannelSummary's shape, failure reasons included", async () => {
    const res = await get("/channels");
    expect(res.status).toBe(200);
    const channels = await res.json();
    expect(channels.length).toBeGreaterThanOrEqual(2);
    for (const channel of channels) {
      expect(typeof channel.kind).toBe("string");
      expect(typeof channel.label).toBe("string");
      expect(["connected", "failed"]).toContain(channel.state);
      expect(channel.lastActivityAt === null || typeof channel.lastActivityAt === "string").toBe(true);
      expect(typeof channel.muted).toBe("boolean");
      // `reason` is present iff the channel has failed — the adapter's own words.
      expect("reason" in channel).toBe(channel.state === "failed");
    }
    expect(channels.some((c) => c.state === "failed")).toBe(true);
    expect(channels.some((c) => c.state === "connected")).toBe(true);
  });

  it("mute and unmute round-trip through one store — the row and the policy agree", async () => {
    const [first] = await (await get("/channels")).json();
    const mute = await post("/channels/policy/mute", { channel: first.kind });
    expect(mute.status).toBe(200);
    expect((await mute.json()).muted).toContain(first.kind);
    expect((await (await get("/channels")).json()).find((c) => c.kind === first.kind).muted).toBe(true);
    expect((await (await get("/channels/policy")).json()).muted).toContain(first.kind);

    // Idempotent, like the real store.
    const again = await (await post("/channels/policy/mute", { channel: first.kind })).json();
    expect(again.muted.filter((k) => k === first.kind)).toHaveLength(1);

    const unmute = await post("/channels/policy/unmute", { channel: first.kind });
    expect((await unmute.json()).muted).not.toContain(first.kind);
    expect((await (await get("/channels")).json()).find((c) => c.kind === first.kind).muted).toBe(false);
  });

  it("matches a mute against the channel's kind case-insensitively, as describeChannels does", async () => {
    const [first] = await (await get("/channels")).json();
    await post("/channels/policy/mute", { channel: first.kind.toUpperCase() });
    expect((await (await get("/channels")).json()).find((c) => c.kind === first.kind).muted).toBe(true);
    await post("/channels/policy/unmute", { channel: first.kind });
  });

  it("scopes a thread mute below its channel without muting the channel (#172 AC2)", async () => {
    const [first] = await (await get("/channels")).json();
    const res = await post("/channels/policy/mute", { channel: first.kind, threadId: "t-1" });
    const policy = await res.json();
    expect(policy.mutedThreads).toEqual([{ channel: first.kind, threadId: "t-1" }]);
    expect(policy.muted).not.toContain(first.kind);
    expect((await (await get("/channels")).json()).find((c) => c.kind === first.kind).muted).toBe(false);
    await post("/channels/policy/unmute", { channel: first.kind, threadId: "t-1" });
  });

  it("refuses a bad mute target with the daemon's own words", async () => {
    const missing = await post("/channels/policy/mute", {});
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toEqual({ code: "bad_request", message: "channel is required and must be a non-empty string" });
    const slash = await post("/channels/policy/mute", { channel: "a/b" });
    expect(slash.status).toBe(400);
    expect((await slash.json()).error.message).toBe(
      'channel must not contain "/" — it scopes a thread within a channel — got "a/b"',
    );
  });
});

// The paired-devices routes (duo #48, mirroring digital-duo #177): GET /devices
// answers the DeviceToken shape — no token or hash field — and
// POST /devices/:id/revoke answers the revoked row, idempotently, 404 for a stranger.
describe("mock daemon — paired devices (duo #48, mirroring digital-duo #177)", () => {
  it("lists devices in the DeviceToken shape, oldest first, with no token or hash field anywhere", async () => {
    const res = await get("/devices");
    expect(res.status).toBe(200);
    const devices = await res.json();
    expect(devices.length).toBeGreaterThanOrEqual(2);
    for (const device of devices) {
      expect(Object.keys(device).sort()).toEqual(["createdAt", "id", "lastSeenAt", "name", "revokedAt"]);
    }
    const times = devices.map((d) => d.createdAt);
    expect([...times].sort()).toEqual(times);
    expect(JSON.stringify(devices)).not.toContain("mock-token");
  });

  it("revokes a device: the revoked row comes back, the list shows it revoked, and revoking twice is a no-op, not an error", async () => {
    const before = await (await get("/devices")).json();
    const target = before.find((d) => d.revokedAt === null);
    const first = await post(`/devices/${target.id}/revoke`);
    expect(first.status).toBe(200);
    const revoked = await first.json();
    expect(revoked.id).toBe(target.id);
    expect(revoked.revokedAt).not.toBeNull();

    const again = await post(`/devices/${target.id}/revoke`);
    expect(again.status).toBe(200);
    expect((await again.json()).revokedAt).toBe(revoked.revokedAt);

    const after = await (await get("/devices")).json();
    expect(after.find((d) => d.id === target.id).revokedAt).toBe(revoked.revokedAt);
  });

  it("a device id nobody paired is the daemon's 404, in its own words", async () => {
    const res = await post("/devices/not-a-real-id/revoke");
    expect(res.status).toBe(404);
    const error = (await res.json()).error;
    expect(error.code).toBe("DeviceTokenNotFoundError");
    expect(error.message).toBe('No paired device with id "not-a-real-id"');
  });
});

describe("mock daemon — escalation digests, history, and rate (duo #54, mirroring digital-duo #178)", () => {
  it("pages history the daemon's way: oldest first, default limit 10, the offset cursor, and its own 400 words", async () => {
    const all = await (await get("/escalations/history?limit=100")).json();
    expect(all.length).toBeGreaterThan(1);
    for (const row of all) {
      expect(Object.keys(row).sort()).toEqual(["createdAt", "id", "itemCount", "items"]);
      expect(row.itemCount).toBe(row.items.length);
    }
    expect(all.map((d) => d.createdAt)).toEqual(all.map((d) => d.createdAt).slice().sort());

    const rest = await (await get("/escalations/history?limit=1&cursor=1")).json();
    expect(rest.map((d) => d.id)).toEqual([all[1].id]);
    expect((await (await get("/escalations/history")).json()).length).toBe(Math.min(10, all.length));

    for (const bad of ["limit=0", "limit=101", "limit=x", "cursor=-1", "cursor=x"]) {
      const res = await get(`/escalations/history?${bad}`);
      expect(res.status, bad).toBe(400);
      expect((await res.json()).error.code).toBe("bad_request");
    }
  });

  it("carries the digest items' wire shape, and only drafts the mock actually holds — every one openable", async () => {
    const all = await (await get("/escalations/history?limit=100")).json();
    const items = all.flatMap((d) => d.items);
    for (const item of items) {
      expect(Object.keys(item).sort()).toEqual(["createdAt", "draftId", "escalationReason", "question", "threadContext"]);
      const res = await get(`/drafts/${item.draftId}`);
      expect(res.status).toBe(200);
      expect((await res.json()).escalated).toBe(true);
    }
    // A recurring question is what the view exists to show.
    const counts = new Map();
    for (const item of items) {
      counts.set(item.question, (counts.get(item.question) ?? 0) + 1);
    }
    expect(Math.max(...counts.values())).toBeGreaterThan(1);
  });

  it("reports a rate whose figure is its own counts' quotient, never NaN on nothing", async () => {
    const rate = await (await get("/escalations/rate")).json();
    expect(Object.keys(rate).sort()).toEqual(["rate", "total", "urgent"]);
    expect(rate.total).toBeGreaterThan(0);
    expect(rate.rate).toBeCloseTo(rate.urgent / rate.total, 10);
  });

  it("serves no POST /escalations/digest — assembling is the send, and no client reads through it", async () => {
    expect((await post("/escalations/digest", {})).status).toBe(404);
  });
});

describe("mock daemon — first run over HTTP (duo #49, mirroring digital-duo #176)", () => {
  // Its own instance, started empty: the first run mutates the corpus, and
  // every other describe here reads the seeded one.
  let firstRun;
  let firstBase;
  beforeAll(async () => {
    firstRun = createMockDaemon({ empty: true, embedTickMs: 400 }).server;
    await new Promise((resolve) => firstRun.listen(0, "127.0.0.1", resolve));
    firstBase = `http://127.0.0.1:${firstRun.address().port}`;
  });
  afterAll(async () => {
    firstRun.closeAllConnections?.();
    await new Promise((resolve) => firstRun.close(resolve));
  });
  const fget = (path) => fetch(`${firstBase}${path}`, { headers: auth });
  const fpost = (path, body) => fetch(`${firstBase}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body ?? {}) });

  const TRANSCRIPT = "Me: Can you send the vendor invoice today?\nClaude: Yes, sending it now.\nMe: Thanks.";

  it("starts empty when asked to: no records, no import, no rules — the daemon's own facts for a first run", async () => {
    const knowledge = await (await fget("/knowledge")).json();
    expect(knowledge.records.total).toBe(0);
    expect(knowledge.lastImport).toBeNull();
    expect(Object.values(knowledge.rules.byReviewStatus).reduce((a, b) => a + b, 0)).toBe(0);
    expect(await (await fget("/corpus/embed")).json()).toMatchObject({ state: "idle", embedded: 0, total: 0, error: null });
  });

  it("validates the import with the daemon's own words, and refuses a transcript with no turn as the parser does", async () => {
    const blank = await fpost("/corpus/import-paste", { transcript: "  " });
    expect(blank.status).toBe(400);
    expect((await blank.json()).error.message).toBe("transcript is required and must be a non-empty string");
    const malformed = await fpost("/corpus/import-paste", { transcript: "no turns here" });
    expect(malformed.status).toBe(400);
    const error = (await malformed.json()).error;
    expect(error.code).toBe("MalformedTranscriptError");
    expect(error.message).toMatch(/Found no recognisable turn/);
  });

  it("imports a pasted transcript and returns the summary the CLI would print; the knowledge read moves with it", async () => {
    const res = await fpost("/corpus/import-paste", { transcript: TRANSCRIPT });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ workRelevant: true, written: 3, skipped: 0, discardedAboveCeiling: 0 });
    const knowledge = await (await fget("/knowledge")).json();
    expect(knowledge.records.total).toBe(3);
    expect(knowledge.lastImport.written).toBe(3);
  });

  it("a second import of the same text behaves as the CLI's second import does — it invents no dedupe", async () => {
    const res = await fpost("/corpus/import-paste", { transcript: TRANSCRIPT });
    expect(await res.json()).toEqual({ workRelevant: true, written: 3, skipped: 0, discardedAboveCeiling: 0 });
    expect((await (await fget("/knowledge")).json()).records.total).toBe(6);
  });

  it("embeds as a job: 202 with the starting status, a 409 while it runs, and progress that climbs to the total", async () => {
    const started = await fpost("/corpus/embed");
    expect(started.status).toBe(202);
    expect(await started.json()).toMatchObject({ state: "running", embedded: 0, error: null });
    const again = await fpost("/corpus/embed");
    expect(again.status).toBe(409);
    expect((await again.json()).error.code).toBe("embed_already_running");

    let status = await (await fget("/corpus/embed")).json();
    for (let i = 0; i < 300 && status.state === "running"; i++) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      status = await (await fget("/corpus/embed")).json();
    }
    expect(status).toMatchObject({ state: "done", embedded: 6, total: 6, error: null });
    expect(status.finishedAt).not.toBeNull();
  });

  it("derivation is a terminal stage in the real daemon: there is no derive route, and the mock-only stand-in stages what `duo derive` would have produced", async () => {
    expect((await fpost("/corpus/derive")).status).toBe(404);
    const before = await (await fget("/mirror/rules")).json();
    expect(before.awaitingApproval).toEqual([]);
    expect((await fpost("/mock/derive")).status).toBe(200);
    const after = await (await fget("/mirror/rules")).json();
    expect(after.awaitingApproval.length).toBeGreaterThan(0);
    const knowledge = await (await fget("/knowledge")).json();
    expect(knowledge.rules.byReviewStatus.pending).toBeGreaterThan(0);
  });
});

describe("mock daemon — lifecycle (duo #55, mirroring digital-duo #181)", () => {
  // Ending kills the daemon's tokens, so these run against their own
  // instances — the shared one above must stay alive for every other test.
  async function withOwnDaemon(run) {
    const own = createMockDaemon().server;
    await new Promise((resolve) => own.listen(0, "127.0.0.1", resolve));
    const ownBase = `http://127.0.0.1:${own.address().port}`;
    try {
      await run({
        get: (path) => fetch(`${ownBase}${path}`, { headers: auth }),
        post: (path, body) => fetch(`${ownBase}${path}`, { method: "POST", headers: auth, body: JSON.stringify(body) }),
        health: () => fetch(`${ownBase}/health`),
      });
    } finally {
      own.closeAllConnections?.();
      await new Promise((resolve) => own.close(resolve));
    }
  }

  it("GET /lifecycle is the record plus every transfer's state, in the core's shapes", async () => {
    const res = await get("/lifecycle");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.lifecycle).toEqual({
      status: "active",
      archivedBy: null,
      archivedAt: null,
      orphanedBy: null,
      orphanedAt: null,
      orphanReason: null,
      transferredFrom: null,
      transferredTo: null,
      transferredAt: null,
    });
    expect(body.transfers).toEqual([]);
  });

  it("POST /lifecycle/end refuses an unnamed decider, in the daemon's words", async () => {
    for (const body of [{}, { confirmed: true }, { decidedBy: "  ", confirmed: true }, { decidedBy: 7 }]) {
      const res = await post("/lifecycle/end", body);
      expect(res.status).toBe(400);
      const error = (await res.json()).error;
      expect(error.code).toBe("bad_request");
      expect(error.message).toContain("requires naming who decided it");
    }
  });

  it("without confirmed it only describes — and describes the same again, because nothing went", async () => {
    await withOwnDaemon(async ({ get: ownGet, post: ownPost }) => {
      const first = await (await ownPost("/lifecycle/end", { decidedBy: "river" })).json();
      const second = await (await ownPost("/lifecycle/end", { decidedBy: "river", confirmed: false })).json();
      expect(first.confirmed).toBe(false);
      expect(first.storePaths.length).toBeGreaterThan(0);
      expect(first.duoDirPaths.length).toBeGreaterThan(0);
      expect(typeof first.storeDataDir).toBe("string");
      expect(typeof first.duoDir).toBe("string");
      expect(second).toEqual(first);
      // Still alive.
      expect((await ownGet("/drafts")).status).toBe(200);
    });
  });

  it("only `confirmed: true` (literally) ends it — and every token dies with it, a clean 401, not a 500", async () => {
    await withOwnDaemon(async ({ get: ownGet, post: ownPost, health }) => {
      for (const looseTruth of ["true", 1, "yes"]) {
        expect((await (await ownPost("/lifecycle/end", { decidedBy: "river", confirmed: looseTruth })).json()).confirmed).toBe(false);
      }
      expect((await ownGet("/drafts")).status).toBe(200);

      const result = await (await ownPost("/lifecycle/end", { decidedBy: "river", confirmed: true })).json();
      expect(result.confirmed).toBe(true);

      for (const res of [await ownGet("/drafts"), await ownGet("/lifecycle"), await ownPost("/lifecycle/end", { decidedBy: "river", confirmed: true })]) {
        expect(res.status).toBe(401);
        expect((await res.json()).error.code).toBe("unauthorized");
        expect(res.headers.get("access-control-allow-origin")).toBe("*");
      }
      // The process itself is still up — only its store and tokens are gone.
      expect((await health()).status).toBe(200);
    });
  });
});
