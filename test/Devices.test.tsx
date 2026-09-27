import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App.js";
import { Settings } from "../src/routes/Settings.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { PairedDevice } from "../src/api/types.js";

/*
 * #48: see and revoke the devices that can read this corpus. The wire is
 * digital-duo #177's — `GET /devices` answers `DeviceToken[]` (id, name,
 * createdAt, lastSeenAt, revokedAt; no token or hash field exists in the
 * shape) and `POST /devices/:id/revoke` answers the revoked row. The daemon
 * never tells a caller WHICH row is the caller, so "this device" is a mark
 * the owner places once and this device remembers (a client-local label;
 * the client adds no behaviour the daemon lacks).
 */

const FULL_TOKEN = "c6jzoxVdOelvnJnGZRkFSnny_kxYcQ4wsERakvyXiXk";
const base: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: FULL_TOKEN };

const PAIRED_AT = "2026-03-01T10:00:00.000Z";
const SEEN_AT = "2026-09-20T08:30:00.000Z";

function device(id: string, name: string, over: Partial<PairedDevice> = {}): PairedDevice {
  return { id, name, createdAt: PAIRED_AT, lastSeenAt: SEEN_AT, revokedAt: null, ...over };
}

/** A daemon in a closure: the device list is state, and revoke is the one write, exactly #177's two routes. */
function stubDaemon(initial: PairedDevice[], opts: { revokeFails?: { status: number; code: string; message: string } } = {}) {
  const devices = initial.map((d) => ({ ...d }));
  const calls: { method: string; path: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = url.replace(base.baseUrl, "");
      const method = init?.method ?? "GET";
      calls.push({ method, path });
      if (method === "GET" && path === "/devices") {
        return new Response(JSON.stringify(devices), { status: 200 });
      }
      const revoke = path.match(/^\/devices\/([^/]+)\/revoke$/);
      if (method === "POST" && revoke) {
        if (opts.revokeFails) {
          const { status, code, message } = opts.revokeFails;
          return new Response(JSON.stringify({ error: { code, message } }), { status });
        }
        const row = devices.find((d) => d.id === revoke[1]);
        if (!row) {
          return new Response(JSON.stringify({ error: { code: "DeviceTokenNotFoundError", message: `No paired device with id "${revoke[1]}"` } }), { status: 404 });
        }
        row.revokedAt ??= "2026-09-26T09:00:00.000Z";
        return new Response(JSON.stringify(row), { status: 200 });
      }
      return new Response(JSON.stringify([]), { status: 200 });
    }),
  );
  return { devices, calls };
}

function renderSettings(api: DuoApiConfig, onConfigChange = vi.fn()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Settings
        api={api}
        session={null}
        onConfigChange={onConfigChange}
        onSignOut={vi.fn()}
        onPairDuo={vi.fn()}
        onWorkspaceSignIn={vi.fn()}
      />
    </QueryClientProvider>,
  );
  return onConfigChange;
}

const rowFor = (name: string) => screen.getAllByTestId("device-row").find((row) => within(row).queryByTestId("device-name")?.textContent === name)!;

describe("Devices list (#48 AC1) — name, when paired, when last seen, never a token", () => {
  beforeEach(() => {
    stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone", { lastSeenAt: null })]);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("each paired device shows its name, when it was paired and when it was last seen", async () => {
    renderSettings(base);
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));

    const mac = rowFor("Mac");
    // Both times render as <time> elements carrying the daemon's own ISO stamps.
    expect(within(mac).getByTestId("device-paired").querySelector("time")).toHaveAttribute("datetime", PAIRED_AT);
    expect(within(mac).getByTestId("device-last-seen").querySelector("time")).toHaveAttribute("datetime", SEEN_AT);
    expect(within(mac).getByTestId("device-paired")).toHaveTextContent(/paired/i);
    expect(within(mac).getByTestId("device-last-seen")).toHaveTextContent(/last seen/i);
  });

  it("a device the daemon has never seen says so, rather than showing a blank or an invented time", async () => {
    renderSettings(base);
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));
    const phone = rowFor("iPhone");
    expect(within(phone).getByTestId("device-last-seen")).toHaveTextContent("never");
    expect(within(phone).getByTestId("device-last-seen").querySelector("time")).toBeNull();
  });

  it("never renders a token: not this device's in full, and not a stray token field on a row", async () => {
    stubDaemon([{ ...device("d-mac", "Mac"), token: "leaked-token-value", tokenHash: "deadbeefhash" } as PairedDevice]);
    renderSettings(base);
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(1));
    const text = screen.getByTestId("settings").textContent ?? "";
    expect(text).not.toContain(FULL_TOKEN);
    expect(text).not.toContain("leaked-token-value");
    expect(text).not.toContain("deadbeefhash");
  });

  it("asks the daemon's own route, with this device's bearer, and offers no way to pair a new device", async () => {
    renderSettings(base);
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));
    const fetchMock = vi.mocked(fetch);
    const [url, init] = fetchMock.mock.calls.find(([u]) => String(u).endsWith("/devices"))!;
    expect(url).toBe("http://100.64.1.5:7717/devices");
    expect((init?.headers as Record<string, string>).Authorization).toBe(`Bearer ${FULL_TOKEN}`);
    // Out of scope (#48): pairing stays an act at the machine holding the corpus.
    expect(screen.getByTestId("settings-devices")).toHaveTextContent("duo pair new");
    expect(within(screen.getByTestId("settings-devices")).queryByRole("button", { name: /pair/i })).toBeNull();
  });

  it("a device the daemon has already revoked is shown as revoked, and offers nothing to revoke", async () => {
    stubDaemon([device("d-mac", "Mac"), device("d-old", "Old phone", { revokedAt: "2026-08-01T00:00:00.000Z" })]);
    renderSettings(base);
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));
    const old = rowFor("Old phone");
    expect(within(old).getByTestId("device-revoked")).toHaveTextContent(/revoked/i);
    expect(within(old).queryByTestId("device-revoke")).toBeNull();
    expect(within(rowFor("Mac")).getByTestId("device-revoke")).toBeInTheDocument();
  });

  it("a daemon that cannot list them says so, with the daemon's words and a way to try again", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: { code: "boom", message: "the store is locked" } }), { status: 500 })),
    );
    renderSettings(base);
    await waitFor(() => expect(screen.getByTestId("devices-error")).toBeInTheDocument());
    expect(screen.getByTestId("devices-error")).toHaveTextContent("the store is locked");
    expect(within(screen.getByTestId("settings-devices")).getByRole("button", { name: "Try again" })).toBeInTheDocument();
  });
});

describe("This device is marked (#48 AC2)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the row matching this device's remembered id is identifiable, and no other is", async () => {
    stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone")]);
    renderSettings({ ...base, deviceId: "d-phone" });
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));
    expect(within(rowFor("iPhone")).getByTestId("device-this")).toHaveTextContent("This device");
    expect(within(rowFor("Mac")).queryByTestId("device-this")).toBeNull();
    // Marked, so no row asks which one it is.
    expect(screen.queryAllByTestId("device-mark")).toHaveLength(0);
  });

  it("until it is known, the list says the daemon doesn't tell, and the owner marks it once — remembered with the pairing", async () => {
    stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone")]);
    const onConfigChange = renderSettings(base);
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));
    expect(screen.queryByTestId("device-this")).toBeNull();
    expect(screen.getByTestId("devices-unmarked-note")).toHaveTextContent(/doesn't say which/i);

    fireEvent.click(within(rowFor("iPhone")).getByTestId("device-mark"));
    expect(onConfigChange).toHaveBeenCalledWith({ ...base, deviceId: "d-phone" });
  });

  it("a wrong mark can be taken back, leaving the pairing itself untouched", async () => {
    stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone")]);
    const onConfigChange = renderSettings({ ...base, deviceId: "d-mac" });
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));
    fireEvent.click(within(rowFor("Mac")).getByTestId("device-unmark"));
    expect(onConfigChange).toHaveBeenCalledWith(base);
  });

  it("saving a new daemon address keeps the mark — a moved daemon is the same paired device", async () => {
    stubDaemon([device("d-mac", "Mac")]);
    const onConfigChange = renderSettings({ ...base, deviceId: "d-mac" });
    fireEvent.change(screen.getByLabelText("Daemon address"), { target: { value: "10.0.0.5:7717" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onConfigChange).toHaveBeenCalledWith({ baseUrl: "http://10.0.0.5:7717", token: FULL_TOKEN, deviceId: "d-mac" });
  });
});

describe("A device can be revoked (#48 AC3)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("asks first, and cancelling revokes nothing", async () => {
    const { calls } = stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone")]);
    renderSettings({ ...base, deviceId: "d-mac" });
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));

    fireEvent.click(within(rowFor("iPhone")).getByTestId("device-revoke"));
    expect(screen.getByTestId("device-revoke-confirmation")).toHaveTextContent("iPhone");
    fireEvent.click(screen.getByTestId("device-revoke-cancel"));
    expect(screen.queryByTestId("device-revoke-confirmation")).toBeNull();
    expect(calls.some((c) => c.method === "POST")).toBe(false);
    expect(within(rowFor("iPhone")).queryByTestId("device-revoked")).toBeNull();
  });

  it("confirming revokes it at the daemon, and the list updates to show it revoked", async () => {
    const { calls, devices } = stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone")]);
    const onConfigChange = renderSettings({ ...base, deviceId: "d-mac" });
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));

    fireEvent.click(within(rowFor("iPhone")).getByTestId("device-revoke"));
    // The consequence, in the daemon's terms: immediate, and re-pairing is at the Mac.
    expect(screen.getByTestId("device-revoke-confirmation")).toHaveTextContent(/loses access.*immediately/i);
    expect(screen.getByTestId("device-revoke-confirmation")).toHaveTextContent("duo pair new");
    fireEvent.click(screen.getByTestId("device-revoke-confirm"));

    await waitFor(() => expect(within(rowFor("iPhone")).getByTestId("device-revoked")).toBeInTheDocument());
    expect(calls).toContainEqual({ method: "POST", path: "/devices/d-phone/revoke" });
    expect(devices.find((d) => d.id === "d-phone")?.revokedAt).not.toBeNull();
    // Nothing left to revoke on that row; this device's row is untouched, and nothing was forgotten locally.
    expect(within(rowFor("iPhone")).queryByTestId("device-revoke")).toBeNull();
    expect(within(rowFor("Mac")).queryByTestId("device-revoked")).toBeNull();
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("a refusal from the daemon shows its own words and leaves the pairing standing", async () => {
    stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone")], {
      revokeFails: { status: 404, code: "DeviceTokenNotFoundError", message: 'No paired device with id "d-phone"' },
    });
    const onConfigChange = renderSettings({ ...base, deviceId: "d-mac" });
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));
    fireEvent.click(within(rowFor("iPhone")).getByTestId("device-revoke"));
    fireEvent.click(screen.getByTestId("device-revoke-confirm"));

    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent('No paired device with id "d-phone"'));
    expect(within(rowFor("iPhone")).queryByTestId("device-revoked")).toBeNull();
    expect(onConfigChange).not.toHaveBeenCalled();
  });
});

describe("Revoking this device is deliberate (#48 AC4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("states the consequence first — this app returns to Setup — and revokes nothing until confirmed", async () => {
    const { calls } = stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone")]);
    renderSettings({ ...base, deviceId: "d-mac" });
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));

    fireEvent.click(within(rowFor("Mac")).getByTestId("device-revoke"));
    const dialog = screen.getByTestId("device-revoke-confirmation");
    // Consequence first: the description's opening sentence is about THIS device, its access, and Setup.
    const description = within(dialog).getByTestId("device-revoke-description").textContent ?? "";
    expect(description).toMatch(/^This is the device you're using/);
    expect(description).toMatch(/returns to Setup/);
    expect(description).toMatch(/duo pair new/);
    expect(within(dialog).getByRole("button", { name: /Revoke this device/ })).toBeInTheDocument();
    expect(calls.some((c) => c.method === "POST")).toBe(false);

    fireEvent.click(screen.getByTestId("device-revoke-cancel"));
    expect(calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("confirming revokes at the daemon and only then hands the app back to Setup through the one unpair choke point", async () => {
    const { calls } = stubDaemon([device("d-mac", "Mac"), device("d-phone", "iPhone")]);
    // The choke point's call lands in the same ledger as the wire, so the order between them is checkable.
    const onConfigChange = vi.fn((next: DuoApiConfig | null) => {
      calls.push({ method: "FORGET", path: String(next) });
    });
    renderSettings({ ...base, deviceId: "d-mac" }, onConfigChange);
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(2));

    fireEvent.click(within(rowFor("Mac")).getByTestId("device-revoke"));
    fireEvent.click(screen.getByTestId("device-revoke-confirm"));

    await waitFor(() => expect(onConfigChange).toHaveBeenCalledWith(null));
    // Revoked first, forgotten second — never forgotten with the daemon still trusting the token.
    const order = calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`);
    expect(order).toEqual(["POST /devices/d-mac/revoke", "FORGET null"]);
  });

  it("if the daemon refuses, this device is NOT sent back to Setup — it still holds a token that works", async () => {
    stubDaemon([device("d-mac", "Mac")], { revokeFails: { status: 500, code: "boom", message: "the store is locked" } });
    const onConfigChange = renderSettings({ ...base, deviceId: "d-mac" });
    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(1));
    fireEvent.click(within(rowFor("Mac")).getByTestId("device-revoke"));
    fireEvent.click(screen.getByTestId("device-revoke-confirm"));
    await waitFor(() => expect(screen.getByTestId("mutation-error")).toHaveTextContent("the store is locked"));
    expect(onConfigChange).not.toHaveBeenCalled();
  });

  it("end to end in the app: the connection, the mark and the cache go, and Setup is what remains — without a 'revoked' scolding", async () => {
    localStorage.clear();
    localStorage.setItem("duo.api-config", JSON.stringify({ ...base, deviceId: "d-mac" }));
    stubDaemon([device("d-mac", "Mac")]);
    window.location.hash = "#settings/devices";
    render(<App />);

    await waitFor(() => expect(screen.getAllByTestId("device-row")).toHaveLength(1));
    fireEvent.click(within(rowFor("Mac")).getByTestId("device-revoke"));
    fireEvent.click(screen.getByTestId("device-revoke-confirm"));

    await waitFor(() => expect(screen.getByPlaceholderText("100.64.1.5:7717")).toBeInTheDocument());
    expect(localStorage.getItem("duo.api-config")).toBeNull();
    // The owner did this on purpose: Setup is the plain first-run screen, not the #41 "no longer paired" notice.
    expect(screen.queryByTestId("setup-notice")).toBeNull();
    localStorage.clear();
  });
});

describe("Forgetting is not revoking (#48 keeps #11's copy honest)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("the Forget confirmation still says the daemon keeps trusting the token, and points to the revoke that changes that", async () => {
    stubDaemon([device("d-mac", "Mac")]);
    renderSettings({ ...base, deviceId: "d-mac" });
    fireEvent.click(screen.getByTestId("settings-unpair"));
    const confirmation = screen.getByTestId("settings-unpair-confirmation");
    expect(confirmation).toHaveTextContent("daemon keeps its own record");
    expect(confirmation).toHaveTextContent(/does not revoke/i);
    expect(confirmation).toHaveTextContent(/Devices/);
  });
});
