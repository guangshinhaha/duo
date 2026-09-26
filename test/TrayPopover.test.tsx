import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";
import { DraftTray } from "../src/components/DraftTray.js";
import { TrayPopover } from "../src/tray/TrayPopover.js";

const sync = vi.hoisted(() => ({ reachable: true }));
vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, useSyncStatus: () => ({ reachable: sync.reachable, lastSyncedAt: null }) };
});

// The shell's own calls: recorded, and answering as the shell does.
const shell = vi.hoisted(() => ({ invoked: [] as Array<{ cmd: string; args: unknown }>, emitted: [] as string[] }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args: unknown) => {
    shell.invoked.push({ cmd, args });
  }),
}));
vi.mock("@tauri-apps/api/event", () => ({
  emit: vi.fn(async (name: string) => {
    shell.emitted.push(name);
  }),
  listen: vi.fn(async () => () => {}),
}));

/*
 * The menu-bar mini tray (#151): what waits, and the one thing that may be
 * done without opening the app — sending a confident draft. Anything else
 * opens the app at its chat, and an action staged for your yes is never
 * decided from here.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

const draft = (id: string, createdAt: string, over: Partial<DraftRecord> = {}): DraftRecord => ({
  id,
  question: `question ${id}`,
  threadContext: null,
  draftText: `answer ${id}`,
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.9,
  sources: [],
  createdAt,
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "channel", channelKind: "native", askerRef: "@bose:w.example", threadId: null, permalink: "https://matrix.to/#/!room:w.example/$e?via=w.example" },
  delivery: null,
  ...over,
});

const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

function stub(drafts: DraftRecord[], confirmations: unknown[] = []) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        return json({});
      }
      if (url.includes("/actions/t4/pending")) {
        return json(confirmations);
      }
      if (url.includes("/drafts?outcome=pending")) {
        return json(drafts);
      }
      return json([]);
    }),
  );
}

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

const posts = () =>
  (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter((call) => String(call[0]).endsWith("/outcome"))
    .map((call) => ({ url: String(call[0]), body: JSON.parse((call[1] as RequestInit).body as string) as unknown }));

beforeEach(() => {
  sync.reachable = true;
  shell.invoked.length = 0;
  shell.emitted.length = 0;
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("#151 — the menu-bar tray", () => {
  it("lists what waits oldest first with the count, and says who asked and what state each is in", async () => {
    stub([
      draft("late", "2026-01-02T00:00:00.000Z", { question: "second question" }),
      draft("early", "2026-01-01T00:00:00.000Z", { question: "first question", confidenceScore: 0.6 }),
    ]);
    mount(<TrayPopover api={api} />);

    const rows = await screen.findAllByTestId("tray-row");
    expect(rows.map((row) => within(row).getByTestId("tray-question").textContent)).toEqual(["first question", "second question"]);
    expect(within(rows[0]!).getByTestId("tray-asker")).toHaveTextContent("bose");
    expect(within(rows[0]!).getByTestId("tray-state")).toHaveTextContent("Draft · hedging");
    expect(within(rows[1]!).getByTestId("tray-state")).toHaveTextContent("Draft ready");
    expect(screen.getByTestId("tray-count")).toHaveTextContent("2");
  });

  it("a confident draft shows what would be sent, and Send records the same outcome the app's Send does", async () => {
    const confident = draft("d1", "2026-01-01T00:00:00.000Z");
    stub([confident]);
    mount(<TrayPopover api={api} />);

    const row = await screen.findByTestId("tray-row");
    expect(within(row).getByTestId("tray-draft-text")).toHaveTextContent("answer d1");
    // The duo's words are behind the duo's line, named as the duo's.
    expect(within(row).getByTestId("tray-draft-attribution")).toHaveTextContent("Your duo");
    fireEvent.click(within(row).getByTestId("tray-send"));
    await waitFor(() => expect(posts()).toHaveLength(1));
    const fromTray = posts()[0]!;
    expect(fromTray.url).toBe("http://test/drafts/d1/outcome");
    expect(await within(row).findByText("Sent")).toBeInTheDocument();
    // The other window is told, so its lists and counts do not wait for their next look.
    expect(shell.emitted).toContain("duo-drafts-changed");

    // …and it is the very record the draft tray's Send writes.
    cleanup();
    stub([confident]);
    mount(<DraftTray api={api} draft={confident} />);
    fireEvent.click(await screen.findByRole("button", { name: "Send" }));
    await waitFor(() => expect(posts()).toHaveLength(1));
    expect(posts()[0]).toEqual(fromTray);
  });

  it("nothing else can be sent from here: a hedged draft, a passed-on question, a refusal and a question you asked yourself only open the app", async () => {
    stub([
      draft("hedged", "2026-01-01T00:00:00.000Z", { confidenceScore: 0.6 }),
      draft("passed", "2026-01-02T00:00:00.000Z", { draftText: null, escalated: true, escalationReason: "No rule covers this." }),
      draft("refused", "2026-01-03T00:00:00.000Z", { draftText: null, escalated: true, refused: true, escalationReason: "A boundary you set." }),
      draft("mine", "2026-01-04T00:00:00.000Z", { provenance: { origin: "owner" } }),
    ]);
    mount(<TrayPopover api={api} />);

    const rows = await screen.findAllByTestId("tray-row");
    expect(rows).toHaveLength(4);
    expect(screen.queryByTestId("tray-send")).toBeNull();
    // Not even the words of a draft that is not sendable.
    expect(screen.queryByTestId("tray-draft-text")).toBeNull();
    expect(rows.map((row) => within(row).getByTestId("tray-state").textContent)).toEqual(["Draft · hedging", "Passed to you", "Refused", "Draft ready"]);
    expect(posts()).toEqual([]);
  });

  it("Open goes to where the draft is decided — its chat, Your duo, a bridged chat, or its own page — through the shell", async () => {
    stub([
      draft("chat", "2026-01-01T00:00:00.000Z", { confidenceScore: 0.6 }),
      draft("mine", "2026-01-02T00:00:00.000Z", { provenance: { origin: "owner" } }),
      draft("slack", "2026-01-03T00:00:00.000Z", { confidenceScore: 0.6, provenance: { origin: "channel", channelKind: "slack", askerRef: "dana", threadId: null, permalink: null } }),
      draft("old", "2026-01-04T00:00:00.000Z", { confidenceScore: 0.6, provenance: { origin: "unknown" } }),
    ]);
    mount(<TrayPopover api={api} />);

    const opens = await screen.findAllByTestId("tray-open");
    for (const open of opens) {
      fireEvent.click(open);
    }
    await waitFor(() => expect(shell.invoked).toHaveLength(4));
    expect(shell.invoked.map((call) => [call.cmd, (call.args as { hash: string }).hash])).toEqual([
      ["open_in_app", `#chat/${encodeURIComponent("!room:w.example")}`],
      ["open_in_app", "#duo"],
      ["open_in_app", `#chat/${encodeURIComponent("bridge:slack:dana")}`],
      ["open_in_app", "#draft/old"],
    ]);
  });

  it("offline, Send is off and says so; it is never queued (AR-15)", async () => {
    sync.reachable = false;
    stub([draft("d1", "2026-01-01T00:00:00.000Z")]);
    mount(<TrayPopover api={api} />);

    expect(await screen.findByTestId("tray-offline")).toHaveTextContent("sending is off");
    const send = await screen.findByTestId("tray-send");
    expect(send).toBeDisabled();
    fireEvent.click(send);
    expect(posts()).toEqual([]);
  });

  it("an action staged for your yes is counted here and decided in the app — there is no approve in the tray", async () => {
    stub([], [{ id: "c1", createdAt: "2026-01-01T00:00:00.000Z" }, { id: "c2", createdAt: "2026-01-02T00:00:00.000Z" }]);
    mount(<TrayPopover api={api} />);

    const row = await screen.findByTestId("tray-confirmations");
    expect(row).toHaveTextContent("2 actions need your yes");
    expect(screen.getByTestId("tray-count")).toHaveTextContent("2");
    expect(within(row).queryByRole("button", { name: /approve|yes|confirm|send/i })).toBeNull();
    fireEvent.click(within(row).getByTestId("tray-open-confirmations"));
    await waitFor(() => expect(shell.invoked).toEqual([{ cmd: "open_in_app", args: { hash: "#confirmations" } }]));
  });

  it("says when nothing waits, and when this device has no duo yet", async () => {
    stub([]);
    mount(<TrayPopover api={api} />);
    expect(await screen.findByTestId("tray-empty")).toHaveTextContent("Nothing waiting on you.");
    expect(screen.queryByTestId("tray-count")).toBeNull();
    cleanup();

    mount(<TrayPopover api={null} />);
    expect(screen.getByTestId("tray-unpaired")).toHaveTextContent("isn’t paired");
  });

  it("outside the shell the same buttons still work — they navigate", async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    vi.mocked(invoke).mockRejectedValueOnce(new Error("not in the shell"));
    stub([draft("old", "2026-01-01T00:00:00.000Z", { confidenceScore: 0.6, provenance: { origin: "unknown" } })]);
    mount(<TrayPopover api={api} />);
    fireEvent.click(await screen.findByTestId("tray-open"));
    await waitFor(() => expect(window.location.hash).toBe("#draft/old"));
  });
});
