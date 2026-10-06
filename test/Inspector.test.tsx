import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { DraftRecord } from "../src/api/types.js";
import { DraftTray } from "../src/components/DraftTray.js";
import { DuoInfo, RoomInfo, WhyPanel, whyReading } from "../src/shell/Inspector.js";
import type { RoomSummary, SharedFile, WorkspaceConnection } from "../src/workspace/matrix.js";
import type { StagedShare } from "../src/workspace/sharing.js";
import { stubDesktop, stubPhone } from "./desktop.js";

/*
 * Why? and Info (#184, #185): a draft's why opens beside it only when asked —
 * a popover on a desktop, a sheet on a phone — and the Info panel is a side
 * column that opens from the chat header or ⌘I, closed by default.
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
  topic: null,
  avatarUrl: null,
  members: [
    { userId: "@bose:w", name: "Bose" },
    { userId: "@duo-carol:w", name: "Not Carol" },
  ],
  latest: null,
  unread: { notifications: 0, mentions: 0 },
  muted: false,
  notifications: "all",
  canEdit: { name: false, topic: false, avatar: false },
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

  it("#262: names who this draft was tuned for, only when the daemon actually adapted it", () => {
    mount(
      <WhyPanel
        draft={draft({
          adaptedForRecipient: true,
          recipientAdaptation: { recipientId: "@wei:w", recipientName: "Wei", sampleSize: 8, register: "formal" },
        })}
      />,
    );
    expect(screen.getByTestId("why-recipient-adaptation")).toHaveTextContent("Tuned for how you write to Wei.");

    cleanup();
    // Below the daemon's sample threshold: the flag is false and there's nothing to name.
    mount(<WhyPanel draft={draft({ adaptedForRecipient: false, recipientAdaptation: null })} />);
    expect(screen.queryByTestId("why-recipient-adaptation")).toBeNull();

    cleanup();
    // A row persisted before this field existed reads as `undefined` — the same "nothing to say" as `false`, never an error.
    mount(<WhyPanel draft={draft()} />);
    expect(screen.queryByTestId("why-recipient-adaptation")).toBeNull();
  });

  it("with no api, shows the sources but offers no Remove — the same read-only reading as before #272", () => {
    mount(<WhyPanel draft={draft()} />);
    expect(screen.queryByTestId("source-remove")).toBeNull();
  });
});

/*
 * duo#272 (digital-duo#288): removing a bad rule or memory inline, from
 * inside Why?. A standing order rejects through the same
 * `/mirror/rules/:id/reject` the Rules tab's own Reject button calls; a
 * past exchange excludes through the daemon's new
 * `/knowledge/evidence/:recordId/exclude`. Either way the row stays —
 * this is a record of what the draft already used — and only its own
 * action settles into a confirmation; a failed call surfaces the daemon's
 * own message rather than pretending the remove went through.
 */
describe("WhyPanel — removing a bad source inline (duo#272)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers Remove beside the standing order and the evidence it drew on", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    mount(<WhyPanel api={api} draft={draft()} />);
    expect(screen.getAllByTestId("source-remove")).toHaveLength(2);
  });

  it("rejecting the standing order calls the Rules tab's own route and settles into a confirmation", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "r1" }), { status: 200 })));
    mount(<WhyPanel api={api} draft={draft()} />);
    const [removeRule] = screen.getAllByTestId("source-remove");
    fireEvent.click(removeRule!);
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://test/mirror/rules/r1/reject", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findAllByTestId("source-removed")).toHaveLength(1);
    // The rule's own label and link stay — this reads what the draft used, not what is still true of the rule.
    expect(screen.getByTestId("why-rule")).toHaveTextContent("Deploy access: point to the runbook");
  });

  it("excluding the evidence calls the daemon's new exclude route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ excluded: true }), { status: 200 })));
    mount(<WhyPanel api={api} draft={draft()} />);
    const [, removeEvidence] = screen.getAllByTestId("source-remove");
    fireEvent.click(removeEvidence!);
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://test/knowledge/evidence/e1/exclude", expect.objectContaining({ method: "POST" })),
    );
    expect(await screen.findAllByTestId("source-removed")).toHaveLength(1);
  });

  it("a refused removal leaves the source in place with the daemon's own error", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "conflict", message: "Already excluded by someone else." } }), { status: 409 })),
    );
    mount(<WhyPanel api={api} draft={draft()} />);
    const [removeRule] = screen.getAllByTestId("source-remove");
    fireEvent.click(removeRule!);
    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent("Already excluded by someone else."));
    expect(screen.queryByTestId("source-removed")).toBeNull();
  });

  it("an attachment source gets no Remove — it names no persisted rule or record", () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", { status: 200 })));
    mount(
      <WhyPanel
        api={api}
        draft={draft({ sources: [{ kind: "attachment", id: "mxc://w/file1", label: "attachment notes.txt (text/plain): a" }] })}
      />,
    );
    expect(screen.queryByTestId("source-remove")).toBeNull();
  });
});

describe("DraftTray's Why popover — removing a source without leaving the popover (duo#272)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("offers Remove inside the open popover, bound to this draft's own api", async () => {
    stubDesktop();
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ excluded: true }), { status: 200 })));
    mount(<DraftTray api={api} draft={draft()} />);
    fireEvent.click(screen.getByTestId("tray-why"));
    const popover = await screen.findByTestId("why-popover");
    const [, removeEvidence] = within(popover).getAllByTestId("source-remove");
    fireEvent.click(removeEvidence!);
    await waitFor(() =>
      expect(vi.mocked(fetch)).toHaveBeenCalledWith("http://test/knowledge/evidence/e1/exclude", expect.objectContaining({ method: "POST" })),
    );
    expect(await within(popover).findByTestId("source-removed")).toBeInTheDocument();
  });
});

describe("RoomInfo and DuoInfo — when nothing is waiting", () => {
  it("#247: one row per person — a duo whose owner isn't in the room reads in its own quiet 'Duos' group, never mixed in as a second member", () => {
    mount(<RoomInfo room={room()} />);
    expect(screen.getByTestId("room-info")).toHaveTextContent("project-x");
    // carol (the duo's owner) isn't a member of this room — carol's duo
    // belongs under "Duos", never beside Bose as if it were a colleague.
    const members = within(screen.getByTestId("room-info-members")).getAllByRole("listitem").map((li) => li.textContent);
    expect(members).toEqual(["Bose"]);
    const duos = within(screen.getByTestId("room-info-duos")).getAllByRole("listitem").map((li) => li.textContent);
    expect(duos).toEqual(["carol's duo"]);
    expect(screen.getByTestId("room-info").textContent).not.toContain("Not Carol");
    expect(screen.getByTestId("room-info-duo")).toHaveTextContent("Nothing is sent without you.");
  });

  it("#247: a duo whose owner IS in the room attaches to the owner's own row — a badge and 'Ask their duo', not a second row", async () => {
    const connection = { userId: "@ana:w", startDirect: vi.fn(async () => "!fresh:w") } as unknown as WorkspaceConnection;
    mount(
      <RoomInfo
        connection={connection}
        room={room({
          members: [
            { userId: "@carol:w", name: "Carol" },
            { userId: "@duo-carol:w", name: "duo-carol", ownerName: "Carol" },
          ],
        })}
      />,
    );
    const members = within(screen.getByTestId("room-info-members")).getAllByRole("listitem").map((li) => li.textContent);
    expect(members).toHaveLength(1);
    expect(members[0]).toContain("Carol");
    expect(members[0]).toContain("duo here");
    expect(screen.queryByTestId("room-info-duos-group")).toBeNull();

    fireEvent.click(screen.getByTestId("room-info-ask-their-duo"));
    await waitFor(() => expect(connection.startDirect).toHaveBeenCalledWith("@duo-carol:w"));
    await waitFor(() => expect(window.location.hash).toBe("#chat/!fresh%3Aw"));
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

/** A connection stub for #223's settings fields — only what RoomInfo's editing touches is real, and every write it could make is a spy. */
function fakeRoomConnection(over: Partial<WorkspaceConnection> = {}): WorkspaceConnection {
  return {
    userId: "@ana:w",
    setRoomName: vi.fn(async () => {}),
    setRoomTopic: vi.fn(async () => {}),
    setRoomAvatar: vi.fn(async () => {}),
    uploadFile: vi.fn(async (staged: StagedShare): Promise<SharedFile> => ({
      name: staged.name,
      mimeType: staged.mimeType,
      size: staged.size,
      url: "mxc://w/uploaded",
      image: staged.mimeType.startsWith("image/"),
    })),
    loadMedia: vi.fn(async () => null),
    ...over,
  } as unknown as WorkspaceConnection;
}

describe("a group conversation's name, topic and picture (#223)", () => {
  it("a direct conversation never shows the settings — a DM has no name of its own to give", () => {
    mount(<RoomInfo connection={fakeRoomConnection()} room={room({ kind: "direct", canEdit: { name: true, topic: true, avatar: true } })} />);
    expect(screen.queryByTestId("room-settings")).toBeNull();
  });

  it("a member without permission sees the name and topic, but no way to change them", () => {
    mount(
      <RoomInfo
        connection={fakeRoomConnection()}
        room={room({ topic: "refunds and billing", canEdit: { name: false, topic: false, avatar: false } })}
      />,
    );
    expect(screen.getByTestId("room-settings-name")).toHaveTextContent("project-x");
    expect(screen.queryByTestId("room-settings-name-edit")).toBeNull();
    expect(screen.getByTestId("room-settings-topic")).toHaveTextContent("refunds and billing");
    expect(screen.queryByTestId("room-settings-topic-edit")).toBeNull();
    // No picker for the picture either — only the current state (here, none) shows.
    expect(screen.getByTestId("room-picture-placeholder")).toBeInTheDocument();
    expect(screen.queryByTestId("room-picture-pick")).toBeNull();
  });

  it("a member with permission can rename the conversation, and the seam hears the new name", async () => {
    const connection = fakeRoomConnection();
    mount(<RoomInfo connection={connection} room={room({ canEdit: { name: true, topic: false, avatar: false } })} />);

    fireEvent.click(screen.getByTestId("room-settings-name-edit"));
    const input = screen.getByTestId("room-settings-name-input");
    fireEvent.change(input, { target: { value: "Project X" } });
    fireEvent.click(screen.getByTestId("room-settings-name-save"));

    await waitFor(() => expect(connection.setRoomName).toHaveBeenCalledWith("!p:w", "Project X"));
    // Saving closes the form back to the read display.
    await waitFor(() => expect(screen.queryByTestId("room-settings-name-input")).toBeNull());
  });

  it("can set a topic independently of the name — a blank room gets one for the first time", async () => {
    const connection = fakeRoomConnection();
    mount(<RoomInfo connection={connection} room={room({ topic: null, canEdit: { name: false, topic: true, avatar: false } })} />);

    expect(screen.getByTestId("room-settings-topic")).toHaveTextContent("No topic");
    fireEvent.click(screen.getByTestId("room-settings-topic-edit"));
    fireEvent.change(screen.getByTestId("room-settings-topic-input"), { target: { value: "refunds" } });
    fireEvent.click(screen.getByTestId("room-settings-topic-save"));

    await waitFor(() => expect(connection.setRoomTopic).toHaveBeenCalledWith("!p:w", "refunds"));
    // The name was never touched by a topic save.
    expect(connection.setRoomName).not.toHaveBeenCalled();
  });

  it("a cancel discards the draft without calling the seam", () => {
    const connection = fakeRoomConnection();
    mount(<RoomInfo connection={connection} room={room({ canEdit: { name: true, topic: false, avatar: false } })} />);

    fireEvent.click(screen.getByTestId("room-settings-name-edit"));
    fireEvent.change(screen.getByTestId("room-settings-name-input"), { target: { value: "something else" } });
    fireEvent.click(screen.getByTestId("room-settings-name-cancel"));

    expect(screen.queryByTestId("room-settings-name-input")).toBeNull();
    expect(screen.getByTestId("room-settings-name")).toHaveTextContent("project-x");
    expect(connection.setRoomName).not.toHaveBeenCalled();
  });

  it("a homeserver refusal shows in words at the field that was refused, not a generic error", async () => {
    const connection = fakeRoomConnection({ setRoomName: vi.fn(async () => { throw new Error("M_FORBIDDEN"); }) });
    mount(<RoomInfo connection={connection} room={room({ canEdit: { name: true, topic: false, avatar: false } })} />);

    fireEvent.click(screen.getByTestId("room-settings-name-edit"));
    fireEvent.change(screen.getByTestId("room-settings-name-input"), { target: { value: "Project X" } });
    fireEvent.click(screen.getByTestId("room-settings-name-save"));

    expect(await screen.findByTestId("room-settings-name-error")).toHaveTextContent("didn't take that");
    // The draft stays open on a refusal — nothing is thrown away.
    expect(screen.getByTestId("room-settings-name-input")).toBeInTheDocument();
  });

  it("a picture upload reuses the share path's own type and size rules before it ever uploads", async () => {
    const connection = fakeRoomConnection();
    mount(<RoomInfo connection={connection} room={room({ canEdit: { name: false, topic: false, avatar: true } })} />);

    const input = screen.getByTestId("room-picture-input") as HTMLInputElement;
    const tooBig = new File([new Uint8Array(9 * 1024 * 1024)], "huge.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [tooBig] } });

    expect(await screen.findByTestId("room-picture-error")).toHaveTextContent("8 MiB");
    expect(connection.uploadFile).not.toHaveBeenCalled();

    const notAnImage = new File([new Uint8Array([1])], "notes.txt", { type: "text/plain" });
    fireEvent.change(input, { target: { files: [notAnImage] } });
    expect(await screen.findByTestId("room-picture-error")).toHaveTextContent("must be an image");
    expect(connection.uploadFile).not.toHaveBeenCalled();
  });

  it("a member with permission can set the picture — staged, uploaded, then stated as the room's own", async () => {
    const connection = fakeRoomConnection();
    mount(<RoomInfo connection={connection} room={room({ canEdit: { name: false, topic: false, avatar: true } })} />);

    const input = screen.getByTestId("room-picture-input") as HTMLInputElement;
    const picture = new File([new Uint8Array([1, 2, 3])], "team.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [picture] } });

    await waitFor(() => expect(connection.uploadFile).toHaveBeenCalled());
    await waitFor(() => expect(connection.setRoomAvatar).toHaveBeenCalledWith("!p:w", "mxc://w/uploaded"));
  });
});

/**
 * Routes every call by path, the way `/workspace/rooms/:roomId/off-the-record`
 * tests need. Stateful like the real daemon: a POST/DELETE updates what the
 * next GET reads back, exactly as `markRoomOffTheRecord`/`clearRoomOffTheRecord`
 * do server-side — so a mutation's own invalidated refetch sees its effect.
 */
function offTheRecordFetch(initial: { roomId: string; offTheRecord: boolean; decidedAt: string | null }) {
  let state = initial;
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (!url.includes("/off-the-record")) {
      return new Response("[]", { status: 200 });
    }
    const method = init?.method ?? "GET";
    if (method === "POST") {
      state = { roomId: state.roomId, offTheRecord: true, decidedAt: state.decidedAt ?? "2026-10-07T00:00:00.000Z" };
      return new Response(JSON.stringify({ ...state, purged: { draftIds: [], standingOrderCandidatesRejected: 0, correctionCandidatesRejected: 0, rulesRejected: 0 } }), { status: 200 });
    }
    if (method === "DELETE") {
      const wasOn = state.offTheRecord;
      state = { roomId: state.roomId, offTheRecord: false, decidedAt: null };
      return new Response(JSON.stringify({ ...state, wasOn }), { status: 200 });
    }
    return new Response(JSON.stringify(state), { status: 200 });
  });
}

describe("duo#274: don't learn from this conversation — the room settings section", () => {
  it("renders nothing without a paired duo — the rest of Info is unaffected", () => {
    mount(<RoomInfo connection={fakeRoomConnection()} room={room()} />);
    expect(screen.queryByTestId("room-settings-off-the-record")).toBeNull();
  });

  it("a room never marked shows the off-the-record trigger, not the marker", async () => {
    vi.stubGlobal("fetch", offTheRecordFetch({ roomId: "!p:w", offTheRecord: false, decidedAt: null }));
    mount(<RoomInfo api={api} connection={fakeRoomConnection()} room={room()} />);

    expect(await screen.findByTestId("off-the-record-trigger")).toBeInTheDocument();
    expect(screen.queryByTestId("off-the-record-marker")).toBeNull();
  });

  it("a room already marked shows the persistent marker and a way to resume learning", async () => {
    vi.stubGlobal("fetch", offTheRecordFetch({ roomId: "!p:w", offTheRecord: true, decidedAt: "2026-10-07T00:00:00.000Z" }));
    mount(<RoomInfo api={api} connection={fakeRoomConnection()} room={room()} />);

    const marker = await screen.findByTestId("off-the-record-marker");
    expect(marker).toHaveTextContent("Off the record — your duo doesn't learn from this");
    expect(screen.queryByTestId("off-the-record-trigger")).toBeNull();
  });

  it("marking off the record is a two-step confirm, and the read settles to the marker afterwards", async () => {
    vi.stubGlobal("fetch", offTheRecordFetch({ roomId: "!p:w", offTheRecord: false, decidedAt: null }));
    mount(<RoomInfo api={api} connection={fakeRoomConnection()} room={room()} />);

    fireEvent.click(await screen.findByTestId("off-the-record-trigger"));
    const confirmation = await screen.findByTestId("off-the-record-confirmation");
    expect(within(confirmation).getByText(/can't be brought back/)).toBeInTheDocument();

    fireEvent.click(within(confirmation).getByTestId("off-the-record-confirm"));
    expect(await screen.findByTestId("off-the-record-marker")).toHaveTextContent("Off the record");
  });

  it("Cancel leaves the room exactly as it was — nothing is marked", async () => {
    vi.stubGlobal("fetch", offTheRecordFetch({ roomId: "!p:w", offTheRecord: false, decidedAt: null }));
    mount(<RoomInfo api={api} connection={fakeRoomConnection()} room={room()} />);

    fireEvent.click(await screen.findByTestId("off-the-record-trigger"));
    const confirmation = await screen.findByTestId("off-the-record-confirmation");
    fireEvent.click(within(confirmation).getByTestId("off-the-record-cancel"));

    await waitFor(() => expect(screen.queryByTestId("off-the-record-confirmation")).toBeNull());
    expect(screen.getByTestId("off-the-record-trigger")).toBeInTheDocument();
  });

  it("resuming learning lifts the marker without a confirm step", async () => {
    vi.stubGlobal("fetch", offTheRecordFetch({ roomId: "!p:w", offTheRecord: true, decidedAt: "2026-10-07T00:00:00.000Z" }));
    mount(<RoomInfo api={api} connection={fakeRoomConnection()} room={room()} />);

    fireEvent.click(await screen.findByTestId("off-the-record-clear"));
    await screen.findByTestId("off-the-record-trigger");
    expect(screen.queryByTestId("off-the-record-marker")).toBeNull();
  });

  it("also shows for a direct conversation — off the record applies to any room, not only groups", async () => {
    vi.stubGlobal("fetch", offTheRecordFetch({ roomId: "!dm:w", offTheRecord: false, decidedAt: null }));
    mount(<RoomInfo api={api} connection={fakeRoomConnection()} room={room({ roomId: "!dm:w", kind: "direct", name: null })} />);
    expect(await screen.findByTestId("off-the-record-trigger")).toBeInTheDocument();
  });
});

describe("Why? beside the draft — only when asked (#185)", () => {
  it("on a desktop opens a popover next to the draft; Escape closes it and gives focus back", async () => {
    stubDesktop();
    mount(<DraftTray api={api} draft={draft()} />);
    expect(screen.queryByTestId("why-panel")).toBeNull();
    const button = screen.getByTestId("tray-why");
    fireEvent.click(button);
    const popover = await screen.findByTestId("why-popover");
    expect(popover).toHaveAttribute("role", "dialog");
    expect(within(popover).getByTestId("why-rule")).toBeInTheDocument();
    expect(screen.queryByTestId("why-sheet")).toBeNull();
    act(() => void fireEvent.keyDown(window, { key: "Escape" }));
    await waitFor(() => expect(screen.queryByTestId("why-popover")).toBeNull());
    expect(document.activeElement).toBe(button);
  });

  it("is placed against the window, not inside the transcript's scroll, so it is never clipped", async () => {
    stubDesktop();
    mount(<DraftTray api={api} draft={draft()} />);
    fireEvent.click(screen.getByTestId("tray-why"));
    const popover = await screen.findByTestId("why-popover");
    expect(popover.style.position).toBe("fixed");
    expect(Number.parseFloat(popover.style.left)).toBeGreaterThanOrEqual(8);
  });

  it("a click elsewhere closes the popover", async () => {
    stubDesktop();
    mount(<DraftTray api={api} draft={draft()} />);
    fireEvent.click(screen.getByTestId("tray-why"));
    await screen.findByTestId("why-popover");
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByTestId("why-popover")).toBeNull());
  });

  it("on a phone opens the same panel as a bottom sheet, and closes it", async () => {
    stubPhone();
    mount(<DraftTray api={api} draft={draft()} />);
    fireEvent.click(screen.getByTestId("tray-why"));
    const sheet = await screen.findByTestId("why-sheet");
    expect(within(sheet).getByTestId("why-panel")).toBeInTheDocument();
    expect(within(sheet).getByTestId("why-rule")).toBeInTheDocument();
    fireEvent.click(within(sheet).getByTestId("why-close"));
    await waitFor(() => expect(screen.queryByTestId("why-sheet")).toBeNull());
  });

  it("the one-line why stays on the draft itself", () => {
    mount(<DraftTray api={api} draft={draft()} />);
    expect(screen.getByTestId("draft-tray-why")).toHaveTextContent("Standing order: Deploy access");
  });
});

describe("the Info panel in the shell (#184)", () => {
  function shell(drafts: DraftRecord[]) {
    localStorage.setItem("duo.api-config", JSON.stringify(api));
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => new Response(JSON.stringify(String(input).includes("/drafts") ? drafts : []), { status: 200 })),
    );
  }

  it("is closed by default, even with a draft waiting — nothing opens on the right by itself", async () => {
    stubDesktop();
    shell([draft({ provenance: { origin: "owner" } })]);
    window.location.hash = "#duo";
    render(<App />);
    await screen.findByTestId("draft-tray");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.getByTestId("info-toggle")).toHaveAttribute("aria-pressed", "false");
  });

  it("opens from the chat header and shows Your duo's way into its profile; closes again", async () => {
    stubDesktop();
    shell([]);
    window.location.hash = "#duo";
    render(<App />);
    fireEvent.click(await screen.findByTestId("info-toggle"));
    const panel = await screen.findByTestId("inspector");
    expect(panel).toHaveAttribute("aria-label", "Info");
    expect(within(panel).getByTestId("duo-info")).toBeInTheDocument();
    expect(localStorage.getItem("duo.inspector")).toBe("open");
    fireEvent.click(screen.getByTestId("info-toggle"));
    await waitFor(() => expect(screen.queryByTestId("inspector")).toBeNull());
    expect(localStorage.getItem("duo.inspector")).toBe("closed");
  });

  it("⌘I opens and closes it, and the choice is remembered on this device", async () => {
    stubDesktop();
    shell([]);
    window.location.hash = "#duo";
    const view = render(<App />);
    await screen.findByTestId("info-toggle");
    act(() => void fireEvent.keyDown(window, { key: "i", metaKey: true }));
    expect(await screen.findByTestId("inspector")).toBeInTheDocument();
    view.unmount();

    render(<App />); // a fresh launch: still open
    expect(await screen.findByTestId("inspector")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("inspector-hide"));
    await waitFor(() => expect(screen.queryByTestId("inspector")).toBeNull());
  });

  it("has nothing to show on the list, so no button and no panel", async () => {
    stubDesktop();
    shell([]);
    localStorage.setItem("duo.inspector", "open");
    window.location.hash = "#chats";
    render(<App />);
    await screen.findByTestId("chat-list");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.queryByTestId("info-toggle")).toBeNull();
  });

  it("is not on a phone: there is no room for it, so no button", async () => {
    stubPhone();
    shell([draft({ provenance: { origin: "owner" } })]);
    window.location.hash = "#duo";
    render(<App />);
    await screen.findByTestId("draft-tray");
    expect(screen.queryByTestId("inspector")).toBeNull();
    expect(screen.queryByTestId("info-toggle")).toBeNull();
    expect(screen.getByTestId("tray-why")).toBeInTheDocument();
  });
});
