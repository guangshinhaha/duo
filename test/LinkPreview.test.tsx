import { configure, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { connect } from "../src/workspace/matrix.js";
import type { RoomMessage, RoomSummary, UrlPreview, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";
import { Settings } from "../src/routes/Settings.js";
import { readUrlPreviewPref, URL_PREVIEW_STORAGE_KEY } from "../src/urlPreviewPrefs.js";
import type { DuoApiConfig } from "../src/api/client.js";

/*
 * #219: a message with a link shows a preview card — title, description and
 * image — ONLY when the viewing member opted in; off by default, because
 * building that card means the homeserver itself fetches the linked page
 * server-side (every link anyone posts becomes a request the org's
 * infrastructure makes, timed to the message). This is the open policy
 * question the issue names: whether to default this on is a human's call,
 * not this client's, so it stays off until a member turns it on — one
 * member, one device, Settings' own toggle, never a room or org-wide switch.
 */
vi.mock("../src/workspace/matrix.js", () => ({
  signIn: vi.fn(),
  connect: vi.fn(),
}));

const SESSION: WorkspaceSession = {
  homeserverUrl: "https://workspace.example",
  userId: "@bose:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

let ROOM_ID = "!project-x-0:workspace.example";
let roomSequence = 0;

function rooms(): RoomSummary[] {
  return [
    {
      roomId: ROOM_ID,
      kind: "group",
      name: "project-x",
      members: [{ userId: "@carol:workspace.example", name: "Carol" }],
      latest: null,
      unread: { notifications: 0, mentions: 0 },
      muted: false,
      notifications: "all",
    },
  ];
}

function message(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId" | "body">): RoomMessage {
  return {
    roomId: ROOM_ID,
    senderName: "Bose",
    originServerTs: 1_700_000_000_000,
    edited: false,
    redacted: false,
    reactions: [],
    thread: null,
    threadRootEventId: null,
    parts: null,
    ...over,
  };
}

/** A minimal held connection: a timeline, and a configurable link-preview and media answer. */
function fakeConnection(
  timeline: RoomMessage[],
  options: { preview?: UrlPreview | null; image?: Blob | null } = {},
) {
  const connection: WorkspaceConnection = {
    userId: SESSION.userId,
    rooms: vi.fn(async () => rooms().map((room) => ({ ...room }))),
    timeline: vi.fn(async () => [...timeline]),
    timelineAt: vi.fn(async () => [...timeline]),
    searchMessages: vi.fn(async () => ({ hits: [], next: null })),
    send: vi.fn(async () => {}),
    edit: vi.fn(async () => {}),
    delete: vi.fn(async () => {}),
    react: vi.fn(async () => {}),
    unreact: vi.fn(async () => {}),
    replyInThread: vi.fn(async () => {}),
    markRead: vi.fn(async () => {}),
    startDirect: vi.fn(async () => "!x:workspace.example"),
    leave: vi.fn(async () => {}),
    setNotificationMode: vi.fn(async () => {}),
    uploadFile: vi.fn(async () => {
      throw new Error("not used here");
    }),
    sendFile: vi.fn(async () => {}),
    loadMedia: vi.fn(async () => options.image ?? null),
    getUrlPreview: vi.fn(async () => options.preview ?? null),
    searchPeople: vi.fn(async () => []),
    subscribe: vi.fn(() => () => {}),
    stop: vi.fn(async () => {}),
  };
  return connection;
}

async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

function navigate(hash: string): void {
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
}

async function openRoom(timeline: RoomMessage[], options: { preview?: UrlPreview | null; image?: Blob | null } = {}) {
  localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
  const connection = fakeConnection(timeline, options);
  vi.mocked(connect).mockResolvedValue(connection);
  await renderApp();
  await screen.findByTestId("conversations-list");
  navigate(`#chat/${encodeURIComponent(ROOM_ID)}`);
  await screen.findByTestId("room-timeline");
  return connection;
}

async function messageRow(fragment: string): Promise<HTMLElement> {
  return waitFor(() => {
    const row = screen.getAllByTestId("room-message").find((candidate) => candidate.textContent?.includes(fragment));
    expect(row, `no message row containing ${JSON.stringify(fragment)}`).toBeDefined();
    return row!;
  });
}

beforeAll(async () => {
  configure({ asyncUtilTimeout: 8_000 });
  await import("../src/App.js");
}, 60_000);

beforeEach(() => {
  roomSequence += 1;
  ROOM_ID = `!project-x-${roomSequence}:workspace.example`;
  localStorage.clear();
  vi.mocked(connect).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

vi.setConfig({ testTimeout: 30_000 });

describe("#219 — off by default", () => {
  it("shows no preview card for a link when the member never opted in — and never even asks the homeserver for one", async () => {
    const connection = await openRoom([message({ eventId: "$1", body: "take a look: https://example.com/page" })]);
    const row = await messageRow("take a look");
    expect(within(row).queryByTestId("link-preview-card")).toBeNull();
    // The point of OFF: this client doesn't even ask — the homeserver fetch
    // the issue flags as the privacy cost never happens for an opted-out member.
    expect(connection.getUrlPreview).not.toHaveBeenCalled();
  });

  it("a fresh profile reads the setting as off", () => {
    expect(readUrlPreviewPref()).toBe(false);
    expect(localStorage.getItem(URL_PREVIEW_STORAGE_KEY)).toBeNull();
  });
});

describe("#219 — opted in", () => {
  beforeEach(() => {
    localStorage.setItem(URL_PREVIEW_STORAGE_KEY, "on");
  });

  it("shows a card with title, description and image when the homeserver returns one", async () => {
    await openRoom(
      [message({ eventId: "$1", body: "take a look: https://example.com/page" })],
      {
        preview: { title: "Example Domain", description: "An example page.", image: "mxc://workspace.example/preview1" },
        image: new Blob(["bytes"], { type: "image/png" }),
      },
    );
    const row = await messageRow("take a look");
    const card = await waitFor(() => within(row).getByTestId("link-preview-card"));
    expect(card).toHaveAttribute("href", "https://example.com/page");
    expect(within(card).getByTestId("link-preview-title")).toHaveTextContent("Example Domain");
    expect(within(card).getByTestId("link-preview-description")).toHaveTextContent("An example page.");
    await waitFor(() => expect(within(card).getByTestId("link-preview-image")).toBeInTheDocument());
  });

  it("shows no card and no error when the homeserver has no metadata for the link", async () => {
    const connection = await openRoom(
      [message({ eventId: "$1", body: "dead link: https://example.com/nothing" })],
      { preview: null },
    );
    const row = await messageRow("dead link");
    await waitFor(() => expect(connection.getUrlPreview).toHaveBeenCalledWith("https://example.com/nothing"));
    expect(within(row).queryByTestId("link-preview-card")).toBeNull();
    expect(within(row).queryByRole("alert")).toBeNull();
    expect(within(row).queryByText(/error|failed|couldn't/i)).toBeNull();
  });

  it("renders no card for a message with no link at all", async () => {
    await openRoom([message({ eventId: "$1", body: "no link in this one" })]);
    const row = await messageRow("no link in this one");
    expect(within(row).queryByTestId("link-preview-card")).toBeNull();
  });
});

describe("#219 — the Settings toggle", () => {
  const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

  function renderSettings() {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <Settings api={api} session={null} onConfigChange={() => {}} onSignOut={() => {}} onPairDuo={() => {}} onWorkspaceSignIn={() => {}} />
      </QueryClientProvider>,
    );
  }

  it("reads off by default, and the member's own click turns it on and remembers the choice", () => {
    renderSettings();
    const toggle = screen.getByTestId("settings-link-previews-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("Turn on link previews");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Turn off link previews");
    expect(readUrlPreviewPref()).toBe(true);
    expect(localStorage.getItem(URL_PREVIEW_STORAGE_KEY)).toBe("on");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(readUrlPreviewPref()).toBe(false);
  });

  it("the setting persists across a remount — the member's choice, not this render's", () => {
    localStorage.setItem(URL_PREVIEW_STORAGE_KEY, "on");
    const first = renderSettings();
    expect(screen.getByTestId("settings-link-previews-toggle")).toHaveAttribute("aria-pressed", "true");
    first.unmount();
    renderSettings();
    expect(screen.getByTestId("settings-link-previews-toggle")).toHaveAttribute("aria-pressed", "true");
  });
});
