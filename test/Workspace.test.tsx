import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connect, signIn } from "../src/workspace/matrix.js";
import type { RoomMessage, RoomSummary, WorkspaceConnection, WorkspaceSession } from "../src/workspace/matrix.js";

/*
 * #62: the app's front door becomes two doors — a workspace sign-in (who you
 * are, in an org) and a duo pairing (which only you reach) — with separate
 * lifetimes. The Matrix seam (`src/workspace/matrix.ts`) is the one module
 * that would load matrix-js-sdk; it is mocked here wholesale, the same way
 * the Tauri seams are, so the ACs test the client's surfaces against the
 * wire contract the core's identity/directory work (digital-duo #187)
 * fixed: the person signs in as their own Matrix user, and a duo is its own
 * user (`@duo-<owner>`) the client recognizes structurally.
 */
vi.mock("../src/workspace/matrix.js", () => ({
  signIn: vi.fn(),
  connect: vi.fn(),
}));

const SESSION: WorkspaceSession = {
  homeserverUrl: "https://workspace.example",
  userId: "@ana:workspace.example",
  accessToken: "syt_workspace_token",
  deviceId: "YGBNAUIOMK",
};

const ROOMS: RoomSummary[] = [
  { roomId: "!project-x:workspace.example", name: "project-x" },
  { roomId: "!direct:workspace.example", name: "Bose" },
];

function messageFor(over: Partial<RoomMessage> & Pick<RoomMessage, "eventId" | "senderId" | "body">): RoomMessage {
  return { roomId: "!project-x:workspace.example", senderName: "", originServerTs: 1_700_000_000_000, ...over };
}

const PROJECT_TIMELINE: RoomMessage[] = [
  messageFor({ eventId: "$1", senderId: "@bose:workspace.example", senderName: "Bose", body: "what's our refund policy?" }),
  messageFor({ eventId: "$2", senderId: "@duo-carol:workspace.example", senderName: "duo-carol", body: "Refunds within 30 days, full amount." }),
];

/** A fake connection the ACs drive: rooms and timelines resolve from `state`, `deliver` plays a live arrival into the open subscription. */
function fakeConnection(state: { rooms: RoomSummary[]; timelines: Record<string, RoomMessage[]> }) {
  let listener: ((roomId: string) => void) | null = null;
  const connection: WorkspaceConnection = {
    rooms: vi.fn(async () => state.rooms),
    timeline: vi.fn(async (roomId: string) => state.timelines[roomId] ?? []),
    send: vi.fn(async () => {}),
    subscribe: vi.fn((handler: (roomId: string) => void) => {
      listener = handler;
      return () => {
        listener = null;
      };
    }),
    stop: vi.fn(async () => {}),
  };
  return {
    connection,
    deliver: (message: RoomMessage) => {
      (state.timelines[message.roomId] ??= []).push(message);
      listener?.(message.roomId);
    },
  };
}

/** Fresh module registry per render: the app's module-level QueryClient must not carry cache across tests. */
async function renderApp() {
  vi.resetModules();
  const { App } = await import("../src/App.js");
  return render(<App />);
}

function seedSession() {
  localStorage.setItem("duo.workspace-session", JSON.stringify(SESSION));
}

function seedPairing() {
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
}

/** Daemon answers for the queries a paired shell runs (roster, pending drafts): empty and successful. */
function stubDaemonFetch() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })),
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.mocked(signIn).mockReset();
  vi.mocked(connect).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("#62 AC1 — signing in to the workspace works", () => {
  it("the front door offers the workspace sign-in, with duo pairing still there beside it", async () => {
    await renderApp();

    expect(screen.getByRole("heading", { name: "Sign in to your workspace" })).toBeInTheDocument();
    // The pairing path keeps its own fields — a reasonable front door for one
    // person pairing their phone, still one form away.
    expect(screen.getByPlaceholderText("100.64.1.5:7717")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /token/i })).toBeInTheDocument();
  });

  it("signing in reaches conversations, with no duo pairing having happened", async () => {
    vi.mocked(signIn).mockResolvedValue(SESSION);
    const fake = fakeConnection({ rooms: ROOMS, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.change(screen.getByLabelText("Homeserver"), { target: { value: "https://workspace.example/" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ana" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    expect(screen.getByText("project-x")).toBeInTheDocument();
    expect(screen.getByText("Bose")).toBeInTheDocument();
    expect(signIn).toHaveBeenCalledWith("https://workspace.example", "ana", "correct horse");
    // No pairing happened: the duo credential store is untouched.
    expect(localStorage.getItem("duo.api-config")).toBeNull();
  });

  it("rejected credentials stay on the door, saying the homeserver refused them", async () => {
    vi.mocked(signIn).mockRejectedValue(new Error("The workspace refused these sign-in details."));

    await renderApp();
    fireEvent.change(screen.getByLabelText("Homeserver"), { target: { value: "https://workspace.example" } });
    fireEvent.change(screen.getByLabelText("Username"), { target: { value: "ana" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByTestId("setup-workspace-error")).toHaveTextContent("The workspace refused these sign-in details.");
    expect(screen.queryByTestId("conversations-list")).toBeNull();
    expect(localStorage.getItem("duo.workspace-session")).toBeNull();
  });
});

describe("#62 AC2 — pairing a duo is a separate, later step", () => {
  it("an unpaired member lands on Conversations, reads a room, and a colleague's duo is labelled structurally", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: ROOMS, timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    // The empty hash is Conversations for a signed-in member — the default
    // space, not a duo surface demanding pairing.
    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    fireEvent.click(screen.getByText("project-x"));

    expect(await screen.findByTestId("room-timeline")).toBeInTheDocument();
    expect(screen.getByTestId("room-person-message-author")).toHaveTextContent("Bose");
    // The duo's message carries whose it is from the structural id
    // (`@duo-carol` → carol), never from a display name the sender chose.
    expect(screen.getByTestId("room-duo-message-attribution")).toHaveTextContent("carol's duo");
  });

  it("messaging works fully: sending posts through the connection, and a live arrival renders", async () => {
    seedSession();
    const state = { rooms: ROOMS, timelines: { "!project-x:workspace.example": [...PROJECT_TIMELINE] } };
    const fake = fakeConnection(state);
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    fireEvent.click(await screen.findByText("project-x"));
    await screen.findByTestId("room-timeline");

    fireEvent.change(screen.getByLabelText("Message project-x"), { target: { value: "thanks all" } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));

    await waitFor(() => expect(fake.connection.send).toHaveBeenCalledWith("!project-x:workspace.example", "thanks all"));
    // The composer clears on a successful send — the room is the record.
    await waitFor(() => expect(screen.getByLabelText("Message project-x")).toHaveValue(""));

    // A live arrival (someone else's message, or ours echoed back by the
    // homeserver) renders without a manual refresh.
    const reply = messageFor({ eventId: "$3", senderId: "@carol:workspace.example", senderName: "Carol", body: "np" });
    act(() => fake.deliver(reply));
    await waitFor(() => expect(screen.getByText("np")).toBeInTheDocument());
  });

  it("duo surfaces explain that no duo is connected, and pairing is offered rather than demanded", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: ROOMS, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");

    // A duo surface, navigated directly: the explanation, and the offer.
    window.location.hash = "#review";
    window.dispatchEvent(new Event("hashchange"));
    const noDuo = await screen.findByTestId("no-duo");
    expect(noDuo).toHaveTextContent("No duo is connected on this device.");
    expect(screen.getByTestId("no-duo-pair")).toHaveTextContent("Pair your duo");
    // Offered, not demanded: nothing modal is in the way.
    expect(screen.queryByTestId("pair-duo-dialog")).toBeNull();
  });

  it("pairing from the offer pairs the duo, and the member shell gains its duo surfaces", async () => {
    seedSession();
    const fake = fakeConnection({ rooms: ROOMS, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    stubDaemonFetch();

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#review";
    window.dispatchEvent(new Event("hashchange"));
    fireEvent.click(await screen.findByTestId("no-duo-pair"));

    fireEvent.change(await screen.findByLabelText("Daemon address"), { target: { value: "100.64.1.5:7717" } });
    fireEvent.change(screen.getByRole("textbox", { name: /token/i }), { target: { value: "tok" } });
    fireEvent.click(screen.getByRole("button", { name: "Connect" }));

    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
    // The dialog closes behind the pairing, and the duo's own surface takes over.
    await waitFor(() => expect(screen.queryByTestId("pair-duo-dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("link", { name: /Review/ })).toBeInTheDocument());
    expect(screen.queryByTestId("no-duo")).toBeNull();
  });
});

describe("#62 AC3 — both credentials are managed", () => {
  it("settings shows both connections, and signing out ends only the workspace one", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: ROOMS, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));

    const workspace = await screen.findByTestId("settings-workspace");
    expect(workspace).toHaveTextContent("@ana:workspace.example");
    expect(workspace).toHaveTextContent("https://workspace.example");
    // The duo connection is shown beside it, in effect.
    expect(screen.getByTestId("settings-address")).toHaveTextContent("http://100.64.1.5:7717");

    fireEvent.click(screen.getByTestId("settings-sign-out"));

    await waitFor(() => expect(localStorage.getItem("duo.workspace-session")).toBeNull());
    // The pairing survives: the two connections end independently.
    await waitFor(() => expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" }));
    // Still the owner's shell — the duo surfaces stand without the workspace.
    await waitFor(() => expect(screen.getByRole("link", { name: /Review/ })).toBeInTheDocument());
  });

  it("forgetting the duo keeps the workspace session, and the member shell stands", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: ROOMS, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));
    fireEvent.click((await screen.findAllByTestId("settings-unpair"))[0]);
    fireEvent.click(screen.getByTestId("settings-unpair-confirm"));

    await waitFor(() => expect(localStorage.getItem("duo.api-config")).toBeNull());
    expect(JSON.parse(localStorage.getItem("duo.workspace-session") ?? "null")).toEqual(SESSION);
    // Conversations is still the member's default space.
    await waitFor(() => expect(screen.getByTestId("conversations-list")).toBeInTheDocument());
  });
});

describe("#62 AC4 — signing out leaves nothing behind", () => {
  it("clears cached messages and cached duo data, while the pairing itself survives", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: ROOMS, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);
    // A persisted cache blob from before: what signing out must not leave readable.
    localStorage.setItem("duo-cache", JSON.stringify({ clientState: {}, buster: "delivery" }));

    await renderApp();
    await screen.findByTestId("conversations-list");
    window.location.hash = "#settings";
    window.dispatchEvent(new Event("hashchange"));
    fireEvent.click(await screen.findByTestId("settings-sign-out"));

    await waitFor(() => {
      expect(localStorage.getItem("duo-cache")).toBeNull();
      expect(localStorage.getItem("duo.workspace-session")).toBeNull();
    });
    expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toEqual({ baseUrl: "http://100.64.1.5:7717", token: "tok" });
  });
});

describe("#62 — the both-credentials shell and the failing-connection edge", () => {
  it("a paired member signed in opens on Conversations, with Review still above it", async () => {
    seedSession();
    seedPairing();
    stubDaemonFetch();
    const fake = fakeConnection({ rooms: ROOMS, timelines: {} });
    vi.mocked(connect).mockResolvedValue(fake.connection);

    await renderApp();

    // Conversations is the default space; Review — the thing the app exists
    // to open — keeps its place above it in the sidebar.
    expect(await screen.findByTestId("conversations-list")).toBeInTheDocument();
    const entries = [...screen.getByRole("navigation").querySelectorAll("a")].map((a) => a.textContent);
    expect(entries.indexOf("Conversations")).toBeGreaterThan(-1);
    expect(entries.indexOf("Review")).toBeLessThan(entries.indexOf("Conversations"));
  });

  it("a connection that cannot be established says so and offers the way out", async () => {
    seedSession();
    vi.mocked(connect).mockRejectedValue(new Error("The workspace didn't answer."));

    await renderApp();

    const failure = await screen.findByTestId("workspace-error");
    expect(failure).toHaveTextContent("The workspace didn't answer.");
    fireEvent.click(screen.getByTestId("workspace-error-sign-out"));
    await waitFor(() => expect(localStorage.getItem("duo.workspace-session")).toBeNull());
  });
});
