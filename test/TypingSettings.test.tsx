import { fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../src/routes/Settings.js";
import { TYPING_STORAGE_KEY, readTypingPref } from "../src/typingPrefs.js";
import type { DuoApiConfig } from "../src/api/client.js";

/*
 * #285: the Settings toggle for sending typing notifications — on by
 * default (the ordinary messenger behaviour, unlike link previews' and
 * quiet fact-check's off-by-default stance, #219/#264), the member's own
 * click turns it off, and the choice is remembered on this device the
 * same way every other toggle in Settings is.
 */
describe("#285 — the Settings toggle for sending typing", () => {
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

  it("reads on by default, and the member's own click turns it off and remembers the choice", () => {
    renderSettings();
    const toggle = screen.getByTestId("settings-typing-toggle");
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(toggle).toHaveTextContent("Turn off sending typing");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "false");
    expect(toggle).toHaveTextContent("Turn on sending typing");
    expect(readTypingPref()).toBe(false);
    expect(localStorage.getItem(TYPING_STORAGE_KEY)).toBe("off");

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute("aria-pressed", "true");
    expect(readTypingPref()).toBe(true);
  });

  it("the setting persists across a remount — the member's choice, not this render's", () => {
    localStorage.setItem(TYPING_STORAGE_KEY, "off");
    const first = renderSettings();
    expect(screen.getByTestId("settings-typing-toggle")).toHaveAttribute("aria-pressed", "false");
    first.unmount();
    renderSettings();
    expect(screen.getByTestId("settings-typing-toggle")).toHaveAttribute("aria-pressed", "false");
  });
});
