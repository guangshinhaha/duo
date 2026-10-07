import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RoomDrafts } from "../src/components/RoomDrafts.js";
import type { DuoApiConfig } from "../src/api/client.js";

/*
 * guangshinhaha/duo#285: "your duo is drafting" — App.tsx's own read of the
 * daemon's `draft-drafting` push, handed down as a plain `drafting` prop
 * (the same reasoning `RoomDrafts` itself already documents for why it's a
 * slot at all). This only exercises the rendering decision; App.tsx's own
 * wiring of the push into this prop is covered by test/ws.test.tsx.
 */
describe("#285 — RoomDrafts shows 'your duo is drafting' while nothing is waiting yet", () => {
  const api: DuoApiConfig = { baseUrl: "http://test:7717", token: "tok" };

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify([]), { status: 200 })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function renderRoomDrafts(drafting: boolean) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={client}>
        <RoomDrafts api={api} roomId="!project-x:workspace.example" drafting={drafting} />
      </QueryClientProvider>,
    );
  }

  it("shows the indicator when drafting is true and nothing is waiting", async () => {
    renderRoomDrafts(true);
    expect(await screen.findByTestId("room-drafting-indicator")).toHaveTextContent("Your duo is drafting…");
  });

  it("shows nothing when drafting is false", () => {
    renderRoomDrafts(false);
    expect(screen.queryByTestId("room-drafting-indicator")).toBeNull();
  });

  it("defaults to not drafting when the prop is omitted", () => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <RoomDrafts api={api} roomId="!project-x:workspace.example" />
      </QueryClientProvider>,
    );
    expect(screen.queryByTestId("room-drafting-indicator")).toBeNull();
  });
});
