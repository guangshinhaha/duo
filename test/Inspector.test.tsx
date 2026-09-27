import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";
import { DraftTray } from "../src/components/DraftTray.js";
import { DuoInfo, RoomInfo, WhyPanel, whyReading } from "../src/shell/Inspector.js";
import { InspectorVisibleProvider } from "../src/shell/InspectorContext.js";
import type { RoomSummary } from "../src/workspace/matrix.js";
import { stubDesktop, stubPhone } from "./desktop.js";

/*
 * The inspector (#147): why a draft says what it says, at zero clicks beside
 * the chat on a desktop, and one tap (a sheet) where there is no room.
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

const draft = (over: Partial<DraftRecord> = {}): DraftRecord => ({
  id: "d1",
  question: "How do I get read access to the prod logs?",
  threadContext: null,
  draftText: "Request read-only through the runbook.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.9,
  sources: [
    { kind: "rule", id: "r1", label: "Deploy access: point to the runbook" },
    { kind: "evidence", id: "e1", label: "#platform-help · 14 Aug · a long label that should be readable in full when it is opened" },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.55,
  provenance: { origin: "channel", channelKind: "slack", askerRef: "U1", threadId: null, permalink: "https://example.slack.com/archives/C1/p1" },
  delivery: null,
  ...over,
});

const room = (over: Partial<RoomSummary> = {}): RoomSummary => ({
  roomId: "!p:w",
  kind: "group",
  name: "project-x",
  members: [
    { userId: "@bose:w", name: "Bose" },
    { userId: "@duo-carol:w", name: "Not Carol" },
  ],
  latest: null,
  unread: { notifications: 0, mentions: 0 },
  muted: false,
  notifications: "all",
  ...over,
});

function mount(ui: ReactElement) {
  return render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })}>{ui}</QueryClientProvider>);
}

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("WhyPanel — the reasons, in the daemon's own words", () => {
  it("says how sure it is in words for each of the four states, never a number", () => {
    expect(whyReading("confident")).toBe("Your duo is sure of this answer.");
    expect(whyReading("hedged")).toContain("less sure");
    expect(whyReading("escalated")).toContain("passed the question to you");
    expect(whyReading("refused")).toContain("A boundary you set");
    for (const state of ["confident", "hedged", "escalated", "refused"] as const) {
      expect(whyReading(state)).not.toMatch(/\d|%/);
    }
  });

  it("shows the standing order (opening in Rules), what it drew on (readable in full), who is asking and where, and when", () => {
    mount(<WhyPanel draft={draft()} />);
    expect(screen.getByTestId("why-reading")).toHaveTextContent("Your duo is sure of this answer.");
    expect(screen.getByTestId("why-rule")).toHaveAttribute("href", "#duo/profile/rules");
    expect(screen.getByTestId("why-rule")).toHaveTextContent("Deploy access: point to the runbook");
    expect(screen.getByTestId("why-sources")).toHaveTextContent("1 source");
    expect(screen.getByTestId("why-source-full")).toHaveTextContent("a long label that should be readable in full");
    // Who asked and where — the daemon's strings, verbatim, with the message one click away.
    expect(screen.getByTestId("draft-origin")).toHaveTextContent("Asked by U1 in slack");
    expect(screen.getByTestId("origin-permalink")).toHaveAttribute("href", "https://example.slack.com/archives/C1/p1");
    expect(screen.getByTestId("why-when")).toBeInTheDocument();
  });

  it("is honest when there is nothing to cite, and when it does not know where the question came from", () => {
    mount(<WhyPanel draft={draft({ sources: [], provenance: { origin: "unknown" } })} />);
    expect(screen.getByTestId("why-rules")).toHaveTextContent("No standing order applied.");
    expect(screen.getByTestId("why-sources")).toHaveTextContent("Nothing it could cite.");
    expect(screen.getByTestId("why-asker")).toHaveTextContent("Where this came from wasn't recorded.");
    cleanup();
    mount(<WhyPanel draft={draft({ provenance: { origin: "owner" } })} />);
    expect(screen.getByTestId("why-asker")).toHaveTextContent("You asked this yourself.");
  });
});

describe("RoomInfo and DuoInfo — when nothing is waiting", () => {
  it("names who is in a conversation by the id grammar, never a name a duo chose", () => {
    mount(<RoomInfo room={room()} />);
    expect(screen.getByTestId("room-info")).toHaveTextContent("project-x");
    const members = within(screen.getByTestId("room-info-members")).getAllByRole("listitem").map((li) => li.textContent);
    expect(members).toEqual(["Bose", "carol's duo"]);
    expect(screen.getByTestId("room-info").textContent).not.toContain("Not Carol");
    expect(screen.getByTestId("room-info-duo")).toHaveTextContent("Nothing is sent without you.");
  });

  it("a colleague's duo is said to be theirs, never them", () => {
    mount(<RoomInfo room={room({ name: null, members: [{ userId: "@duo-carol:w", name: "Carol" }] })} />);
    expect(screen.getByTestId("room-info")).toHaveTextContent("carol's duo");
    expect(screen.getByTestId("room-info")).toHaveTextContent("never as the owner");
  });

  it("Your duo opens onto its five profile tabs", () => {
    mount(<DuoInfo />);
    expect(["portrait", "knows", "may", "rules", "activity"].map((tab) => screen.getByTestId(`duo-info-${tab}`).getAttribute("href"))).toEqual([
      "#duo/profile",
      "#duo/profile/knows",
      "#duo/profile/may",
      "#duo/profile/rules",
      "#duo/profile/activity",
    ]);
  });
});

describe("the tray's Why? sheet — one tap where there is no room for the column", () => {
  it("opens the same panel as a sheet, and closes it", async () => {
    mount(<DraftTray api={api} draft={draft()} />);
    fireEvent.click(screen.getByTestId("tray-why"));
    const sheet = await screen.findByTestId("why-sheet");
    expect(within(sheet).getByTestId("why-panel")).toBeInTheDocument();
    expect(within(sheet).getByTestId("why-rule")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByTestId("why-close"));
    await waitFor(() => expect(screen.queryByTestId("why-sheet")).toBeNull());
  });

  it("offers no Why? where the inspector is already showing it", () => {
    mount(
      <InspectorVisibleProvider value>
        <DraftTray api={api} draft={draft()} />
      </InspectorVisibleProvider>,
    );
    expect(screen.queryByTestId("tray-why")).toBeNull();
    expect(screen.getByTestId("draft-tray-why")).toHaveTextContent("Standing order: Deploy access");
  });
});

describe("the inspector column in the shell", () => {
  function shell(drafts: DraftRecord[]) {
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/drafts") ? drafts : []), { status: 200 })),
    );
  }

  it("is a third column on a wide window whenever there is a draft to explain, and needs no clicks", async () => {
    stubDesktop();
    shell([draft({ provenance: { origin: "owner" } })]);
    window.location.hash = "#duo";
    render(<App />);
    const inspector = await screen.findByTestId("inspector");
    expect(inspector).toHaveAttribute("aria-label", "Details");
    expect(await within(inspector).findByTestId("why-reading")).toHaveTextContent("Your duo is sure of this answer.");
    // …so the tray does not repeat it behind a button.
    await waitFor(() => expect(screen.queryByTestId("tray-why")).toBeNull());
  });

  it("shows Your duo's way into its profile when nothing is waiting, and nothing at all on the list", async () => {
    stubDesktop();
    shell([]);
    window.location.hash = "#duo";
    const view = render(<App />);
    expect(await screen.findByTestId("duo-info")).toBeInTheDocument();
    view.unmount();
    window.location.hash = "#chats";
    render(<App />);
    await screen.findByTestId("chat-list");
    expect(screen.queryByTestId("inspector")).toBeNull();
  });

  it("⌘I turns it off and on, and the choice is remembered on this device", async () => {
    stubDesktop();
    shell([draft({ provenance: { origin: "owner" } })]);
    window.location.hash = "#duo";
    const view = render(<App />);
    await screen.findByTestId("inspector");
    act(() => void fireEvent.keyDown(window, { key: "i", metaKey: true }));
    await waitFor(() => expect(screen.queryByTestId("inspector")).toBeNull());
    expect(localStorage.getItem("duo.inspector")).toBe("closed");
    // With it off, the tray offers Why? again, and there is a way to bring it back.
    expect(await screen.findByTestId("tray-why")).toBeInTheDocument();
    expect(screen.getByTestId("inspector-show")).toBeInTheDocument();
    view.unmount();

    render(<App />); // a fresh launch: still off
    await screen.findByTestId("draft-tray");
    expect(screen.queryByTestId("inspector")).toBeNull();
    fireEvent.click(await screen.findByTestId("inspector-show"));
    expect(await screen.findByTestId("inspector")).toBeInTheDocument();
    expect(localStorage.getItem("duo.inspector")).toBe("open");
    fireEvent.click(screen.getByTestId("inspector-hide"));
    await waitFor(() => expect(screen.queryByTestId("inspector")).toBeNull());
  });

  it("is not on a phone: there the tray's Why? sheet is the way", async () => {
    stubPhone();
    shell([draft({ provenance: { origin: "owner" } })]);
    window.location.hash = "#duo";
    render(<App />);
    await screen.findByTestId("draft-tray");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByTestId("tray-why")).toBeInTheDocument();
  });
});
