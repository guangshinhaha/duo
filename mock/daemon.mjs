// The mock daemon (duo #16). Everything the client's api layer calls,
// served from this repo with zero dependencies, so the client runs end to
// end while the real daemon's browser blockers stay open on its side:
// no CORS headers yet (digital-duo #167), POST /ask unserved (#157-#160),
// /ws unserved (#162). The CORS header set below is exactly what #167
// proposes — this file doubles as a live reference for it.
//
// Swapping to the real daemon is re-pairing in Settings with the real
// address: nothing in src/ knows this file exists, by design (KTD-7).

import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { attachDraftReadySocket } from "./ws.mjs";

export const DEFAULT_PORT = 7720;
export const DEFAULT_HOST = "127.0.0.1";

// The escalation threshold every seeded and generated confidence result
// carries — the value DraftRecord.escalationThreshold documents as "the
// one actually in effect", not a guess.
const THRESHOLD = 0.55;

const minutesAgo = (m) => new Date(Date.now() - m * 60_000).toISOString();

// #54: the escalation history the seed already lived through — the same
// judgment question asked again and again (the pattern's whole point), one
// distinct question, and one urgent escalation, which interrupts live and so
// is in no digest (digital-duo #178's `checkUrgentEscalations` path).
const PAY_FIX = "Should I approve Priya's backdated pay fix?";
const PAY_FIX_REASON = "This touches the payroll correction you said only you decide on.";

function escalatedSeed(id, question, reason, minutes, confidenceScore) {
  return {
    id,
    question,
    threadContext: null,
    draftText: null,
    escalated: true,
    escalationReason: reason,
    confidenceScore,
    sources: [],
    createdAt: minutesAgo(minutes),
    // Answered long ago — and still asked again, which is the pattern.
    outcome: "escalation_answered",
    outcomeRecordedAt: minutesAgo(minutes - 30),
    sentText: null,
    refused: false,
    escalationThreshold: THRESHOLD,
    provenance: { origin: "owner" },
    delivery: null,
  };
}

// Three sent digests, oldest first, over the escalations above and d-4. Each
// item is the digest row's wire shape (`EscalationDigestItem`), built from
// the draft it names so the two can never disagree.
function seedEscalationDigests(drafts) {
  const byId = new Map(drafts.map((d) => [d.id, d]));
  const item = (id) => {
    const d = byId.get(id);
    return { draftId: d.id, question: d.question, threadContext: d.threadContext, escalationReason: d.escalationReason, createdAt: d.createdAt };
  };
  const digest = (id, minutes, ids) => ({ id, createdAt: minutesAgo(minutes), itemCount: ids.length, items: ids.map(item) });
  return [digest("dg-1", 60 * 24 * 7, ["e-1", "e-3"]), digest("dg-2", 60 * 24 * 3, ["e-2"]), digest("dg-3", 60, ["d-4"])];
}

// The daemon's urgency classification is a keyword heuristic over the
// question and its context (`src/escalation/urgency.ts`); this is the mock's
// stand-in, enough to give the rate a non-trivial numerator.
const isUrgent = (draft) => /\b(is down|outage|breach)\b/i.test(`${draft.question} ${draft.threadContext ?? ""}`);

function seedState() {
  const state = {
    // #55: flips on a confirmed POST /lifecycle/end — see the auth guard.
    ended: false,
    drafts: [
      escalatedSeed("e-1", PAY_FIX, PAY_FIX_REASON, 60 * 24 * 9, 0.47),
      escalatedSeed("e-3", "Which vendor do we use for payroll audits?", "Nothing in your records answers this.", 60 * 24 * 8, 0.31),
      escalatedSeed("e-4", "The invoicing service is down — who do I call?", "This reads as urgent; your duo will not guess.", 60 * 24 * 6, 0.29),
      escalatedSeed("e-2", PAY_FIX, PAY_FIX_REASON, 60 * 24 * 4, 0.52),
      {
        id: "d-1",
        question: "Can you follow up on the vendor invoice?",
        threadContext: null,
        draftText: "Wrapped — I chased the vendor and updated the sheet with the new ETA.",
        escalated: false,
        escalationReason: null,
        confidenceScore: 0.83,
        sources: [
          { kind: "rule", id: "r-3", label: "Money questions go out same day" },
          { kind: "evidence", id: "ev-31", label: "Vendor thread, Tuesday" },
        ],
        createdAt: minutesAgo(60 * 24 * 3),
        outcome: "sent",
        outcomeRecordedAt: minutesAgo(60 * 24 * 3 - 20),
        sentText: null,
        refused: false,
        escalationThreshold: THRESHOLD,
        // One seeded draft is channel-borne (digital-duo #169's full
        // shape) so the client's two vocabularies — Send for a reply to
        // someone, Keep for an answer to yourself (#30) — are both
        // demoable against the mock, with a permalink so #20's
        // one-click-back is too.
        provenance: {
          origin: "channel",
          channelKind: "slack",
          askerRef: "U04ARLJ9P",
          threadId: "C07H3Q2NA",
          permalink: "https://acme.slack.com/archives/C07H3Q2NA/p1726482364000100",
        },
        // Sent through its origin channel, and it arrived (#21's happy path).
        delivery: { state: "delivered" },
      },
      {
        id: "d-3",
        question: "What should I tell the team about next week?",
        threadContext: "leave",
        draftText: "I'm off next Friday; back the following Monday.",
        escalated: false,
        escalationReason: null,
        confidenceScore: 0.79,
        sources: [{ kind: "evidence", id: "ev-40", label: "Calendar, week of the 21st" }],
        createdAt: minutesAgo(60 * 24),
        outcome: "edited",
        outcomeRecordedAt: minutesAgo(60 * 24 - 15),
        sentText: "I'm off next Friday, back the following Monday — anything urgent, ping Sam.",
        refused: false,
        escalationThreshold: THRESHOLD,
        provenance: { origin: "owner" },
        delivery: null,
      },
      {
        id: "d-4",
        question: "Should I approve Priya's backdated pay fix?",
        threadContext: null,
        draftText: null,
        escalated: true,
        escalationReason: "This touches the payroll correction you said only you decide on.",
        confidenceScore: 0.47,
        sources: [],
        createdAt: minutesAgo(120),
        outcome: null,
        outcomeRecordedAt: null,
        sentText: null,
        refused: false,
        escalationThreshold: THRESHOLD,
        provenance: { origin: "owner" },
        delivery: null,
      },
      {
        id: "d-2",
        question: "Am I free Thursday afternoon?",
        threadContext: null,
        draftText: "Yes — Thursday after 3pm is open. I can hold the slot until tonight.",
        escalated: false,
        escalationReason: null,
        confidenceScore: 0.88,
        sources: [{ kind: "rule", id: "r-9", label: "Answer scheduling questions from the shared calendar" }],
        createdAt: minutesAgo(40),
        outcome: null,
        outcomeRecordedAt: null,
        sentText: null,
        refused: false,
        escalationThreshold: THRESHOLD,
        provenance: { origin: "owner" },
        delivery: null,
      },
    ],
    candidates: [
      {
        id: "c-1",
        kind: "style",
        draftId: "d-3",
        question: "What should I tell the team about next week?",
        draftText: "I'm off next Friday; back the following Monday.",
        sentText: "I'm off next Friday, back the following Monday — anything urgent, ping Sam.",
        status: "pending",
        createdAt: minutesAgo(60 * 24 - 10),
        reviewedAt: null,
      },
    ],
    rules: {
      awaitingApproval: [
        rule("r-9", "t-sched", "Answer scheduling questions from the shared calendar before noon.", "confirmed", 7, 0.9),
      ],
      weakSignals: [rule("r-12", "t-design", "Prefer async video replies for design feedback.", "weak_signal", 3, 0.55)],
      inconsistent: [rule("r-15", "t-comms", "Reply to every message within an hour.", "inconsistent", 9, 0.4)],
      approved: [rule("r-3", "t-money", "Money questions go out same day.", "confirmed", 12, 0.95, "owner_asserted")],
      rejected: [],
    },
    // GET /mirror/refusals (digital-duo #182): pure duo/refusals.md file
    // state — `decided` is whether that file exists at all, `refusals` its
    // `##` sections (heading = what is refused, reason = the owner's own
    // words, possibly empty). Read-only here as on the daemon: add and
    // confirm-none stay terminal-only (AR-18).
    refusals: {
      decided: true,
      refusals: [
        { heading: "Salary and pay", reason: "Never speak for me on pay or offers — that is a conversation I have myself." },
        { heading: "Legal holds", reason: "" },
      ],
    },
    portrait: {
      totalQuestions: 214,
      periodStart: minutesAgo(60 * 24 * 30),
      periodEnd: minutesAgo(0),
      topicBreakdown: [
        { topicId: "t-sched", label: "scheduling", count: 73, share: 0.34 },
        { topicId: "t-money", label: "money", count: 45, share: 0.21 },
        { topicId: "t-hiring", label: "hiring", count: 26, share: 0.12 },
        { topicId: "t-design", label: "design", count: 17, share: 0.08 },
      ],
      topFiveShare: 0.62,
      busiestThreads: [
        { threadId: "leave", count: 12, share: 0.06 },
        { threadId: "vendor-renewal", count: 9, share: 0.04 },
        { threadId: "design-review", count: 7, share: 0.03 },
      ],
      tooThin: false,
      minimumQuestionsToCharacterize: 10,
    },
    // The knowledge read's daemon-side facts (#175), seeded. The corpus
    // slice and the rule counts are NOT here — the route composes them
    // from the portrait and rules this mock already serves, so the two
    // surfaces can never disagree about one corpus. Arithmetic stays
    // honest: staged = written + alreadyPresent + skipped + discarded.
    knowledge: {
      records: { total: 312, bySource: { slack: 288, markdown: 24 } },
      lastImport: {
        runAt: minutesAgo(60 * 26),
        staged: 318,
        written: 24,
        alreadyPresent: 288,
        skippedDmConversations: 4,
        discardedOtherText: 2,
        discardedAboveCeiling: 0,
      },
      providers: { inference: "qwen-local", embedding: { name: "ollama", model: "nomic-embed-text" } },
      sharedUsage: {
        totalQuestions: 55,
        distinctAskers: 9,
        repeatAskers: 4,
        answeredCount: 41,
        declinedCount: 14,
        answerRate: 41 / 55,
        escalationRate: 14 / 55,
        weeklyTrend: [
          { weekStart: "2026-09-07", questionCount: 21 },
          { weekStart: "2026-09-14", questionCount: 34 },
        ],
        gaps: [{ question: "What's the wifi password?", count: 3 }],
        lastAskedAt: minutesAgo(60 * 20),
        daysSinceLastAsk: 1,
        abandoned: false,
        summary: "The shared duo answered 41 of 55 questions over the last month.",
      },
    },
    // The registered channel adapters (#171), as their own status probes
    // would report them: a kind, the adapter's own label, its health, and
    // when it last carried something. `muted` is NOT stored here — like the
    // real describeChannels, the route reads it off the one mute store
    // below, so a row and the policy can never disagree. One healthy, one
    // failed (with the adapter's own reason), so both renderings are
    // exercisable; nothing here is special to the client, which recognises
    // neither kind.
    channels: [
      { kind: "slack", label: "Acme workspace", state: "connected", lastActivityAt: minutesAgo(35) },
      {
        kind: "mail-bridge",
        label: "support@acme.example",
        state: "failed",
        reason: "Login rejected by the mail server — the app password was revoked.",
        lastActivityAt: null,
      },
    ],
    // The one mute store (#172): channel kinds, plus thread mutes scoped
    // below a channel. Empty at boot — nothing is muted until the owner says.
    mutePolicy: { muted: [], mutedThreads: [] },
    // The corpus /search serves (#46). Every record mentions "duo" exactly
    // once, so q=duo ranks in pure seed order (twelve records — enough to
    // page); the "vendor" trio carries three, two, and one occurrences so
    // q=vendor exercises the ordering. The real thing fuses FTS5 and vector
    // similarity (#174); this mock's documented stand-in is
    // case-insensitive substring counting, seed order as the tiebreak —
    // enough to exercise every paging and validation contract the client
    // relies on.
    records: [
      { id: "rec-0", source: "slack", sourceRef: "https://acme.slack.com/archives/C07H3Q2NA/p1726500000000001", kind: "decision", author: "me", text: "The duo renewal: the vendor contract goes to the vendor desk, vendor paperwork first.", timestamp: minutesAgo(60 * 24 * 28), threadId: "C07H3Q2NA", audience: "channel", classification: "unknown", topics: ["vendor"] },
      { id: "rec-1", source: "slack", sourceRef: "https://acme.slack.com/archives/C07H3Q2NA/p1726500000000002", kind: "my_answer", author: "me", text: "Vendor invoices over 10k go through procurement — the duo routes them, the vendor desk handles the rest.", timestamp: minutesAgo(60 * 24 * 27), threadId: "C07H3Q2NA", audience: "channel", classification: "unknown", topics: ["vendor"] },
      { id: "rec-2", source: "slack", sourceRef: "https://acme.slack.com/archives/C07H3Q2NA/p1726500000000003", kind: "question_to_me", author: "other", text: "Which vendor owns the design review duo room?", timestamp: minutesAgo(60 * 24 * 26), threadId: "C07H3Q2NA", audience: "channel", classification: "unknown", topics: ["vendor"] },
      { id: "rec-3", source: "markdown", sourceRef: "notes/leave.md", kind: "decision", author: "me", text: "Leave policy: five days per quarter carry over, capped at ten — the duo answers from this.", timestamp: minutesAgo(60 * 24 * 25), threadId: null, audience: "private", classification: "unknown", topics: [] },
      { id: "rec-4", source: "markdown", sourceRef: "notes/duo-principles.md", kind: "my_thinking", author: "me", text: "The duo drafts, the owner decides — that is the whole shape of the loop.", timestamp: minutesAgo(60 * 24 * 24), threadId: null, audience: "private", classification: "unknown", topics: [] },
      { id: "rec-5", source: "slack", sourceRef: "https://acme.slack.com/archives/C07H3Q2NA/p1726500000000006", kind: "my_answer", author: "me", text: "The duo answers scheduling questions from the shared calendar, not from memory.", timestamp: minutesAgo(60 * 24 * 23), threadId: "C07H3Q2NA", audience: "channel", classification: "unknown", topics: ["scheduling"] },
      { id: "rec-6", source: "slack", sourceRef: "https://acme.slack.com/archives/C07H3Q2NA/p1726500000000007", kind: "question_to_me", author: "other", text: "Can the duo draft the weekly update?", timestamp: minutesAgo(60 * 24 * 22), threadId: "C07H3Q2NA", audience: "channel", classification: "unknown", topics: [] },
      { id: "rec-7", source: "markdown", sourceRef: "notes/hiring.md", kind: "decision", author: "me", text: "Hiring loops always include a duo-adjacent work sample.", timestamp: minutesAgo(60 * 24 * 21), threadId: null, audience: "private", classification: "unknown", topics: ["hiring"] },
      { id: "rec-8", source: "slack", sourceRef: "https://acme.slack.com/archives/C07H3Q2NA/p1726500000000009", kind: "my_answer", author: "me", text: "The money questions go out same day — the duo flags them T2.", timestamp: minutesAgo(60 * 24 * 20), threadId: "C07H3Q2NA", audience: "channel", classification: "unknown", topics: ["money"] },
      { id: "rec-9", source: "markdown", sourceRef: "notes/onboarding.md", kind: "artifact", author: "me", text: "Onboarding doc: the duo's trust grid starts at ask for everything.", timestamp: minutesAgo(60 * 24 * 19), threadId: null, audience: "private", classification: "unknown", topics: [] },
      { id: "rec-10", source: "slack", sourceRef: "https://acme.slack.com/archives/C07H3Q2NA/p1726500000000011", kind: "question_to_me", author: "other", text: "Does the duo keep audit history?", timestamp: minutesAgo(60 * 24 * 18), threadId: "C07H3Q2NA", audience: "channel", classification: "unknown", topics: [] },
      { id: "rec-11", source: "slack", sourceRef: "https://acme.slack.com/archives/C07H3Q2NA/p1726500000000012", kind: "my_answer", author: "me", text: "Audit is the duo's record — everything dispositioned, everything timestamped.", timestamp: minutesAgo(60 * 24 * 17), threadId: "C07H3Q2NA", audience: "channel", classification: "unknown", topics: [] },
    ],
    grid: [
      { topicId: "t-sched", topicLabel: "scheduling", tier: "T1", level: "approve", source: "earned", stale: false },
      { topicId: "t-money", topicLabel: "money", tier: "T2", level: "auto", source: "earned", stale: false },
      { topicId: "t-hiring", topicLabel: "hiring", tier: "T0", level: "ask", source: "granted", stale: false },
      // topicLabel deliberately absent — the client renders topicId when the
      // daemon has no label for a row, and the mock should exercise that.
      { topicId: "t-legacy", tier: "T1", level: "approve", source: "granted", stale: true },
    ],
    audit: [
      {
        id: "a-1",
        createdAt: minutesAgo(60 * 24 * 2),
        question: "Does Sam handle the design review?",
        askerRef: "colleague:Rae",
        askerResolved: true,
        declined: false,
        answerText: "Yes — Sam runs design review every second Thursday.",
      },
      {
        id: "a-2",
        createdAt: minutesAgo(60 * 24),
        question: "Is the team moving to the new office in March?",
        askerRef: "colleague:Jun",
        askerResolved: false,
        declined: false,
        answerText: "The duo passed this one to the owner. You'll hear back from them directly.",
      },
      {
        id: "a-3",
        createdAt: minutesAgo(180),
        question: "What's the owner's home address?",
        askerRef: "stranger:link",
        askerResolved: true,
        declined: true,
        answerText: "The duo won't answer that one.",
      },
    ],
    // #48: the paired devices, in digital-duo #177's DeviceToken shape —
    // oldest first, no token or hash field. The mock accepts any bearer, so
    // it cannot say which row is the caller (neither can the real daemon),
    // and revoking a row here changes the list, not what any token can do.
    devices: [
      { id: "dev-ipad", name: "iPad", createdAt: minutesAgo(60 * 24 * 90), lastSeenAt: null, revokedAt: minutesAgo(60 * 24 * 30) },
      { id: "dev-mac", name: "Mac", createdAt: minutesAgo(60 * 24 * 40), lastSeenAt: minutesAgo(2), revokedAt: null },
      { id: "dev-iphone", name: "iPhone", createdAt: minutesAgo(60 * 24 * 12), lastSeenAt: minutesAgo(60 * 5), revokedAt: null },
    ],
    askLog: [],
    draftSeq: 4,
    candidateSeq: 1,
  };
  state.escalationDigests = seedEscalationDigests(state.drafts);
  return state;
}

function rule(id, topicId, text, status, supportCount, consistency, origin = "derived") {
  return {
    id,
    topicId,
    text,
    status,
    supportCount,
    consistency,
    createdAt: minutesAgo(60 * 24 * 14),
    lastConfirmedAt: status === "confirmed" ? minutesAgo(60 * 24) : null,
    reviewStatus: "pending",
    origin,
  };
}

// KTD-4: outcomes are picked by keyword so a test or a human can choose one
// on purpose — no randomness to write around.
const DRAFT_TEXTS = [
  "From your notes: go with the standing plan, and I'll confirm the details in the thread.",
  "I checked your notes and rules — the answer is yes, with the caveat you set last week.",
  "Your rules say handle this same-day; I've queued the reply and will follow up tomorrow.",
];

function draftTextFor(question) {
  let hash = 0;
  for (const ch of question) {
    hash = (hash * 31 + ch.codePointAt(0)) % 997;
  }
  return DRAFT_TEXTS[hash % DRAFT_TEXTS.length];
}

function draftPipeline(state, question, threadContext, provenance = { origin: "owner" }) {
  const id = `d-${++state.draftSeq}`;
  const lower = question.toLowerCase();
  const escalated = /\brefuse/.test(lower) || /\bshould i\b/.test(lower) || /\bescalate/.test(lower);
  const refused = /\brefuse/.test(lower);
  const record = {
    id,
    question,
    threadContext: threadContext ?? null,
    draftText: escalated ? null : draftTextFor(question),
    escalated,
    escalationReason: escalated
      ? refused
        ? "You told the duo never to answer this subject on your behalf."
        : "This one needs your judgment; the duo found conflicting guidance."
      : null,
    confidenceScore: escalated ? 0.41 : 0.82,
    sources: escalated
      ? []
      : [
          { kind: "rule", id: "r-3", label: "Money questions go out same day" },
          { kind: "evidence", id: "ev-31", label: "Vendor thread, Tuesday" },
        ],
    createdAt: new Date().toISOString(),
    outcome: null,
    outcomeRecordedAt: null,
    sentText: null,
    refused,
    escalationThreshold: THRESHOLD,
    // POST /drafts is the owner's composer, so every row it writes is
    // owner-origin (#169) — the client's #30 vocabulary keys off this. The
    // /mock/push-draft route overrides this: a draft arriving daemon-side
    // over /ws is channel-borne, which is the provenance it exists to demo.
    provenance,
    // Nothing has been sent yet, so no delivery has been attempted (#170).
    delivery: null,
  };
  state.drafts.push(record);
  if (escalated) {
    // `confidence: undefined` drops out of JSON.stringify, which is exactly
    // the wire shape the client's DraftPipelineResult allows.
    return { kind: "escalation", draftId: id, reason: record.escalationReason, refused, confidence: undefined };
  }
  return {
    kind: "draft",
    draftId: id,
    text: record.draftText,
    sources: record.sources,
    confidence: { score: record.confidenceScore, passesThreshold: true, threshold: THRESHOLD },
  };
}

function publicAnswer(state, question) {
  const lower = question.toLowerCase();
  state.askLog.push({ question });
  // The asker-visible envelope of digital-duo #159's POST /ask: {duo, kind,
  // text} for every outcome, `sources` only on an answered one, and none of
  // the device-principal-only fields — the daemon composes attribution,
  // confidence, and evidence age into the text itself, so the asker's page
  // renders exactly this and nothing structured on top of it.
  if (/\bpass\b/.test(lower)) {
    return {
      duo: "personal",
      kind: "passed_on",
      text: "The duo passed this one to the owner. You'll hear back from them directly.",
    };
  }
  if (/\bsecret\b|\bsalary\b|\baddress\b/.test(lower)) {
    return { duo: "personal", kind: "declined_refused", text: "The duo won't answer that one." };
  }
  return {
    duo: "personal",
    kind: "answered",
    text:
      `Answering from what the owner taught me:\n\n${draftTextFor(question)}\n\n` +
      'Sources: shared calendar; rule "Answer scheduling questions from the shared calendar before noon."\n\n' +
      "— the owner's duo speaking here, not the owner directly. Confidence: 0.84. Based on evidence up to 3 day(s) old.",
    sources: [
      { kind: "rule", id: "r-9", label: "Answer scheduling questions from the shared calendar" },
      { kind: "evidence", id: "ev-31", label: "Vendor thread, Tuesday" },
    ],
  };
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
};

// Every handler returns {status, body} — one discipline end to end, so the
// router never has to guess whether a handler already wrote the response.
const ok = (body) => ({ status: 200, body });
const fail = (status, code, message) => ({ status, body: { error: { code, message } } });

/**
 * Builds the mock. Does not listen — the caller owns the port (tests use 0,
 * the CLI entry uses DEFAULT_PORT or $PORT), so every instance starts from
 * the seed with nothing shared between instances (KTD-3).
 */
export function createMockDaemon({ empty = false, embedTickMs = 400 } = {}) {
  const state = seedState();
  // The daemon's one embed job (#176, and duo #49's flow over it), in the
  // shape the real job reports: process-bound runtime state, idle until the
  // first start.
  const embedJob = { state: "idle", startedAt: null, finishedAt: null, embedded: 0, total: 0, error: null };
  if (empty) {
    // A duo nobody has built yet — what `duo init` leaves behind (#49). What
    // `duo derive` would later produce is set aside for /mock/derive to
    // stage, since the real daemon has no route to run derivation.
    state.derivable = { rules: state.rules, portrait: state.portrait };
    state.knowledge = { ...state.knowledge, records: { total: 0, bySource: {} }, lastImport: null };
    state.rules = { awaitingApproval: [], weakSignals: [], inconsistent: [], approved: [], rejected: [] };
    state.portrait = {
      ...state.portrait,
      totalQuestions: 0,
      periodStart: null,
      periodEnd: null,
      topicBreakdown: [],
      topFiveShare: 0,
      busiestThreads: [],
      tooThin: true,
    };
  }
  const server = createServer();
  const { broadcast } = attachDraftReadySocket(server);

  server.on("request", async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const write = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json", ...CORS_HEADERS });
      res.end(body === undefined ? "" : JSON.stringify(body));
    };
    // Handlers speak {status, body}; the pre-route guards and the dispatch
    // below go through the same exit so CORS headers ride on every response.
    const send = (outcome) => write(outcome.status, outcome.body);

    // CORS on every response, errors included — a preflight that only
    // succeeds for 2xx routes is the failure mode #167 exists to fix.
    if (req.method === "OPTIONS") {
      res.writeHead(204, CORS_HEADERS);
      res.end();
      return;
    }
    if (url.pathname === "/health") {
      write(200, { ok: true });
      return;
    }
    if (!/^Bearer\s+.+/.test(req.headers.authorization ?? "")) {
      send(fail(401, "unauthorized", "Missing or empty bearer token."));
      return;
    }
    // #55 (digital-duo #181): after a confirmed end every token is dead —
    // the store that held them is gone — so every authenticated request is
    // the same clean 401 a revoked device gets. Only /health (above) still
    // answers, like the real daemon process still running with no store.
    if (state.ended) {
      send(fail(401, "unauthorized", "Token is not recognised."));
      return;
    }

    const readBody = async () => {
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
      } catch {
        return null;
      }
    };

    const routes = [
      // #48 (digital-duo #177): the device list, and revoke — which answers
      // the revoked row, treats a second revoke as a no-op, and 404s a stranger
      // with the daemon's own error class and words.
      ["GET", /^\/devices$/, () => ok(state.devices)],
      [
        "POST",
        /^\/devices\/([^/]+)\/revoke$/,
        (m) => {
          const id = decodeURIComponent(m[1]);
          const row = state.devices.find((d) => d.id === id);
          if (!row) {
            return fail(404, "DeviceTokenNotFoundError", `No paired device with id "${id}"`);
          }
          row.revokedAt ??= new Date().toISOString();
          return ok(row);
        },
      ],
      // #40: both shapes the wire defines, so the roster's two labels are
      // exercisable against the mock — the shared entry is what a trusted
      // device sees, with the owner's own name as the daemon sends it.
      ["GET", /^\/duos$/, () => ok([{ kind: "personal" }, { kind: "shared", ownerId: "owner-1", ownerName: "River" }])],
      [
        "GET",
        /^\/drafts$/,
        () => {
          // limit validates the way the real route does (parsePositiveIntParam):
          // a non-negative integer, literally — "2.5", "abc", "01" are 400s, "0"
          // is a valid (empty) page.
          const rawLimit = url.searchParams.get("limit");
          let limit;
          if (rawLimit !== null) {
            const parsed = Number.parseInt(rawLimit, 10);
            if (!Number.isInteger(parsed) || parsed < 0 || String(parsed) !== rawLimit) {
              return fail(400, "bad_request", `limit must be a non-negative integer, got ${JSON.stringify(rawLimit)}`);
            }
            limit = parsed;
          }
          return ok(filteredDrafts(state, url.searchParams.get("outcome"), url.searchParams.get("before"), limit));
        },
      ],
      [
        "GET",
        /^\/drafts\/([^/]+)$/,
        (m) => {
          const draft = state.drafts.find((d) => d.id === m[1]);
          return draft ? ok(draft) : fail(404, "not_found", "No such draft.");
        },
      ],
      [
        "GET",
        /^\/review$/,
        () => {
          // listCorrectionCandidates' shape (digital-duo #173's route):
          // bare lists every status ascending by creation; ?status=
          // filters by plain equality — the route casts the querystring,
          // it does not validate it.
          const status = url.searchParams.get("status");
          let rows = [...state.candidates].sort(
            (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
          );
          if (status !== null) {
            rows = rows.filter((c) => c.status === status);
          }
          return ok(rows);
        },
      ],
      [
        "POST",
        /^\/review\/([^/]+)\/(approve|reject)$/,
        (m) => {
          // #173's thin wrappers: the route passes the id through and the
          // review layer owns the behaviour — not-found is its own 404
          // (it searched both source tables), a decided candidate is the
          // 409 finality gate, and nothing here writes anything but the
          // status. The mock only ever mints style candidates (its one
          // candidate source is a draft edit), so approve's result is the
          // voice-correction shape — `kind: "style"`, no rule; the
          // substance path (conflict gate, supersedesRuleId) stays
          // unwired because nothing on this mock can produce a substance
          // candidate to gate.
          const [, id, action] = m;
          const found = state.candidates.find((c) => c.id === id);
          if (!found) {
            return fail(404, "ReviewCandidateNotFoundError", `No pending correction candidate with id "${id}"`);
          }
          if (found.status !== "pending") {
            return fail(
              409,
              "CandidateAlreadyReviewedError",
              `Correction candidate "${id}" was already reviewed (status: "${found.status}")`,
            );
          }
          found.status = action === "approve" ? "approved" : "rejected";
          found.reviewedAt = new Date().toISOString();
          return ok(action === "approve" ? { candidate: found, result: { kind: found.kind } } : { candidate: found });
        },
      ],
      ["GET", /^\/mirror\/portrait$/, () => ok(state.portrait)],
      [
        "GET",
        /^\/knowledge$/,
        () => {
          // describeDuoKnowledge's discipline (#175): compose, never
          // derive. The corpus slice IS the portrait's — same verdict,
          // same topics — and the rule counts come straight off the
          // buckets this mock serves: everything undecided is pending,
          // the decided statuses count themselves, and superseded is
          // nothing this mock mints.
          return ok({
            ...state.knowledge,
            corpus: {
              tooThin: state.portrait.tooThin,
              minimumQuestionsToCharacterize: state.portrait.minimumQuestionsToCharacterize,
              totalQuestions: state.portrait.totalQuestions,
              periodStart: state.portrait.periodStart,
              periodEnd: state.portrait.periodEnd,
              topicBreakdown: state.portrait.topicBreakdown,
            },
            rules: {
              byReviewStatus: {
                pending:
                  state.rules.awaitingApproval.length + state.rules.weakSignals.length + state.rules.inconsistent.length,
                approved: state.rules.approved.length,
                rejected: state.rules.rejected.length,
                superseded: 0,
              },
            },
          });
        },
      ],
      ["GET", /^\/mirror\/rules$/, () => ok(state.rules)],
      [
        "GET",
        /^\/mirror\/rules\/([^/]+)$/,
        (m) => {
          // RuleWithEvidence (digital-duo #182), not a bare Rule: the rule
          // plus one cited exchange per supporting pair. The exchanges are
          // generated from the rule's own supportCount so the count the
          // card shows and the evidence it opens onto can never disagree.
          const found = Object.values(state.rules).flat().find((r) => r.id === m[1]);
          if (!found) {
            return fail(404, "RuleNotFoundError", `No rule with id "${m[1]}"`);
          }
          const evidence = Array.from({ length: found.supportCount }, (_, i) => ({
            qaPairId: `${found.id}-qa-${i + 1}`,
            questionText: `Earlier question ${i + 1} on this topic (${found.topicId}).`,
            answerText: `${found.text} (answer ${i + 1})`,
          }));
          return ok({ rule: found, evidence });
        },
      ],
      ["GET", /^\/mirror\/refusals$/, () => ok(state.refusals)],
      ["GET", /^\/trust\/grid$/, () => ok(state.grid)],
      ["GET", /^\/audit$/, () => ok(state.audit)],
      [
        "GET",
        /^\/channels$/,
        () =>
          // describeChannels (#171): one row per adapter, `reason` present
          // iff failed, `muted` matched case-insensitively against the kind
          // in the one mute store.
          ok(
            state.channels.map((channel) => ({
              ...channel,
              muted: state.mutePolicy.muted.some((entry) => entry.toLowerCase() === channel.kind.toLowerCase()),
            })),
          ),
      ],
      ["GET", /^\/channels\/policy$/, () => ok(state.mutePolicy)],
      [
        "POST",
        /^\/channels\/policy\/(mute|unmute)$/,
        (m, body) => {
          // #172: the same validation, in the daemon's own words — a
          // required non-empty channel, an optional threadId, and "/"
          // banned in both because it is the thread scope's separator.
          const { channel, threadId } = body;
          if (typeof channel !== "string" || channel.trim().length === 0) {
            return fail(400, "bad_request", "channel is required and must be a non-empty string");
          }
          if (channel.includes("/")) {
            return fail(
              400,
              "bad_request",
              `channel must not contain "/" — it scopes a thread within a channel — got ${JSON.stringify(channel)}`,
            );
          }
          if (threadId !== undefined && (typeof threadId !== "string" || threadId.trim().length === 0)) {
            return fail(400, "bad_request", "threadId must be a non-empty string when given");
          }
          if (typeof threadId === "string" && threadId.includes("/")) {
            return fail(
              400,
              "bad_request",
              `threadId must not contain "/" — it scopes a thread within a channel — got ${JSON.stringify(threadId)}`,
            );
          }
          const lower = channel.toLowerCase();
          const policy = state.mutePolicy;
          if (threadId === undefined) {
            policy.muted = policy.muted.filter((entry) => entry.toLowerCase() !== lower);
            if (m[1] === "mute") {
              policy.muted.push(channel);
            }
          } else {
            policy.mutedThreads = policy.mutedThreads.filter(
              (entry) => !(entry.channel.toLowerCase() === lower && entry.threadId.toLowerCase() === threadId.toLowerCase()),
            );
            if (m[1] === "mute") {
              policy.mutedThreads.push({ channel, threadId });
            }
          }
          return ok(policy);
        },
      ],
      [
        "GET",
        /^\/escalations\/history$/,
        () => {
          // #178's route, oldest first, validated in /search's own words
          // (limit 1..100, default 10; cursor an offset). There is no
          // POST /escalations/digest here on purpose: assembling is the
          // send, and no client reads through it.
          let limit = 10;
          const rawLimit = url.searchParams.get("limit");
          if (rawLimit !== null) {
            limit = Number.parseInt(rawLimit, 10);
            if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
              return fail(400, "bad_request", "limit must be an integer between 1 and 100");
            }
          }
          let cursor = 0;
          const rawCursor = url.searchParams.get("cursor");
          if (rawCursor !== null) {
            cursor = Number.parseInt(rawCursor, 10);
            if (!Number.isInteger(cursor) || cursor < 0) {
              return fail(400, "bad_request", "cursor must be a non-negative integer");
            }
          }
          return ok(state.escalationDigests.slice(cursor, cursor + limit));
        },
      ],
      [
        "GET",
        /^\/escalations\/rate$/,
        () => {
          // `escalationUrgencyRate`'s arithmetic: all-time over every
          // escalation, urgent ones included, and 0 — never NaN — on none.
          const escalated = state.drafts.filter((d) => d.escalated);
          const urgent = escalated.filter(isUrgent).length;
          return ok({ total: escalated.length, urgent, rate: escalated.length === 0 ? 0 : urgent / escalated.length });
        },
      ],
      [
        "GET",
        /^\/search$/,
        () => {
          // #174's route: validate the query string exactly as the real
          // one does (its own words), then hand off to retrieval — here
          // the documented substring-count heuristic over the seeded
          // corpus, with the real route's rank contract (rank = position
          // in the full ranked list; cursor pages by offset). The mock's
          // retrieval always "embeds" — the degraded path (usedEmbeddings
          // false + the daemon's own warning sentence) is a component
          // concern and is covered there with stubs, not faked here.
          const rawQ = url.searchParams.get("q");
          if (rawQ === null || rawQ.trim().length === 0) {
            return fail(400, "bad_request", "q is required and must not be blank");
          }
          let limit = 10;
          const rawLimit = url.searchParams.get("limit");
          if (rawLimit !== null) {
            limit = Number.parseInt(rawLimit, 10);
            if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
              return fail(400, "bad_request", "limit must be an integer between 1 and 100");
            }
          }
          let cursor = 0;
          const rawCursor = url.searchParams.get("cursor");
          if (rawCursor !== null) {
            cursor = Number.parseInt(rawCursor, 10);
            if (!Number.isInteger(cursor) || cursor < 0) {
              return fail(400, "bad_request", "cursor must be a non-negative integer");
            }
          }
          const needle = rawQ.trim().toLowerCase();
          // Escape regex metacharacters: the query is user input, and a
          // literal "(" would turn the heuristic into a syntax error.
          const pattern = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          const ranked = state.records
            .map((record, index) => ({
              record,
              index,
              occurrences: (record.text.toLowerCase().match(new RegExp(pattern, "g")) ?? []).length,
            }))
            .filter((row) => row.occurrences > 0)
            .sort((a, b) => b.occurrences - a.occurrences || a.index - b.index);
          const results = ranked
            .slice(cursor, cursor + limit)
            .map((row, index) => ({ record: row.record, rank: cursor + index }));
          return ok({ results, usedEmbeddings: true });
        },
      ],
      [
        "POST",
        /^\/drafts$/,
        async (_m, body) => {
          if (!body || typeof body.question !== "string" || body.question.trim() === "") {
            return fail(400, "bad_request", "A question is required.");
          }
          // Latency the composer's pending state can actually be seen in —
          // the real pipeline drafts from a corpus; this one just waits.
          await new Promise((resolve) => setTimeout(resolve, 300));
          return { status: 201, body: draftPipeline(state, body.question.trim(), body.threadContext) };
        },
      ],
      [
        "POST",
        /^\/drafts\/([^/]+)\/outcome$/,
        (m, body) => {
          const draft = state.drafts.find((d) => d.id === m[1]);
          if (!draft) {
            return fail(404, "not_found", "No such draft.");
          }
          if (!["sent", "edited", "discarded"].includes(body?.outcome)) {
            return fail(400, "invalid_outcome", "outcome must be sent, edited, or discarded.");
          }
          draft.outcome = body.outcome;
          draft.outcomeRecordedAt = new Date().toISOString();
          draft.sentText =
            body.outcome === "sent"
              ? (body.sentText ?? draft.draftText)
              : body.outcome === "edited"
                ? (body.sentText ?? null)
                : null;
          // The delivery seam, as the daemon runs it (#170): only a
          // channel-borne sent/edited draft is handed to an adapter — the
          // outcome and its correction candidate are already recorded above
          // and stand whatever happens here. The mock connects no adapter,
          // so this records the same honest failure a daemon with no adapter
          // writes, in the core's own wording; owner/unknown-origin drafts
          // and discards record nothing (nowhere to deliver is not an error).
          draft.delivery =
            draft.provenance?.origin === "channel" && (body.outcome === "sent" || body.outcome === "edited")
              ? { state: "failed", reason: `no connected adapter for channel kind "${draft.provenance.channelKind}"` }
              : null;
          // An edit is the one outcome that queues a correction candidate —
          // the pairing the client's invalidation comments call out.
          if (body.outcome === "edited" && body.sentText && body.sentText !== draft.draftText) {
            state.candidates.push({
              id: `c-${++state.candidateSeq}`,
              kind: "style",
              draftId: draft.id,
              question: draft.question,
              draftText: draft.draftText ?? "",
              sentText: body.sentText,
              status: "pending",
              createdAt: new Date().toISOString(),
              reviewedAt: null,
            });
          }
          return ok(draft);
        },
      ],
      [
        "POST",
        /^\/drafts\/([^/]+)\/answer$/,
        (m, body) => {
          const draft = state.drafts.find((d) => d.id === m[1]);
          if (!draft) {
            return fail(404, "not_found", "No such draft.");
          }
          if (!draft.escalated || draft.outcome !== null) {
            return fail(400, "not_escalated", "Only an unanswered escalation can be answered.");
          }
          if (typeof body?.answer !== "string" || body.answer.trim() === "") {
            return fail(400, "bad_request", "An answer is required.");
          }
          draft.outcome = "escalation_answered";
          draft.outcomeRecordedAt = new Date().toISOString();
          return ok({ candidateId: `sug-${++state.candidateSeq}` });
        },
      ],
      [
        "POST",
        /^\/mirror\/rules\/([^/]+)\/(approve|reject|promote)$/,
        (m) => {
          const [, id, action] = m;
          const sources =
            action === "promote" ? ["weakSignals"] : ["awaitingApproval", "weakSignals", "inconsistent"];
          const bucket = sources.find((b) => state.rules[b].some((r) => r.id === id));
          if (!bucket) {
            return fail(404, "not_found", "No such rule awaiting that action.");
          }
          const found = state.rules[bucket].find((r) => r.id === id);
          state.rules[bucket] = state.rules[bucket].filter((r) => r.id !== id);
          if (action === "reject") {
            found.reviewStatus = "rejected";
          } else {
            found.reviewStatus = "approved";
            found.status = "confirmed";
            found.lastConfirmedAt = new Date().toISOString();
          }
          state.rules[action === "reject" ? "rejected" : "approved"].push(found);
          return ok(found);
        },
      ],
      // #55: digital-duo #181's lifecycle routes. GET is the record plus
      // every transfer's state (none seeded — handover is out of scope for
      // the client). POST /lifecycle/end has the real route's two
      // protections: it names who decided it (`decidedBy`, non-empty), and
      // it only DESCRIBES what would go until `confirmed === true` — the
      // same EndDuoResult shape either way, `confirmed` saying which
      // happened. Confirmed, it "deletes" (the flag the auth guard reads).
      [
        "GET",
        /^\/lifecycle$/,
        () =>
          ok({
            lifecycle: {
              status: "active",
              archivedBy: null,
              archivedAt: null,
              orphanedBy: null,
              orphanedAt: null,
              orphanReason: null,
              transferredFrom: null,
              transferredTo: null,
              transferredAt: null,
            },
            transfers: [],
          }),
      ],
      [
        "POST",
        /^\/lifecycle\/end$/,
        (_m, body) => {
          const { decidedBy, confirmed } = body ?? {};
          if (typeof decidedBy !== "string" || decidedBy.trim().length === 0) {
            return fail(400, "bad_request", "Ending a duo requires naming who decided it (decidedBy, a non-empty string).");
          }
          const result = {
            confirmed: confirmed === true,
            storeDataDir: "/Users/mock/.duo/data",
            storePaths: ["duo.db", "embeddings.bin", "passphrase"],
            duoDir: "/Users/mock/duo",
            duoDirPaths: ["voice.md", "refusals.md", "lifecycle.json", "rules/r-3.md"],
          };
          if (result.confirmed) {
            state.ended = true;
          }
          return ok(result);
        },
      ],
      [
        "POST",
        /^\/ask$/,
        (_m, body) => {
          if (!body || typeof body.question !== "string" || body.question.trim() === "") {
            return fail(400, "bad_request", "A question is required.");
          }
          return ok(publicAnswer(state, body.question.trim()));
        },
      ],
      [
        "POST",
        /^\/corpus\/import-paste$/,
        (_m, body) => {
          // #176's route: the transcript text in the body, validated in the
          // daemon's own words, parsed by the paste adapter's own turn
          // grammar (a line starting "Me:"/"Human:" or "Claude:"/"Assistant:";
          // other lines fold into the turn before). The mock judges every
          // transcript work-relevant, and — like the real second import,
          // whose fresh timestamps defeat the dedupe — invents no dedupe.
          if (typeof body?.transcript !== "string" || body.transcript.trim().length === 0) {
            return fail(400, "bad_request", "transcript is required and must be a non-empty string");
          }
          const turns = [];
          for (const line of body.transcript.split(/\r?\n/)) {
            const turn = /^(human|me|assistant|claude)\s*:\s?(.*)$/i.exec(line);
            if (turn) {
              turns.push(turn[2]);
            } else if (turns.length > 0 && line.trim().length > 0) {
              turns[turns.length - 1] += `\n${line}`;
            }
          }
          if (turns.length === 0) {
            return fail(
              400,
              "MalformedTranscriptError",
              'Expected a pasted transcript with lines starting "Human: " / "Assistant: " (or "Me: " / "Claude: "). Found no recognisable turn.',
            );
          }
          const written = turns.filter((text) => text.trim().length > 0).length;
          const { records } = state.knowledge;
          state.knowledge.records = {
            total: records.total + written,
            bySource: { ...records.bySource, paste: (records.bySource.paste ?? 0) + written },
          };
          state.knowledge.lastImport = {
            runAt: new Date().toISOString(),
            staged: written,
            written,
            alreadyPresent: 0,
            skippedDmConversations: 0,
            discardedOtherText: 0,
            discardedAboveCeiling: 0,
          };
          return ok({ workRelevant: true, written, skipped: 0, discardedAboveCeiling: 0 });
        },
      ],
      [
        "POST",
        /^\/corpus\/embed$/,
        () => {
          // #176's job: 202 with the starting status (total unknown until the
          // first batch reports it), one job at a time (409 names the running
          // one), batches of ten so the count climbs at a watchable pace.
          if (embedJob.state === "running") {
            return fail(
              409,
              "embed_already_running",
              "An embed is already running for this corpus; watch GET /corpus/embed for its progress.",
            );
          }
          Object.assign(embedJob, { state: "running", startedAt: new Date().toISOString(), finishedAt: null, embedded: 0, total: 0, error: null });
          const timer = setInterval(() => {
            const total = state.knowledge.records.total;
            embedJob.total = total;
            embedJob.embedded = Math.min(total, embedJob.embedded + 10);
            if (embedJob.embedded >= total) {
              Object.assign(embedJob, { state: "done", finishedAt: new Date().toISOString() });
              clearInterval(timer);
            }
          }, embedTickMs);
          timer.unref();
          return { status: 202, body: { ...embedJob } };
        },
      ],
      ["GET", /^\/corpus\/embed$/, () => ok({ ...embedJob })],
      [
        "POST",
        /^\/mock\/derive$/,
        () => {
          // Mock-only (the name says so): derivation is a terminal stage
          // (`duo derive`), and the real daemon has no route to run it. This
          // stages what it would have produced, so the app's first run can be
          // watched end to end against the mock started with EMPTY=1.
          if (state.derivable) {
            state.rules = state.derivable.rules;
            state.portrait = state.derivable.portrait;
          }
          return ok({ derived: true });
        },
      ],
      [
        "POST",
        /^\/mock\/push-draft$/,
        (_m, body) => {
          // Mock-only (the name says so): fabricate a draft as if the daemon
          // produced it on its own, then light up the one push channel. The
          // real daemon has no such route and needs none. The fabricated
          // draft is channel-borne with #169's full shape — that is the
          // provenance a daemon-side arrival carries, and what #20 renders.
          if (!body || typeof body.question !== "string" || body.question.trim() === "") {
            return fail(400, "bad_request", "A question is required.");
          }
          const result = draftPipeline(state, body.question.trim(), body.threadContext, {
            origin: "channel",
            channelKind: "slack",
            askerRef: "U04ARLJ9P",
            threadId: "C07H3Q2NA",
            permalink: null,
          });
          broadcast({ type: "draft-ready", draftId: result.draftId });
          return { status: 201, body: state.drafts.find((d) => d.id === result.draftId) };
        },
      ],
    ];

    for (const [method, pattern, handler] of routes) {
      if (req.method !== method) {
        continue;
      }
      const match = url.pathname.match(pattern);
      if (!match) {
        continue;
      }
      const body = req.method === "POST" ? await readBody() : undefined;
      if (body === null) {
        send(fail(400, "bad_request", "Body was not valid JSON."));
        return;
      }
      send(await handler(match, body));
      return;
    }
    send(fail(404, "not_found", "No such route."));
  });

  return { server, state, broadcast };
}

// The daemon's two draft-list shapes (duo #29, mirroring digital-duo #203's
// listDrafts): without `limit`, oldest-first — the conversation order the
// un-paged callers were written against. With `limit`, newest-first
// (`created_at DESC, id DESC`) under the exclusive `before` ceiling: page
// one is the newest window, and feeding a page's oldest createdAt back as
// `before` walks to the adjacent older page. The sort ascending + reverse
// below IS that DESC order, id-tiebreak included.
function filteredDrafts(state, outcomeParam, beforeParam, limitParam) {
  const wanted = outcomeParam === "pending" ? null : outcomeParam;
  let rows = [...state.drafts]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .filter((d) => (beforeParam === null ? true : d.createdAt < beforeParam))
    .filter((d) => (outcomeParam === null ? true : d.outcome === wanted));
  if (limitParam !== undefined) {
    rows = rows.reverse().slice(0, limitParam);
  }
  return rows;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  // EMPTY=1 starts a duo nobody has built yet, so the app's first run (#49) can be walked.
  const { server } = createMockDaemon({ empty: process.env.EMPTY === "1" });
  server.listen(port, host, () => {
    console.log(`mock duo daemon on http://${host}:${port}`);
    console.log("");
    console.log("Pair the client with:");
    console.log(`  address  http://${host}:${port}`);
    console.log("  token    any non-empty string, e.g. mock-token");
    console.log("");
    console.log("Ask link (ask.html) shape:");
    console.log(`  http://localhost:5173/ask.html#host=${encodeURIComponent(`http://${host}:${port}`)}&token=ask-token`);
    console.log("");
    console.log("Question keywords pick the outcome:");
    console.log("  drafts:  'refuse' -> refused escalation; 'should I' / 'escalate' -> judgment escalation; else a draft");
    console.log("  ask:     'pass' -> passed on; 'secret' / 'salary' / 'address' -> declined; else answered");
    console.log("");
    console.log("Push a daemon-side draft (mock-only demo of the /ws channel):");
    console.log(`  curl -X POST http://${host}:${port}/mock/push-draft -H 'Authorization: Bearer mock-token' -H 'Content-Type: application/json' -d '{"question":"Did the contract renew?"}'`);
    console.log("");
    console.log("Walk the first run (#49) against an empty duo: EMPTY=1 npm run mock, import in the app, then stage");
    console.log("what `duo derive` would produce (the real daemon has no route to run it):");
    console.log(`  curl -X POST http://${host}:${port}/mock/derive -H 'Authorization: Bearer mock-token'`);
    console.log("");
    console.log("State is in memory: restarting resets everything to the seed.");
  });
}
