import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { App } from "../src/App.js";
import { Setup } from "../src/routes/Setup.js";
import { Onboarding } from "../src/routes/Onboarding.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DuoKnowledge, EmbedJobStatus, PasteImportSummary, Rule, RuleReviewListing } from "../src/api/types.js";

// The shell's notification side effects are Tauri's; the onboarding flow is
// the client's half and is what this file pins.
vi.mock("../src/notifications.js", () => ({
  notifyDraftReady: vi.fn(),
  wireDraftNotificationClicks: vi.fn(() => Promise.resolve(() => {})),
}));

/*
 * #49: build a duo from the app, not only from a terminal. The daemon's
 * half is digital-duo #176 — POST /corpus/import-paste, POST/GET
 * /corpus/embed — and this file fakes exactly that wire, by URL and
 * method, so what is pinned is the client's contract with it:
 *
 *  - importing goes through the daemon, and progress is visible;
 *  - embedding is a job the app starts and watches, and the daemon's own
 *    counts are what render;
 *  - derivation has no daemon route (`duo derive` is a terminal stage), so
 *    the app watches its facts (GET /knowledge) rather than pretending to
 *    run it — a surface must not add a behaviour;
 *  - it ends at the Mirror, at the first derived rules, approve and
 *    reject in reach;
 *  - a duo already built in a terminal never sees any of it.
 */

const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };
const POLL_MS = 20;

function renderWithClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const usage = {
  totalQuestions: 0,
  distinctAskers: 0,
  repeatAskers: 0,
  answeredCount: 0,
  declinedCount: 0,
  answerRate: 0,
  escalationRate: 0,
  weeklyTrend: [],
  gaps: [],
  lastAskedAt: null,
  daysSinceLastAsk: null,
  abandoned: false,
  summary: "The shared duo is not being used.",
};

function knowledgeFor(over: Partial<DuoKnowledge> = {}): DuoKnowledge {
  return {
    records: { total: 0, bySource: {} },
    lastImport: null,
    corpus: { tooThin: true, minimumQuestionsToCharacterize: 10, totalQuestions: 0, periodStart: null, periodEnd: null, topicBreakdown: [] },
    rules: { byReviewStatus: { pending: 0, approved: 0, rejected: 0, superseded: 0 } },
    providers: { inference: "qwen-local", embedding: { name: "ollama", model: "nomic-embed-text" } },
    sharedUsage: usage,
    ...over,
  };
}

const emptyDuo = () => knowledgeFor();
const importedDuo = () => knowledgeFor({ records: { total: 40, bySource: { paste: 40 } } });
const existingDuo = () =>
  knowledgeFor({
    records: { total: 312, bySource: { markdown: 312 } },
    lastImport: { runAt: "2026-09-18T09:15:00.000Z", staged: 318, written: 312, alreadyPresent: 0, skippedDmConversations: 4, discardedOtherText: 2, discardedAboveCeiling: 0 },
    rules: { byReviewStatus: { pending: 3, approved: 12, rejected: 2, superseded: 0 } },
  });
const withPendingRules = (n: number) =>
  knowledgeFor({
    records: { total: 40, bySource: { paste: 40 } },
    corpus: { tooThin: false, minimumQuestionsToCharacterize: 10, totalQuestions: 14, periodStart: null, periodEnd: null, topicBreakdown: [{ topicId: "t1", label: "scheduling", count: 14, share: 1 }] },
    rules: { byReviewStatus: { pending: n, approved: 0, rejected: 0, superseded: 0 } },
  });

const idle: EmbedJobStatus = { state: "idle", startedAt: null, finishedAt: null, embedded: 0, total: 0, error: null };
const embedStatus = (state: EmbedJobStatus["state"], embedded: number, total = 40, error: string | null = null): EmbedJobStatus => ({
  state,
  startedAt: "2026-09-26T08:00:00.000Z",
  finishedAt: state === "done" || state === "error" ? "2026-09-26T08:01:00.000Z" : null,
  embedded,
  total,
  error,
});

const summary = (over: Partial<PasteImportSummary> = {}): PasteImportSummary => ({
  workRelevant: true,
  written: 3,
  skipped: 1,
  discardedAboveCeiling: 0,
  ...over,
});

const TRANSCRIPT = "Me: Can you send the vendor invoice today?\nClaude: Yes, sending it now.";

type Reply = [status: number, body: unknown];
interface FakeDaemon {
  knowledge: () => DuoKnowledge;
  embedGet: () => EmbedJobStatus;
  embedPost?: () => Reply | Promise<Reply>;
  importPost?: (body: { transcript: string }) => Reply | Promise<Reply>;
  rules?: () => RuleReviewListing;
}
interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** The daemon's wire as #176 shipped it, by URL and method. Every call is recorded, so a test can say what was — and was not — asked. */
function fakeDaemon(daemon: FakeDaemon) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = String(url).replace(api.baseUrl, "");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ method, path, body });
    const reply = async (r: Reply | Promise<Reply>) => {
      const [status, payload] = await r;
      return new Response(JSON.stringify(payload), { status });
    };
    if (method === "GET" && path === "/knowledge") {
      return reply([200, daemon.knowledge()]);
    }
    if (method === "GET" && path === "/corpus/embed") {
      return reply([200, daemon.embedGet()]);
    }
    if (method === "POST" && path === "/corpus/embed" && daemon.embedPost) {
      return reply(daemon.embedPost());
    }
    if (method === "POST" && path === "/corpus/import-paste" && daemon.importPost) {
      return reply(daemon.importPost(body));
    }
    if (method === "GET" && path === "/mirror/rules") {
      return reply([200, daemon.rules?.() ?? { awaitingApproval: [], weakSignals: [], inconsistent: [], approved: [], rejected: [] }]);
    }
    if (method === "GET" && path === "/mirror/portrait") {
      return reply([200, { totalQuestions: 0, tooThin: true, minimumQuestionsToCharacterize: 10, periodStart: null, periodEnd: null, topicBreakdown: [], topThreadShare: [], topFiveShare: 0 }]);
    }
    return reply([200, []]);
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, fetchMock, count: (method: string, path: string) => calls.filter((c) => c.method === method && c.path === path).length };
}

function renderOnboarding(onFinish = vi.fn()) {
  renderWithClient(<Onboarding api={api} onFinish={onFinish} pollMs={POLL_MS} />);
  return onFinish;
}

/** A scripted sequence of embed statuses: each GET takes the next, the last repeats — a job's progress as the daemon reports it. */
function script(statuses: EmbedJobStatus[]) {
  let i = 0;
  return () => statuses[Math.min(i++, statuses.length - 1)];
}

beforeEach(() => {
  localStorage.clear();
  window.location.hash = "";
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#49 AC1 — importing happens in the app", () => {
  it("imports a pasted export through the daemon, with progress visible while it runs and the daemon's counts after", async () => {
    let resolveImport: (r: Reply) => void = () => {};
    const daemon = fakeDaemon({
      knowledge: emptyDuo,
      embedGet: () => idle,
      importPost: () => new Promise<Reply>((resolve) => (resolveImport = resolve)),
    });
    renderOnboarding();

    fireEvent.change(await screen.findByRole("textbox", { name: /conversation export/i }), { target: { value: TRANSCRIPT } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    // The request is the daemon's own: the transcript text, in the body.
    await waitFor(() => expect(daemon.count("POST", "/corpus/import-paste")).toBe(1));
    expect(daemon.calls.find((c) => c.path === "/corpus/import-paste")?.body).toEqual({ transcript: TRANSCRIPT });
    // While it runs: said, announced politely, and not re-submittable.
    const progress = await screen.findByTestId("import-progress");
    expect(progress).toHaveTextContent(/importing/i);
    expect(progress).toHaveAttribute("role", "status");
    expect(screen.getByRole("button", { name: /importing/i })).toBeDisabled();

    resolveImport([200, summary({ written: 3, skipped: 1, discardedAboveCeiling: 2 })]);
    const done = await screen.findByTestId("import-summary");
    expect(done).toHaveTextContent(/imported 3 records/i);
    expect(done).toHaveTextContent(/1 already present/i);
    expect(done).toHaveTextContent(/2 held back above the classification ceiling/i);
  });

  it("says a transcript the daemon judged not work-relevant imported nothing — a 200 is not a success story", async () => {
    fakeDaemon({ knowledge: emptyDuo, embedGet: () => idle, importPost: () => [200, summary({ workRelevant: false, written: 0, skipped: 0 })] });
    renderOnboarding();

    fireEvent.change(await screen.findByRole("textbox", { name: /conversation export/i }), { target: { value: TRANSCRIPT } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    const done = await screen.findByTestId("import-summary");
    expect(done).toHaveTextContent(/not work-relevant/i);
    expect(done).toHaveTextContent(/nothing was imported/i);
    // …and the flow does not move on as if records had landed.
    expect(screen.queryByRole("button", { name: "Start embedding" })).not.toBeInTheDocument();
  });

  it("renders the daemon's refusal of a malformed export verbatim", async () => {
    const message = 'Expected a pasted transcript with lines starting "Human: " / "Assistant: ". Found no recognisable turn.';
    fakeDaemon({
      knowledge: emptyDuo,
      embedGet: () => idle,
      importPost: () => [400, { error: { code: "MalformedTranscriptError", message } }],
    });
    renderOnboarding();

    fireEvent.change(await screen.findByRole("textbox", { name: /conversation export/i }), { target: { value: "no turns here" } });
    fireEvent.click(screen.getByRole("button", { name: "Import" }));

    expect((await screen.findByTestId("mutation-error")).textContent).toBe(message);
  });

  it("offers nothing to import until there is something to import", async () => {
    const daemon = fakeDaemon({ knowledge: emptyDuo, embedGet: () => idle, importPost: () => [200, summary()] });
    renderOnboarding();

    const button = await screen.findByRole("button", { name: "Import" });
    expect(button).toBeDisabled();
    fireEvent.change(screen.getByRole("textbox", { name: /conversation export/i }), { target: { value: "   \n " } });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(daemon.count("POST", "/corpus/import-paste")).toBe(0);
  });

  it("a paired but empty duo opens on onboarding, on the import step", async () => {
    fakeDaemon({ knowledge: emptyDuo, embedGet: () => idle });
    renderOnboarding();

    const step = await screen.findByTestId("onboarding-step-import");
    expect(step).toHaveAttribute("data-state", "current");
    expect(screen.getByTestId("onboarding-step-embed")).toHaveAttribute("data-state", "waiting");
    expect(screen.getByTestId("onboarding-step-derive")).toHaveAttribute("data-state", "waiting");
  });
});

describe("#49 AC2 — deriving is observable", () => {
  it("starts the embed job and shows how far along it is, in the daemon's own counts, until it is done", async () => {
    const status = script([embedStatus("running", 10), embedStatus("running", 30), embedStatus("done", 40)]);
    let started = false;
    const daemon = fakeDaemon({
      knowledge: importedDuo,
      embedGet: () => (started ? status() : idle),
      embedPost: () => {
        started = true;
        return [202, embedStatus("running", 0)];
      },
    });
    renderOnboarding();

    expect(await screen.findByTestId("onboarding-step-embed")).toHaveAttribute("data-state", "current");
    fireEvent.click(await screen.findByRole("button", { name: "Start embedding" }));
    await waitFor(() => expect(daemon.count("POST", "/corpus/embed")).toBe(1));

    // A real bar with a real name and the daemon's numbers — never a percentage numeral (§1.6).
    const bar = await screen.findByRole("progressbar", { name: /embedding/i });
    await waitFor(() => expect(bar).toHaveAttribute("aria-valuenow", "30"));
    expect(bar).toHaveAttribute("aria-valuemax", "40");
    expect(screen.getByTestId("embed-progress")).toHaveTextContent(/30 of 40 records embedded/i);
    expect(screen.getByTestId("embed-progress").textContent).not.toMatch(/%/);

    // The watch stops when the job does, and the step is done.
    await waitFor(() => expect(screen.getByTestId("onboarding-step-embed")).toHaveAttribute("data-state", "done"));
    expect(screen.getByTestId("embed-progress")).toHaveTextContent(/40 of 40 records embedded/i);
    const pollsAtDone = daemon.count("GET", "/corpus/embed");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 5));
    expect(daemon.count("GET", "/corpus/embed")).toBe(pollsAtDone);
  });

  it("a failed job says why, in the daemon's own words, and can be started again", async () => {
    const reason = "connect ECONNREFUSED 127.0.0.1:11434";
    fakeDaemon({ knowledge: importedDuo, embedGet: () => embedStatus("error", 10, 40, reason) });
    renderOnboarding();

    expect((await screen.findByTestId("embed-error")).textContent).toBe(reason);
    expect(screen.getByTestId("onboarding-step-embed")).not.toHaveAttribute("data-state", "done");
    expect(screen.getByRole("button", { name: "Start embedding" })).toBeEnabled();
  });

  it("a job already running elsewhere is watched, with the daemon's refusal said as it said it", async () => {
    const message = "An embed is already running for this corpus; watch GET /corpus/embed for its progress.";
    let running = false;
    fakeDaemon({
      knowledge: importedDuo,
      embedGet: () => (running ? embedStatus("running", 5) : idle),
      embedPost: () => {
        running = true;
        return [409, { error: { code: "embed_already_running", message } }];
      },
    });
    renderOnboarding();

    fireEvent.click(await screen.findByRole("button", { name: "Start embedding" }));

    expect((await screen.findByTestId("mutation-error")).textContent).toBe(message);
    await waitFor(() => expect(screen.getByTestId("embed-progress")).toHaveTextContent(/5 of 40 records embedded/i));
  });

  it("watches derivation through what the daemon reports of it — the app cannot run it, and says where it runs", async () => {
    let knowledge = knowledgeFor({ records: { total: 40, bySource: { paste: 40 } } });
    const daemon = fakeDaemon({ knowledge: () => knowledge, embedGet: () => embedStatus("done", 40) });
    const onFinish = renderOnboarding();

    const derive = await screen.findByTestId("onboarding-step-derive");
    await waitFor(() => expect(derive).toHaveAttribute("data-state", "current"));
    // No route starts derivation (`duo derive` is a terminal stage), so the
    // app must not offer a button that pretends to — it says where it runs.
    expect(within(derive).queryByRole("button")).not.toBeInTheDocument();
    expect(derive).toHaveTextContent(/duo derive/);
    expect(derive).toHaveTextContent(/on your Mac/i);
    expect(daemon.calls.some((c) => c.method === "POST" && /derive/.test(c.path))).toBe(false);

    // The watch: the daemon's own counts move as derivation proceeds.
    knowledge = knowledgeFor({
      records: { total: 40, bySource: { paste: 40 } },
      corpus: { tooThin: false, minimumQuestionsToCharacterize: 10, totalQuestions: 14, periodStart: null, periodEnd: null, topicBreakdown: [{ topicId: "t1", label: "scheduling", count: 14, share: 1 }] },
    });
    await waitFor(() => expect(screen.getByTestId("derive-progress")).toHaveTextContent(/14 questions found/i));
    expect(screen.getByTestId("derive-progress")).toHaveTextContent(/1 topic/i);
    expect(screen.getByTestId("derive-progress")).toHaveTextContent(/0 rules derived/i);
    expect(onFinish).not.toHaveBeenCalled();
  });
});

describe("#49 AC3 — it ends at the Mirror", () => {
  it("finishes the moment the first rules are derived, and only once", async () => {
    let knowledge = importedDuo();
    const daemon = fakeDaemon({ knowledge: () => knowledge, embedGet: () => embedStatus("done", 40) });
    const onFinish = renderOnboarding();
    await waitFor(() => expect(screen.getByTestId("onboarding-step-derive")).toHaveAttribute("data-state", "current"));

    knowledge = withPendingRules(4);
    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1));
    // Keep watching for a while: a later poll must not finish it again.
    const before = daemon.count("GET", "/knowledge");
    await waitFor(() => expect(daemon.count("GET", "/knowledge")).toBeGreaterThan(before));
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("does not whisk away an owner who opens onboarding on a duo that already has rules — it points at the Mirror instead", async () => {
    fakeDaemon({ knowledge: () => withPendingRules(4), embedGet: () => embedStatus("done", 40) });
    const onFinish = renderOnboarding();

    const link = await screen.findByRole("link", { name: /review your rules in the mirror/i });
    expect(link).toHaveAttribute("href", "#mirror");
    await new Promise((resolve) => setTimeout(resolve, POLL_MS * 3));
    expect(onFinish).not.toHaveBeenCalled();
  });

  it("in the app, completing onboarding lands on the Mirror, on the first derived rules, with approve and reject in reach", async () => {
    const derived: Rule = {
      id: "r1",
      topicId: "t1",
      text: "Money questions get answered the same day.",
      status: "confirmed",
      supportCount: 6,
      consistency: 0.9,
      createdAt: "2026-09-26T08:00:00.000Z",
      lastConfirmedAt: null,
      reviewStatus: "pending",
      origin: "derived",
    };
    let knowledge = importedDuo();
    let listing: RuleReviewListing = { awaitingApproval: [], weakSignals: [], inconsistent: [], approved: [], rejected: [] };
    fakeDaemon({ knowledge: () => knowledge, embedGet: () => embedStatus("done", 40), rules: () => listing });
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    window.location.hash = "#onboarding";
    render(<App />);

    await screen.findByTestId("onboarding");
    await waitFor(() => expect(screen.getByTestId("onboarding-step-derive")).toHaveAttribute("data-state", "current"));

    knowledge = withPendingRules(1);
    listing = { ...listing, awaitingApproval: [derived] };

    // The default poll is human-paced; the wait is the flow's own.
    await screen.findByTestId("mirror", undefined, { timeout: 6000 });
    expect(window.location.hash).toBe("#mirror");
    const card = await screen.findByTestId("rule-card");
    expect(card).toHaveTextContent("Money questions get answered the same day.");
    expect(within(card).getByTestId("approve-rule")).toBeEnabled();
    expect(within(card).getByTestId("reject-rule")).toBeEnabled();
  }, 10_000);
});

describe("#49 AC4 — a duo built in a terminal never sees onboarding", () => {
  async function launch(hash = "") {
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    window.location.hash = hash;
    render(<App />);
  }

  it("an existing duo opens on Review as it always did — onboarding is skipped", async () => {
    const daemon = fakeDaemon({ knowledge: existingDuo, embedGet: () => idle });
    await launch();

    // Review's empty state reads the same knowledge; once it has rendered
    // the daemon's facts, the gate has had every chance to redirect.
    await screen.findByTestId("review-empty-knowledge");
    await waitFor(() => expect(screen.getByTestId("review-empty-knowledge")).toHaveTextContent(/312 records/));
    expect(daemon.count("GET", "/knowledge")).toBeGreaterThan(0);
    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
    // …and the job routes were never touched: nothing started, nothing watched.
    expect(daemon.calls.some((c) => c.path.startsWith("/corpus"))).toBe(false);
  });

  it("a paired but empty duo, opened on the default surface, is taken to onboarding", async () => {
    fakeDaemon({ knowledge: emptyDuo, embedGet: () => idle });
    await launch();

    await screen.findByTestId("onboarding");
    expect(window.location.hash).toBe("#onboarding");
  });

  it("a payload that is not the daemon's documented shape is not 'an empty duo' — Review stays", async () => {
    // The cache is a storage layer, not a promise (Knowledge's own law):
    // an array where the object should be must never launch a first run.
    fakeDaemon({ knowledge: () => [] as unknown as DuoKnowledge, embedGet: () => idle });
    await launch();

    await screen.findByTestId("review-empty");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
    expect(window.location.hash).toBe("");
  });

  it("Setup is unchanged: the address and token still pair a device, and it offers no import — that is a paired duo's business", () => {
    const onConnect = vi.fn();
    render(<Setup onConnect={onConnect} onWorkspaceSession={vi.fn()} />);

    expect(screen.queryByRole("textbox", { name: /conversation export/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("onboarding")).not.toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText("100.64.1.5:7717"), { target: { value: "100.64.1.5:7717" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok" } });
    fireEvent.click(screen.getByText("Connect"));
    expect(onConnect).toHaveBeenCalledWith({ baseUrl: "http://100.64.1.5:7717", token: "tok" });
  });
});

describe("#49 — the conventions it inherits (#39 accessibility, #38 responsive)", () => {
  it("one h1, the steps as an ordered list with the current one marked, and every control a real touch target", async () => {
    fakeDaemon({ knowledge: importedDuo, embedGet: () => idle });
    renderOnboarding();

    const root = await screen.findByTestId("onboarding");
    expect(root.querySelectorAll("h1")).toHaveLength(1);
    const steps = within(screen.getByRole("list", { name: /steps/i })).getAllByRole("listitem");
    expect(steps).toHaveLength(3);
    expect(steps.filter((s) => s.getAttribute("aria-current") === "step")).toHaveLength(1);
    expect(screen.getByTestId("onboarding-step-embed")).toHaveAttribute("aria-current", "step");
    const controls = [...root.querySelectorAll("button, input, select, textarea")];
    expect(controls.length).toBeGreaterThan(0);
    for (const control of controls) {
      expect(control.className, `<${control.tagName.toLowerCase()}> below the 44px touch-target law`).toMatch(/(^|\s)min-h-11\b/);
    }
  });

  it("the flow's progress is announced politely, never assertively", async () => {
    fakeDaemon({ knowledge: importedDuo, embedGet: () => embedStatus("running", 10) });
    renderOnboarding();

    const progress = await screen.findByTestId("embed-progress");
    expect(progress).toHaveAttribute("role", "status");
    expect(document.querySelector('[role="alert"]')).toBeNull();
  });

  it("the app names the surface and its way back: onboarding is an address, and Knowledge links to it", async () => {
    fakeDaemon({ knowledge: existingDuo, embedGet: () => idle });
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    window.location.hash = "#knowledge";
    render(<App />);

    const link = await screen.findByRole("link", { name: /import more history/i });
    expect(link).toHaveAttribute("href", "#onboarding");
  });
});
