import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { shouldPersistQuery } from "../src/api/queries.js";
import type { AutonomyGrant, AutonomyOffer, DraftRecord, ScheduledSend } from "../src/api/types.js";
import { AutonomousSends, secondsLeft } from "../src/components/AutonomousSends.js";
import { DraftCard } from "../src/components/DraftCard.js";
import { ScheduledSends } from "../src/components/ScheduledSends.js";
import { SendingSettings } from "../src/components/SendingSettings.js";
import { AutonomyOfferCard, TrainingCards } from "../src/components/TrainingCards.js";
import { MayDo } from "../src/profile/MayDo.js";
import { requestEditOnOpen } from "../src/editOnOpen.js";

vi.mock("../src/sync.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/sync.js")>();
  return { ...actual, useSyncStatus: () => ({ reachable: true, lastSyncedAt: null }) };
});

/*
 * #266: your duo asks to answer one person by itself once its record with
 * them earns it — Accept/Decline are the daemon's routes. #268: whatever it
 * then sends by itself waits in a live strip in Waiting on you, with Stop and
 * Edit, for the undo window the owner sets.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };
const WEI_KEY = "recipient:@wei:example.org";

const record = {
  recipientKey: WEI_KEY,
  recipientName: "Wei",
  considered: 20,
  sentUnedited: 20,
  edited: 0,
  dismissed: 0,
  uneditedShare: 1,
  since: "2026-09-01T00:00:00.000Z",
  latest: "2026-10-05T00:00:00.000Z",
  recentClean: true,
  disqualified: false,
};

const offer: AutonomyOffer = {
  recipientKey: WEI_KEY,
  recipientName: "Wei",
  trackRecord: record,
  holdSeconds: 30,
  evidence: "You've sent all of my last 20 replies to Wei without changing a word. May I answer Wei myself? I'd hold each answer for 30 seconds first, so you can stop or edit it.",
};

const grant: AutonomyGrant = { recipientKey: WEI_KEY, recipientName: "Wei", grantedAt: "2026-10-05T09:00:00.000Z", evidence: record, revokedAt: null };

const draft: DraftRecord = {
  id: "d1",
  question: "Where's the deploy runbook?",
  threadContext: null,
  draftText: "It's on the wiki under Deploys.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.9,
  sources: [],
  createdAt: "2026-10-06T12:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "channel", channelKind: "matrix", askerRef: "@wei:example.org", threadId: "!r:example.org", permalink: null },
  delivery: null,
  recipient: { id: "@wei:example.org", name: "Wei" },
};

function heldRow(sendAt: string): ScheduledSend {
  return {
    draftId: "d1",
    outcome: "sent",
    sentText: null,
    sendAt,
    scheduledAt: "2026-10-06T12:00:00.000Z",
    state: "scheduled",
    settledAt: null,
    failureReason: null,
    autonomous: true,
    draft,
  };
}

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function calls(suffix: string) {
  return (fetch as unknown as { mock: { calls: unknown[][] } }).mock.calls
    .filter((call) => String(call[0]).split("?")[0]!.endsWith(suffix))
    .map((call) => ({
      url: String(call[0]),
      method: (call[1] as RequestInit | undefined)?.method ?? "GET",
      body: (call[1] as RequestInit | undefined)?.body ? JSON.parse((call[1] as RequestInit).body as string) : undefined,
    }));
}

interface World {
  offers: AutonomyOffer[];
  grants: AutonomyGrant[];
  held: ScheduledSend[];
  stopStatus: number;
  holdSeconds: number;
}
let world: World;

beforeEach(() => {
  world = { offers: [offer], grants: [grant], held: [heldRow(new Date(Date.now() + 25_000).toISOString())], stopStatus: 200, holdSeconds: 30 };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = String(url).replace("http://test", "");
      const method = init?.method ?? "GET";
      if (path === "/autonomy/offers") {
        return new Response(JSON.stringify(world.offers), { status: 200 });
      }
      if (path.startsWith("/autonomy/offers/") && method === "POST") {
        world.offers = [];
        return path.endsWith("/accept") ? new Response(JSON.stringify(grant), { status: 201 }) : new Response(null, { status: 204 });
      }
      if (path === "/autonomy/grants" && method === "GET") {
        return new Response(JSON.stringify(world.grants), { status: 200 });
      }
      if (path.startsWith("/autonomy/grants/") && path.endsWith("/revoke") && method === "POST") {
        world.grants = [];
        return new Response(JSON.stringify({ ...grant, revokedAt: "2026-10-06T12:00:00.000Z", stoppedDraftIds: [] }), { status: 200 });
      }
      if (path === "/autonomous-sends") {
        return new Response(JSON.stringify(world.held), { status: 200 });
      }
      if (path.startsWith("/autonomous-sends/") && method === "POST") {
        if (world.stopStatus !== 200) {
          return new Response(JSON.stringify({ error: { code: "ScheduledSendNotFoundError", message: "No send is scheduled" } }), { status: world.stopStatus });
        }
        world.held = [];
        return new Response(JSON.stringify({ draft }), { status: 200 });
      }
      if (path === "/scheduled-sends") {
        return new Response(JSON.stringify([heldRow(new Date(Date.now() + 25_000).toISOString())]), { status: 200 });
      }
      if (path === "/settings/autonomy" && method === "GET") {
        return new Response(JSON.stringify({ holdSeconds: world.holdSeconds }), { status: 200 });
      }
      if (path === "/settings/autonomy" && method === "PUT") {
        const body = JSON.parse(init!.body as string) as { holdSeconds: number };
        world.holdSeconds = body.holdSeconds;
        return new Response(JSON.stringify({ holdSeconds: body.holdSeconds }), { status: 200 });
      }
      if (path === "/trust/grid" || path === "/trust/promotions" || path === "/review" || path === "/audit" || path === "/actions/t4/pending") {
        return new Response(JSON.stringify([]), { status: 200 });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.location.hash = "";
});

describe("#266 — the autonomy offer card", () => {
  it("states the evidence in the daemon's plain words, and what accepting does", () => {
    mount(<AutonomyOfferCard api={api} offer={offer} />);
    const card = screen.getByTestId("autonomy-offer-card");
    expect(card).toHaveTextContent("You've sent all of my last 20 replies to Wei without changing a word. May I answer Wei myself?");
    expect(card).toHaveTextContent("Only Wei, and only answers I'm confident in");
  });

  it("Accept calls the accept route for exactly that person", async () => {
    mount(<AutonomyOfferCard api={api} offer={offer} />);
    fireEvent.click(screen.getByRole("button", { name: "Answer Wei for me" }));
    await waitFor(() =>
      expect(calls("/accept")).toEqual([{ url: `http://test/autonomy/offers/${encodeURIComponent(WEI_KEY)}/accept`, method: "POST", body: undefined }]),
    );
    expect(calls("/decline")).toEqual([]);
  });

  it("Decline calls the decline route", async () => {
    mount(<AutonomyOfferCard api={api} offer={offer} />);
    fireEvent.click(screen.getByRole("button", { name: "Keep asking me" }));
    await waitFor(() => expect(calls("/decline")).toEqual([{ url: `http://test/autonomy/offers/${encodeURIComponent(WEI_KEY)}/decline`, method: "POST", body: undefined }]));
  });

  it("arrives among your duo's training cards, and an offer the daemon did not shape is never shown", async () => {
    world.offers = [offer, { recipientKey: 7 } as unknown as AutonomyOffer];
    mount(<TrainingCards api={api} />);
    expect(await screen.findAllByTestId("autonomy-offer-card")).toHaveLength(1);
  });
});

describe("#268 — the live strip of what your duo is about to send", () => {
  it("shows the reply, who it's to and the time left", async () => {
    mount(<AutonomousSends api={api} />);
    const row = await screen.findByTestId("autonomous-send");
    expect(row).toHaveTextContent("It's on the wiki under Deploys.");
    expect(row).toHaveTextContent("In reply to: Where's the deploy runbook?");
    expect(within(row).getByTestId("autonomous-send-countdown")).toHaveTextContent(/Answering Wei in \d+s — you said I could\./);
  });

  it("Stop calls the daemon's stop route and the strip empties", async () => {
    mount(<AutonomousSends api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    await waitFor(() => expect(calls("/autonomous-sends/d1/stop")).toEqual([{ url: "http://test/autonomous-sends/d1/stop", method: "POST", body: undefined }]));
    await waitFor(() => expect(screen.queryByTestId("autonomous-send")).not.toBeInTheDocument());
  });

  it("Edit stops it and opens the draft in the editor", async () => {
    mount(<AutonomousSends api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Edit" }));
    await waitFor(() => expect(calls("/autonomous-sends/d1/edit")).toHaveLength(1));
    await waitFor(() => expect(window.location.hash).toBe("#draft/d1"));
    cleanup();
    // The draft page that opens next starts in its editor.
    mount(<DraftCard api={api} draft={draft} />);
    expect(screen.getByRole("textbox")).toHaveValue("It's on the wiki under Deploys.");
  });

  it("a Stop that arrives after the window says it was too late — never that it stopped", async () => {
    world.stopStatus = 404;
    mount(<AutonomousSends api={api} />);
    fireEvent.click(await screen.findByRole("button", { name: "Stop" }));
    expect(await screen.findByTestId("autonomous-send-gone")).toHaveTextContent("Too late to stop that one — it has already been sent.");
  });

  it("renders nothing when nothing is held", async () => {
    world.held = [];
    mount(<AutonomousSends api={api} />);
    await waitFor(() => expect(calls("/autonomous-sends")).toHaveLength(1));
    expect(screen.queryByTestId("autonomous-sends")).not.toBeInTheDocument();
  });

  it("an autonomous hold is never listed as one you scheduled", async () => {
    mount(<ScheduledSends api={api} />);
    await waitFor(() => expect(calls("/scheduled-sends")).toHaveLength(1));
    expect(screen.queryByTestId("scheduled-send")).not.toBeInTheDocument();
  });

  it("counts down in whole seconds and never below zero", () => {
    expect(secondsLeft("2026-10-06T12:00:30.000Z", Date.parse("2026-10-06T12:00:00.500Z"))).toBe(30);
    expect(secondsLeft("2026-10-06T12:00:30.000Z", Date.parse("2026-10-06T12:01:00.000Z"))).toBe(0);
  });

  it("is never persisted — a window of seconds must not be read back from storage", () => {
    const query = { queryKey: ["drafts", { autonomous: true }], state: { status: "success" } } as unknown as Parameters<typeof shouldPersistQuery>[0];
    expect(shouldPersistQuery(query)).toBe(false);
  });
});

describe("#266 — reviewing and revoking granted autonomy", () => {
  it("May do lists who your duo answers by itself, and Take back revokes it", async () => {
    mount(<MayDo api={api} />);
    const row = await screen.findByTestId("may-autonomy-row");
    expect(row).toHaveTextContent("Wei");
    expect(row).toHaveTextContent("after sending 20 of its last 20 replies unedited");
    fireEvent.click(within(row).getByRole("button", { name: "Take back" }));
    await waitFor(() =>
      expect(calls("/revoke")).toEqual([{ url: `http://test/autonomy/grants/${encodeURIComponent(WEI_KEY)}/revoke`, method: "POST", body: undefined }]),
    );
    await waitFor(() => expect(screen.queryByTestId("may-autonomy-row")).not.toBeInTheDocument());
  });

  it("an offer left alone waits in May do too", async () => {
    mount(<MayDo api={api} />);
    expect(await screen.findByTestId("autonomy-offer-card")).toBeInTheDocument();
  });
});

describe("#268 — the undo-window setting", () => {
  it("saves a new wait to the daemon", async () => {
    mount(<SendingSettings api={api} />);
    const select = await screen.findByTestId("settings-autonomy-hold-select");
    await waitFor(() => expect(select).toHaveValue("30"));
    fireEvent.change(select, { target: { value: "60" } });
    await waitFor(() => expect(calls("/settings/autonomy").filter((call) => call.method === "PUT")).toEqual([{ url: "http://test/settings/autonomy", method: "PUT", body: { holdSeconds: 60 } }]));
  });

  it("Off asks first; keeping the wait sends nothing, turning it off sends the explicit confirmation", async () => {
    mount(<SendingSettings api={api} />);
    const select = await screen.findByTestId("settings-autonomy-hold-select");
    fireEvent.change(select, { target: { value: "0" } });
    expect(screen.getByTestId("settings-autonomy-hold-confirm")).toHaveTextContent("there is no chance to stop one");
    fireEvent.click(screen.getByRole("button", { name: "Keep the wait" }));
    expect(calls("/settings/autonomy").filter((call) => call.method === "PUT")).toEqual([]);

    fireEvent.change(select, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "Turn it off" }));
    await waitFor(() =>
      expect(calls("/settings/autonomy").filter((call) => call.method === "PUT")).toEqual([{ url: "http://test/settings/autonomy", method: "PUT", body: { holdSeconds: 0, confirmNoHold: true } }]),
    );
  });
});

describe("edit-on-open", () => {
  it("is taken once: a second surface for the same draft opens normally", () => {
    requestEditOnOpen("d1");
    mount(<DraftCard api={api} draft={draft} />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
    cleanup();
    mount(<DraftCard api={api} draft={draft} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });
});
