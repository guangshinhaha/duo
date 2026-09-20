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

function seedState() {
  return {
    drafts: [
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
        // demoable against the mock.
        provenance: {
          origin: "channel",
          channelKind: "slack",
          askerRef: "U04ARLJ9P",
          threadId: "C07H3Q2NA",
          permalink: null,
        },
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
    askLog: [],
    draftSeq: 4,
    candidateSeq: 1,
  };
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

function draftPipeline(state, question, threadContext) {
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
    // owner-origin (#169) — the client's #30 vocabulary keys off this.
    provenance: { origin: "owner" },
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
export function createMockDaemon() {
  const state = seedState();
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
      ["GET", /^\/duos$/, () => ok([{ kind: "personal" }])],
      ["GET", /^\/drafts$/, () => ok(filteredDrafts(state, url.searchParams.get("outcome")))],
      [
        "GET",
        /^\/drafts\/([^/]+)$/,
        (m) => {
          const draft = state.drafts.find((d) => d.id === m[1]);
          return draft ? ok(draft) : fail(404, "not_found", "No such draft.");
        },
      ],
      ["GET", /^\/review$/, () => ok(state.candidates.filter((c) => c.status === "pending"))],
      ["GET", /^\/mirror\/portrait$/, () => ok(state.portrait)],
      ["GET", /^\/mirror\/rules$/, () => ok(state.rules)],
      [
        "GET",
        /^\/mirror\/rules\/([^/]+)$/,
        (m) => {
          const found = Object.values(state.rules).flat().find((r) => r.id === m[1]);
          return found ? ok(found) : fail(404, "not_found", "No such rule.");
        },
      ],
      ["GET", /^\/trust\/grid$/, () => ok(state.grid)],
      ["GET", /^\/audit$/, () => ok(state.audit)],
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
        /^\/mock\/push-draft$/,
        (_m, body) => {
          // Mock-only (the name says so): fabricate a draft as if the daemon
          // produced it on its own, then light up the one push channel. The
          // real daemon has no such route and needs none.
          if (!body || typeof body.question !== "string" || body.question.trim() === "") {
            return fail(400, "bad_request", "A question is required.");
          }
          const result = draftPipeline(state, body.question.trim(), body.threadContext);
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

// The daemon orders drafts by creation, oldest first (the conversation
// order the Duo thread view groups by); the seed is pushed oldest-first and
// POST /drafts appends, so the array is already in order — the sort is a
// guard, not a reordering.
function filteredDrafts(state, outcomeParam) {
  const wanted = outcomeParam === "pending" ? null : outcomeParam;
  return [...state.drafts]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .filter((d) => (outcomeParam === null ? true : d.outcome === wanted));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? DEFAULT_PORT);
  const host = process.env.HOST ?? DEFAULT_HOST;
  const { server } = createMockDaemon();
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
    console.log("State is in memory: restarting resets everything to the seed.");
  });
}
