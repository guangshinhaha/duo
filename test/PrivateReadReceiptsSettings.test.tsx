import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../src/routes/Settings.js";
import { PRIVATE_READ_RECEIPTS_STORAGE_KEY, readPrivateReceiptsPref } from "../src/readReceiptPrefs.js";
import type { DuoApiConfig } from "../src/api/client.js";

/*
 * #286: the Settings toggle for private read receipts — off by default (the
 * ordinary, visible receipt this app always sent, #63), the member's own
 * click turns it on, and the choice is remembered on this device the same
 * way link previews' and quiet fact-check's toggles are (#219, #264).
 */
describe("#286 — the Settings toggle for private read receipts", () => {
  const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

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
    const toggle = screen.getByTestId("settings-private-receipts-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("Turn on private read receipts");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Turn off private read receipts");
    expect(readPrivateReceiptsPref()).toBe(true);
    expect(localStorage.getItem(PRIVATE_READ_RECEIPTS_STORAGE_KEY)).toBe("on");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(readPrivateReceiptsPref()).toBe(false);
  });

  it("the setting persists across a remount — the member's choice, not this render's", () => {
    localStorage.setItem(PRIVATE_READ_RECEIPTS_STORAGE_KEY, "on");
    const first = renderSettings();
    expect(screen.getByTestId("settings-private-receipts-toggle")).toHaveAttribute("aria-pressed", "true");
    first.unmount();
    renderSettings();
    expect(screen.getByTestId("settings-private-receipts-toggle")).toHaveAttribute("aria-pressed", "true");
  });
});
