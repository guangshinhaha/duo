import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DuoApiConfig } from "../src/api/client.js";
import { PersonProfile } from "../src/components/PersonProfile.js";
import type { WorkspaceConnection } from "../src/workspace/matrix.js";

/*
 * Issue #262's third piece: a "Reset learned tone" control in the person's
 * profile — reads `GET /people/:id/voice-adaptation` to know whether there
 * is anything to reset, and `DELETE`s it only after a brief, inline
 * confirmation (never a T4-style dialog: this undoes accumulated learning,
 * never anything already sent).
 */

const api: DuoApiConfig = { baseUrl: "http://test", token: "tok" };

function fakeConnection(): WorkspaceConnection {
  return {
    userId: "@ana:w",
    getProfile: vi.fn(async () => null),
    startDirect: vi.fn(async () => "!room:w"),
  } as unknown as WorkspaceConnection;
}

function mount(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("issue #262 — a person's learned tone, from their profile", () => {
  it("shows the register and resets it only after a brief confirm, then says so", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      if (String(url).endsWith("/voice-adaptation") && method === "DELETE") {
        return new Response(null, { status: 204 });
      }
      return new Response(
        JSON.stringify({
          recipientId: "@wei:w",
          recipientName: "Wei",
          sampleSize: 6,
          threshold: 5,
          active: true,
          features: { register: "formal" },
          resetAt: null,
        }),
        { status: 200 },
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    mount(
      <PersonProfile
        api={api}
        connection={fakeConnection()}
        onMessage={() => {}}
        onOpenChange={() => {}}
        open
        person={{ userId: "@wei:w", name: "Wei" }}
      />,
    );

    expect(await screen.findByTestId("person-profile-voice-adaptation")).toHaveTextContent("learned a formal tone for writing to Wei");
    // Not reset yet — a click is required, never a reset on open.
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);

    fireEvent.click(screen.getByTestId("person-profile-reset-tone"));
    expect(screen.getByTestId("person-profile-reset-tone-confirm")).toHaveTextContent("Wei");
    expect(screen.getByTestId("person-profile-reset-tone-confirm")).toHaveTextContent("won't touch anything you've already sent");

    fireEvent.click(screen.getByTestId("person-profile-reset-tone-confirm-yes"));

    await waitFor(() => expect(screen.getByTestId("person-profile-reset-tone-done")).toBeInTheDocument());
    const deleteCall = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "DELETE");
    expect(deleteCall?.[0]).toBe(`${api.baseUrl}/people/%40wei%3Aw/voice-adaptation`);
  });

  it("cancelling the confirm leaves the control in place, and never calls DELETE", async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
      async () =>
        new Response(
          JSON.stringify({
            recipientId: "@wei:w",
            recipientName: "Wei",
            sampleSize: 6,
            threshold: 5,
            active: true,
            features: { register: "casual" },
            resetAt: null,
          }),
          { status: 200 },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    mount(
      <PersonProfile api={api} connection={fakeConnection()} onMessage={() => {}} onOpenChange={() => {}} open person={{ userId: "@wei:w", name: "Wei" }} />,
    );

    fireEvent.click(await screen.findByTestId("person-profile-reset-tone"));
    fireEvent.click(screen.getByTestId("person-profile-reset-tone-cancel"));

    expect(screen.getByTestId("person-profile-reset-tone")).toBeInTheDocument();
    expect(fetchMock.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method === "DELETE")).toBe(false);
  });

  it("shows nothing when there isn't a single send to this person yet", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ recipientId: "@wei:w", recipientName: "Wei", sampleSize: 0, threshold: 5, active: false, features: null, resetAt: null }),
            { status: 200 },
          ),
      ),
    );

    mount(
      <PersonProfile api={api} connection={fakeConnection()} onMessage={() => {}} onOpenChange={() => {}} open person={{ userId: "@wei:w", name: "Wei" }} />,
    );

    await waitFor(() => expect(screen.getByTestId("person-profile-name")).toBeInTheDocument());
    expect(screen.queryByTestId("person-profile-voice-adaptation")).toBeNull();
  });

  it("shows a lighter progress line, and no reset control, below the sample threshold", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({ recipientId: "@wei:w", recipientName: "Wei", sampleSize: 3, threshold: 5, active: false, features: null, resetAt: null }),
            { status: 200 },
          ),
      ),
    );

    mount(
      <PersonProfile api={api} connection={fakeConnection()} onMessage={() => {}} onOpenChange={() => {}} open person={{ userId: "@wei:w", name: "Wei" }} />,
    );

    expect(await screen.findByTestId("person-profile-voice-adaptation")).toHaveTextContent("still learning how you write to Wei — 3 of 5 sends so far");
    expect(screen.queryByTestId("person-profile-reset-tone")).toBeNull();
  });

  it("without a paired duo the control never renders, though the profile itself still does", () => {
    mount(
      <PersonProfile api={null} connection={fakeConnection()} onMessage={() => {}} onOpenChange={() => {}} open person={{ userId: "@wei:w", name: "Wei" }} />,
    );

    expect(screen.getByTestId("person-profile-name")).toBeInTheDocument();
    expect(screen.queryByTestId("person-profile-voice-adaptation")).toBeNull();
  });
});
