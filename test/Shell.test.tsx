// @ts-expect-error no node types by design
import { createHash } from "node:crypto";
// @ts-expect-error no node types by design
import { readFileSync } from "node:fs";
// @ts-expect-error no node types by design
import { fileURLToPath } from "node:url";
// @ts-expect-error no node types by design
import { dirname, join } from "node:path";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import type { DraftRecord } from "../src/api/types.js";

/*
 * #42: make the Mac build an application, not a binary. The halves this
 * file pins are the client's — the seams that carry the pending count to
 * the menu bar, the tray's one-click Review, the notification click that
 * reveals the window on the draft — plus the config-and-record contracts
 * (own icon, bundled targets, the signing decision record) that make the
 * build an app. The Rust halves are exercised by `cargo check` and by
 * running the shell; what they must not do is regress the client's
 * contracts, which is what these tests hold.
 */

const shell = vi.hoisted(() => ({
  invoke: vi.fn(async () => {}),
  listen: vi.fn<(event: string, handler: () => void) => Promise<() => void>>(async () => () => {}),
  show: vi.fn(async () => {}),
  setBadgeCount: vi.fn(async () => {}),
  windowThrows: false,
}));

vi.mock("@tauri-apps/api/core", () => ({ invoke: shell.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: shell.listen }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => {
    if (shell.windowThrows) {
      throw new Error("window.__TAURI_INTERNALS__ is undefined");
    }
    return { show: shell.show, setBadgeCount: shell.setBadgeCount };
  },
}));

type SentNotification = { id?: number; title: string; body: string };
type ActionCallback = (notification: { id?: number }) => void;
const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => true),
  requestPermission: vi.fn(async () => "granted"),
  sendNotification: vi.fn<(options: SentNotification) => void>(),
  onAction: vi.fn<(cb: ActionCallback) => Promise<{ unregister: () => void }>>(),
}));
vi.mock("@tauri-apps/plugin-notification", () => plugin);

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const baseDraft: DraftRecord = {
  id: "d1",
  question: "What's our refund policy?",
  threadContext: null,
  draftText: "Refunds within 30 days.",
  escalated: false,
  escalationReason: null,
  confidenceScore: 0.8,
  sources: [],
  createdAt: "2026-09-01T00:00:00.000Z",
  outcome: null,
  outcomeRecordedAt: null,
  sentText: null,
  refused: false,
  escalationThreshold: 0.6,
  provenance: { origin: "unknown" },
  delivery: null,
};

function pendingDrafts(count: number): DraftRecord[] {
  return Array.from({ length: count }, (_, i) => ({ ...baseDraft, id: `d${i + 1}` }));
}

/** Mounted with every read answering `pendingNow` drafts — badges.test.tsx's driver. */
function mountApp(pendingNow: () => number, hash = "#duo") {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(pendingDrafts(pendingNow())), { status: 200 })),
  );
  localStorage.setItem("duo.api-config", JSON.stringify({ baseUrl: "http://d:7717", token: "t" }));
  window.location.hash = hash;
  window.dispatchEvent(new Event("hashchange"));
  return render(<App />);
}

beforeEach(() => {
  shell.invoke.mockClear();
  shell.invoke.mockImplementation(async () => {});
  shell.listen.mockClear();
  shell.listen.mockImplementation(async () => () => {});
  shell.show.mockClear();
  shell.setBadgeCount.mockClear();
  shell.windowThrows = false;
  plugin.isPermissionGranted.mockClear();
  plugin.isPermissionGranted.mockResolvedValue(true);
  plugin.sendNotification.mockClear();
  plugin.onAction.mockClear();
  plugin.onAction.mockImplementation(async () => ({ unregister: () => {} }));
  window.location.hash = "";
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  window.location.hash = "";
});

describe("#42 AC1 — the app has an identity", () => {
  it("carries its own name in every place an identity is read", () => {
    const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.productName).toBe("Duo");
    expect(conf.identifier).toBe("com.guangshinhaha.duo");
  });

  it("ships an icon that is not Tauri's default", () => {
    const sha = (relative: string) =>
      createHash("sha256").update(readFileSync(join(root, relative))).digest("hex");
    // The template's own hashes, as they shipped before #42 — pinned so the
    // icon can never silently revert to "an app with Tauri's logo on it".
    expect(sha("src-tauri/icons/icon.png")).not.toBe("6413bfe9d546e5225fc9256a0ecec48df3a1272ea4bdc91c15b8e000222a95d3");
    expect(sha("src-tauri/icons/icon.icns")).not.toBe("1535d355994f8ee82da91384d2a29e04d5b4440f3e6051b5c8b06e7a62283693");
  });
});

describe("#42 AC2 — it installs like an application", () => {
  it("bundles a real Mac install, not a bare binary", () => {
    const conf = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));
    expect(conf.bundle.active).toBe(true);
    expect(conf.bundle.targets).toContain("app");
    expect(conf.bundle.targets).toContain("dmg");
  });

  it("the documented build produces the bundle, and no longer skips it", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toMatch(/tauri -- build\b/);
    expect(readme).not.toContain("--no-bundle");
  });

  it("records why the build is not signed, and the path to fixing it", () => {
    const record = readFileSync(join(root, "docs/shell-release.md"), "utf8");
    expect(record).toMatch(/notari/i);
    expect(record).toMatch(/Developer ID/);
    expect(record).toMatch(/Gatekeeper/);
  });
});

describe("#42 AC3 — the menu bar answers the standing question", () => {
  it("the pending count reaches the shell's menu-bar half with every read", async () => {
    let pending = 3;
    const { unmount } = mountApp(() => pending, "#duo");
    await waitFor(() => expect(shell.invoke).toHaveBeenCalledWith("set_pending_count", { count: 3 }));

    // The count falls to zero — driven as a relaunch, like badges.test.tsx.
    pending = 0;
    unmount();
    shell.invoke.mockClear();
    mountApp(() => pending, "#duo");
    await waitFor(() => expect(shell.invoke).toHaveBeenCalledWith("set_pending_count", { count: 0 }));
  });

  it("unpairing clears the menu bar — a stale count never outlives its pairing", async () => {
    mountApp(() => 2, "#duo");
    await waitFor(() => expect(shell.invoke).toHaveBeenCalledWith("set_pending_count", { count: 2 }));

    fireEvent.click(screen.getByText("Forget this device"));
    await waitFor(() => expect(shell.invoke).toHaveBeenLastCalledWith("set_pending_count", { count: 0 }));
    expect(JSON.parse(localStorage.getItem("duo.api-config") ?? "null")).toBeNull();
  });

  it("one click on the tray's Review takes the client to Review", async () => {
    const handlers = new Map<string, () => void>();
    shell.listen.mockImplementation(async (event: string, handler: () => void) => {
      handlers.set(event, handler);
      return () => {};
    });
    mountApp(() => 0, "#duo");
    // The shell wired its half: the tray's Review event has a listener.
    await waitFor(() => expect(handlers.has("tray-open-review")).toBe(true));

    window.location.hash = "";
    act(() => handlers.get("tray-open-review")!());
    expect(window.location.hash).toBe("#review");
  });

  it("the seams degrade quietly outside the shell, where the IPC calls reject", async () => {
    vi.resetModules();
    shell.invoke.mockRejectedValueOnce(new Error("window.__TAURI_INTERNALS__ is undefined"));
    const { setTrayPendingCount, wireTrayReview } = await import("../src/tray.js");
    await expect(setTrayPendingCount(4)).resolves.toBeUndefined();

    shell.listen.mockRejectedValueOnce(new Error("window.__TAURI_INTERNALS__ is undefined"));
    await expect(wireTrayReview()).resolves.toBeNull();
  });
});

describe("#42 AC4 — notifications land somewhere useful", () => {
  it("clicking a draft-ready notification reveals the window on that draft", async () => {
    vi.resetModules();
    let onClick: ActionCallback | undefined;
    plugin.onAction.mockImplementation(async (cb: ActionCallback) => {
      onClick = cb;
      return { unregister: () => {} };
    });
    const { notifyDraftReady, wireDraftNotificationClicks } = await import("../src/notifications.js");
    await wireDraftNotificationClicks();
    await notifyDraftReady("d9");

    const sent = plugin.sendNotification.mock.calls[0]![0];
    expect(sent.id).toBeDefined();
    window.location.hash = "";
    act(() => onClick!({ id: sent.id }));
    // The click does both halves: the window comes up, and it comes up on
    // the draft the notification was about — a hidden window otherwise
    // swallows the navigation where nobody sees it.
    expect(shell.show).toHaveBeenCalled();
    expect(window.location.hash).toBe("#draft/d9");
  });

  it("outside the shell the reveal fails and the click still navigates", async () => {
    vi.resetModules();
    shell.windowThrows = true;
    let onClick: ActionCallback | undefined;
    plugin.onAction.mockImplementation(async (cb: ActionCallback) => {
      onClick = cb;
      return { unregister: () => {} };
    });
    const { notifyDraftReady, wireDraftNotificationClicks } = await import("../src/notifications.js");
    await wireDraftNotificationClicks();
    await notifyDraftReady("d4");

    const sent = plugin.sendNotification.mock.calls[0]![0];
    window.location.hash = "";
    // No window to reveal — and no unhandled rejection either: the
    // navigation is still the client's to do.
    expect(() => onClick!({ id: sent.id })).not.toThrow();
    expect(window.location.hash).toBe("#draft/d4");
  });
});
