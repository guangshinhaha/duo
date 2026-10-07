import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Settings } from "../src/routes/Settings.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { WorkspaceConnection } from "../src/workspace/matrix.js";

const api: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: "c6jzoxVdOelvnJnGZRkFSnny_kxYcQ4wsERakvyXiXk" };

function fakeConnection(initial: readonly string[] = []): WorkspaceConnection & { keywords: string[] } {
  const state = { keywords: [...initial] };
  const connection = {
    userId: "@me:workspace.example",
    keywords: state.keywords,
    keywordAlerts: vi.fn(async () => [...state.keywords].sort()),
    addKeywordAlert: vi.fn(async (keyword: string) => {
      const trimmed = keyword.trim();
      if (trimmed !== "" && !state.keywords.includes(trimmed)) {
        state.keywords.push(trimmed);
      }
    }),
    removeKeywordAlert: vi.fn(async (keyword: string) => {
      state.keywords = state.keywords.filter((entry) => entry !== keyword);
    }),
  } as unknown as WorkspaceConnection & { keywords: string[] };
  return connection;
}

function renderSettings(connection: WorkspaceConnection | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <Settings
        api={api}
        connection={connection}
        section="notifications"
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

describe("Settings — keyword alerts (#310)", () => {
  it("offers to sign in when there is no live workspace connection", () => {
    renderSettings(null);
    expect(screen.getByTestId("settings-keyword-alerts")).toHaveTextContent("Sign in to a workspace to set keyword alerts.");
  });

  it("lists the member's existing keyword alerts", async () => {
    renderSettings(fakeConnection(["launch", "budget"]));
    await waitFor(() => expect(screen.getByTestId("keyword-alerts-list")).toBeInTheDocument());
    expect(screen.getByText("launch")).toBeInTheDocument();
    expect(screen.getByText("budget")).toBeInTheDocument();
  });

  it("shows an empty state with no keyword alerts yet", async () => {
    renderSettings(fakeConnection([]));
    await waitFor(() => expect(screen.getByTestId("keyword-alerts-empty")).toBeInTheDocument());
  });

  it("adds a keyword and shows it in the list", async () => {
    const connection = fakeConnection([]);
    renderSettings(connection);
    await waitFor(() => expect(screen.getByTestId("keyword-alerts-empty")).toBeInTheDocument());

    fireEvent.change(screen.getByTestId("keyword-alert-input"), { target: { value: "launch" } });
    fireEvent.click(screen.getByTestId("keyword-alert-add"));

    await waitFor(() => expect(connection.addKeywordAlert).toHaveBeenCalledWith("launch"));
    await waitFor(() => expect(screen.getByText("launch")).toBeInTheDocument());
    // The input clears after a successful add, ready for the next one.
    expect(screen.getByTestId("keyword-alert-input")).toHaveValue("");
  });

  it("removes a keyword from the list", async () => {
    const connection = fakeConnection(["launch"]);
    renderSettings(connection);
    await waitFor(() => expect(screen.getByText("launch")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("keyword-alert-remove-launch"));

    await waitFor(() => expect(connection.removeKeywordAlert).toHaveBeenCalledWith("launch"));
    await waitFor(() => expect(screen.getByTestId("keyword-alerts-empty")).toBeInTheDocument());
  });

  it("the Add button stays disabled for a blank or whitespace-only keyword", async () => {
    renderSettings(fakeConnection([]));
    await waitFor(() => expect(screen.getByTestId("keyword-alerts-empty")).toBeInTheDocument());
    expect(screen.getByTestId("keyword-alert-add")).toBeDisabled();
    fireEvent.change(screen.getByTestId("keyword-alert-input"), { target: { value: "   " } });
    expect(screen.getByTestId("keyword-alert-add")).toBeDisabled();
  });
});
