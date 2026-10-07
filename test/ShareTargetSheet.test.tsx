import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { ShareTargetSheet } from "../src/routes/ShareTargetSheet.js";
import type { RoomSummary, WorkspaceConnection } from "../src/workspace/matrix.js";

/*
 * #324: the picker a share lands on. `readPendingShare`/`stashShareForRoom`
 * (`src/shareTarget.ts`) and `writeComposerBuffer` (`src/composerBuffer.ts`)
 * are mocked here — their own real behaviour (the IndexedDB round trip, the
 * buffer) is `test/shareTarget.test.ts`'s and `test/Composer.test.tsx`'s
 * job; this only checks what the picker itself does with what they hand it.
 */

const shareTargetMock = vi.hoisted(() => ({
  pending: null as null | { title: string; text: string; url: string; files: { name: string; type: string; blob: Blob }[] },
  stashed: new Map<string, { text: string; files: readonly File[] }>(),
}));
vi.mock("../src/shareTarget.js", () => ({
  readPendingShare: vi.fn(async () => shareTargetMock.pending),
  stashShareForRoom: vi.fn((roomId: string, share: { text: string; files: readonly File[] }) => {
    shareTargetMock.stashed.set(roomId, share);
  }),
  takeShareForRoom: vi.fn(() => null),
}));

const composerBufferMock = vi.hoisted(() => ({ buffer: "" }));
vi.mock("../src/composerBuffer.js", () => ({
  writeComposerBuffer: vi.fn((text: string) => {
    composerBufferMock.buffer = text;
  }),
  readComposerBuffer: vi.fn(() => composerBufferMock.buffer),
}));

const api: DuoApiConfig = { baseUrl: "http://d:7717", token: "t" };

function room(roomId: string, name: string): RoomSummary {
  return {
    roomId,
    kind: "direct",
    name,
    topic: null,
    avatarUrl: null,
    members: [{ userId: `@${name.toLowerCase()}:w`, name }],
    latest: null,
    unread: { notifications: 0, mentions: 0 },
    muted: false,
    notifications: "all",
    canEdit: { name: false, topic: false, avatar: false, pins: false },
  };
}

function connectionWith(rooms: RoomSummary[]): WorkspaceConnection {
  return {
    findRooms: async (query: string) => {
      const needle = query.trim().toLowerCase();
      return needle === "" ? rooms : rooms.filter((r) => (r.name ?? "").toLowerCase().includes(needle));
    },
  } as unknown as WorkspaceConnection;
}

beforeEach(() => {
  window.location.hash = "";
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  shareTargetMock.pending = null;
  shareTargetMock.stashed.clear();
  composerBufferMock.buffer = "";
  window.location.hash = "";
});

describe("#324 — the share picker", () => {
  it("nothing pending says so, with a way back to Chats", async () => {
    render(<ShareTargetSheet api={null} connection={null} />);
    expect(await screen.findByTestId("share-target-empty")).toBeInTheDocument();
    expect(screen.getByTestId("share-target-cancel")).toHaveAttribute("href", "#chats");
  });

  it("shows the shared title, text and offers Your duo when there are no files", async () => {
    shareTargetMock.pending = { title: "A page", text: "look at this", url: "https://example.com/a", files: [] };
    render(<ShareTargetSheet api={api} connection={null} />);
    const preview = await screen.findByTestId("share-target-preview");
    expect(preview).toHaveTextContent("A page");
    expect(preview).toHaveTextContent("look at this");
    expect(screen.queryByTestId("share-target-file-count")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-target-duo")).toBeInTheDocument();
  });

  it("picking Your duo writes the shared text and the link to the composer buffer, and opens Your duo", async () => {
    shareTargetMock.pending = { title: "", text: "look at this", url: "https://example.com/a", files: [] };
    render(<ShareTargetSheet api={api} connection={null} />);
    fireEvent.click(await screen.findByTestId("share-target-duo"));

    expect(composerBufferMock.buffer).toBe("look at this\nhttps://example.com/a");
    expect(window.location.hash).toBe("#duo");
  });

  it("with no paired duo, Your duo isn't offered at all", async () => {
    shareTargetMock.pending = { title: "", text: "hello", url: "", files: [] };
    render(<ShareTargetSheet api={null} connection={null} />);
    await screen.findByTestId("share-target-preview");
    expect(screen.queryByTestId("share-target-duo")).not.toBeInTheDocument();
    expect(screen.getByTestId("share-target-no-destination")).toBeInTheDocument();
  });

  it("a file hides Your duo — there's nowhere there to upload it (AC3 only ever rides into a conversation)", async () => {
    shareTargetMock.pending = { title: "", text: "", url: "", files: [{ name: "a.png", type: "image/png", blob: new Blob() }] };
    render(<ShareTargetSheet api={api} connection={null} />);
    const preview = await screen.findByTestId("share-target-preview");
    expect(preview).toHaveTextContent("1 file");
    expect(screen.queryByTestId("share-target-duo")).not.toBeInTheDocument();
  });

  it("searches and picks a conversation, stashing the share for that room and opening it", async () => {
    shareTargetMock.pending = { title: "", text: "shared text", url: "", files: [] };
    const connection = connectionWith([room("!a:w", "Alpha"), room("!b:w", "Beta")]);
    render(<ShareTargetSheet api={null} connection={connection} />);

    await waitFor(() => expect(screen.getAllByTestId("share-target-room")).toHaveLength(2));
    fireEvent.change(screen.getByTestId("share-target-search"), { target: { value: "Beta" } });
    await waitFor(() => expect(screen.getAllByTestId("share-target-room")).toHaveLength(1));

    fireEvent.click(screen.getByTestId("share-target-room"));

    expect(shareTargetMock.stashed.get("!b:w")).toEqual({ text: "shared text", files: [] });
    expect(window.location.hash).toBe("#chat/!b%3Aw");
  });

  it("a shared file rides into the room's own stash as a real File, by name and type", async () => {
    shareTargetMock.pending = { title: "", text: "", url: "", files: [{ name: "note.txt", type: "text/plain", blob: new Blob(["hi"]) }] };
    const connection = connectionWith([room("!a:w", "Alpha")]);
    render(<ShareTargetSheet api={null} connection={connection} />);

    fireEvent.click(await screen.findByTestId("share-target-room"));

    const stashed = shareTargetMock.stashed.get("!a:w");
    expect(stashed?.files).toHaveLength(1);
    expect(stashed?.files[0]).toBeInstanceOf(File);
    expect(stashed?.files[0]?.name).toBe("note.txt");
    expect(stashed?.files[0]?.type).toBe("text/plain");
  });

  it("no conversations found says so, distinctly from loading", async () => {
    shareTargetMock.pending = { title: "", text: "x", url: "", files: [] };
    render(<ShareTargetSheet api={null} connection={connectionWith([])} />);
    expect(await screen.findByTestId("share-target-none")).toBeInTheDocument();
  });
});
