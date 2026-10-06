import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";

/*
 * #308: Settings' web-push toggle, exercised against a mocked `src/push.ts`
 * — the browser APIs it calls (ServiceWorker, PushManager, Notification)
 * are covered directly in `test/PushSubscription.test.ts`; this is about
 * the control surface: what it shows, and that it calls the right function
 * with the right argument when pressed.
 */

const pushSubscriptionStatus = vi.fn();
const subscribeToPush = vi.fn();
const unsubscribeFromPush = vi.fn();

vi.mock("../src/push.js", () => ({
  pushSubscriptionStatus: (...args: unknown[]) => pushSubscriptionStatus(...args),
  subscribeToPush: (...args: unknown[]) => subscribeToPush(...args),
  unsubscribeFromPush: (...args: unknown[]) => unsubscribeFromPush(...args),
}));

// Imported after the mock above, as `vi.mock` is hoisted.
const { Settings } = await import("../src/routes/Settings.js");

const api: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: "the-device-token" };

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
        section="notifications"
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  pushSubscriptionStatus.mockReset();
  subscribeToPush.mockReset();
  unsubscribeFromPush.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("Settings — notify me when the app is closed (#308)", () => {
  it("says push isn't supported here, and offers no toggle, when the browser can't subscribe", async () => {
    pushSubscriptionStatus.mockResolvedValue({ supported: false, subscribed: false });
    renderSettings();
    expect(await screen.findByTestId("push-unsupported")).toBeInTheDocument();
    expect(screen.queryByTestId("push-toggle")).toBeNull();
  });

  it("offers to turn push on when supported but not yet subscribed", async () => {
    pushSubscriptionStatus.mockResolvedValue({ supported: true, subscribed: false });
    renderSettings();
    expect(await screen.findByTestId("push-toggle")).toHaveTextContent("Turn on");
    expect(screen.getByTestId("push-status")).toHaveTextContent("Off");
  });

  it("offers to turn push off when already subscribed", async () => {
    pushSubscriptionStatus.mockResolvedValue({ supported: true, subscribed: true });
    renderSettings();
    expect(await screen.findByTestId("push-toggle")).toHaveTextContent("Turn off");
    expect(screen.getByTestId("push-status")).toHaveTextContent("On for this browser");
  });

  it("subscribes this device, with this duo's own api config, when turned on", async () => {
    pushSubscriptionStatus.mockResolvedValueOnce({ supported: true, subscribed: false }).mockResolvedValue({ supported: true, subscribed: true });
    subscribeToPush.mockResolvedValue(undefined);
    renderSettings();
    fireEvent.click(await screen.findByTestId("push-toggle"));
    await waitFor(() => expect(subscribeToPush).toHaveBeenCalledWith(api));
    expect(await screen.findByTestId("push-toggle")).toHaveTextContent("Turn off");
  });

  it("shows the refusal when subscribing fails, rather than failing silently", async () => {
    pushSubscriptionStatus.mockResolvedValue({ supported: true, subscribed: false });
    subscribeToPush.mockRejectedValue(new Error("Notifications are blocked for this site."));
    renderSettings();
    fireEvent.click(await screen.findByTestId("push-toggle"));
    expect(await screen.findByTestId("mutation-error")).toHaveTextContent("Notifications are blocked for this site.");
  });

  it("unsubscribes this device, with this duo's own api config, when turned off", async () => {
    pushSubscriptionStatus.mockResolvedValueOnce({ supported: true, subscribed: true }).mockResolvedValue({ supported: true, subscribed: false });
    unsubscribeFromPush.mockResolvedValue(undefined);
    renderSettings();
    fireEvent.click(await screen.findByTestId("push-toggle"));
    await waitFor(() => expect(unsubscribeFromPush).toHaveBeenCalledWith(api));
    expect(await screen.findByTestId("push-toggle")).toHaveTextContent("Turn on");
  });
});
