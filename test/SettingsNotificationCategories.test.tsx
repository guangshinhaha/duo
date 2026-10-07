import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../src/routes/Settings.js";
import type { DuoApiConfig } from "../src/api/client.js";
import { NOTIFICATION_CATEGORY_STORAGE_KEY, readNotificationCategoryPrefs } from "../src/notificationCategoryPrefs.js";

const api: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: "c6jzoxVdOelvnJnGZRkFSnny_kxYcQ4wsERakvyXiXk" };

function renderSettings() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Settings
        api={api}
        session={null}
        onConfigChange={vi.fn()}
        onSignOut={vi.fn()}
        onPairDuo={vi.fn()}
        onWorkspaceSignIn={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
});
afterEach(() => {
  localStorage.clear();
  vi.unstubAllGlobals();
});

describe("Settings — notification categories (#309)", () => {
  it("lists all five categories, each defaulting to Immediate", () => {
    renderSettings();
    expect(screen.getByTestId("notif-category-draftsReady")).toHaveValue("immediate");
    expect(screen.getByTestId("notif-category-mentions")).toHaveValue("immediate");
    expect(screen.getByTestId("notif-category-passedOn")).toHaveValue("immediate");
    expect(screen.getByTestId("notif-category-directMessages")).toHaveValue("immediate");
    // #310: keyword alerts is the fifth category — same default, same shape.
    expect(screen.getByTestId("notif-category-keywordAlerts")).toHaveValue("immediate");
  });

  it("changing one category's setting writes it to this device's storage, leaving the others untouched", () => {
    renderSettings();
    fireEvent.change(screen.getByTestId("notif-category-mentions"), { target: { value: "off" } });
    expect(readNotificationCategoryPrefs()).toEqual({
      draftsReady: "immediate",
      passedOn: "immediate",
      mentions: "off",
      directMessages: "immediate",
      keywordAlerts: "immediate",
    });

    fireEvent.change(screen.getByTestId("notif-category-directMessages"), { target: { value: "batched" } });
    expect(readNotificationCategoryPrefs()).toEqual({
      draftsReady: "immediate",
      passedOn: "immediate",
      mentions: "off",
      directMessages: "batched",
      keywordAlerts: "immediate",
    });
  });

  it("reflects a setting already on this device's storage at mount", () => {
    localStorage.setItem(
      NOTIFICATION_CATEGORY_STORAGE_KEY,
      JSON.stringify({ draftsReady: "batched", passedOn: "off", mentions: "immediate", directMessages: "immediate", keywordAlerts: "off" }),
    );
    renderSettings();
    expect(screen.getByTestId("notif-category-draftsReady")).toHaveValue("batched");
    expect(screen.getByTestId("notif-category-passedOn")).toHaveValue("off");
    expect(screen.getByTestId("notif-category-keywordAlerts")).toHaveValue("off");
  });
});
