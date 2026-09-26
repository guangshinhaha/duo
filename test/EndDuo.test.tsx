import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";
import { Settings } from "../src/routes/Settings.js";
import { SyncStatusProvider } from "../src/sync.js";
import type { DuoApiConfig } from "../src/api/client.js";
import type { EndDuoResult } from "../src/api/types.js";
import type { WorkspaceSession } from "../src/workspace/matrix.js";

// The workspace layer is not what these tests are about; a member signed in
// alongside the pairing only needs `connect` to never get in the way.
vi.mock("../src/workspace/matrix.js", () => ({
  connect: vi.fn(() => new Promise(() => {})),
  signIn: vi.fn(),
}));

/*
 * #55: ending the duo from a paired device — `POST /lifecycle/end`
 * (digital-duo #181). The route's contract, which every claim on screen
 * must stay inside: without `confirmed: true` it only DESCRIBES what would
 * go (the same `EndDuoResult` shape, `confirmed: false`); with it, the
 * store and the derived directory are deleted, the ending is audited (who
 * decided it), and EVERY device token dies — this one's next request is a
 * 401, indistinguishable on the wire from a revoked token. Nothing else is
 * promised, so nothing else is said.
 */

const api: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: "c6jzoxVdOelvnJnGZRkFSnny_kxYcQ4wsERakvyXiXk" };
const SESSION: WorkspaceSession = {
  homeserverUrl: "https://hs.example.org",
  userId: "@river:example.org",
  accessToken: "syt_x",
  deviceId: "DEV1",
};

const PREVIEW: EndDuoResult = {
  confirmed: false,
  storeDataDir: "/Users/river/.duo/data",
  storePaths: ["duo.db", "embeddings.bin", "passphrase"],
  duoDir: "/Users/river/duo",
  duoDirPaths: ["voice.md", "rules/r1.md", "lifecycle.json", "refusals.md"],
};
const DONE: EndDuoResult = { ...PREVIEW, confirmed: true };

const FALLBACK_WHO = "the owner, from a paired device";

interface Call {
  path: string;
  method: string;
  body: Record<string, unknown> | undefined;
}

/** A fetch stub that records every call and answers `POST /lifecycle/end` per `confirmed`, the way the daemon does. */
function stubDaemon(handlers: { preview?: () => Response | Promise<Response>; end?: () => Response | Promise<Response> } = {}) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
    const path = String(url).replace(api.baseUrl, "");
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ path, method: init?.method ?? "GET", body });
    if (path === "/lifecycle/end") {
      if (body?.confirmed === true) {
        return handlers.end ? handlers.end() : new Response(JSON.stringify(DONE), { status: 200 });
      }
      return handlers.preview ? handlers.preview() : new Response(JSON.stringify(PREVIEW), { status: 200 });
    }
    return new Response(JSON.stringify([]), { status: 200 });
  });
  vi.stubGlobal("fetch", fetchMock);
  return { calls, endCalls: () => calls.filter((c) => c.path === "/lifecycle/end") };
}

function renderSettings(
  overrides: { session?: WorkspaceSession | null; onDuoEnded?: () => void; api?: DuoApiConfig | null } = {},
  wrap: (ui: ReactElement) => ReactElement = (ui) => ui,
) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const onDuoEnded = overrides.onDuoEnded ?? vi.fn();
  const ui = (
    <QueryClientProvider client={client}>
      <SyncStatusProvider>
        <Settings
          api={overrides.api === undefined ? api : overrides.api}
          session={overrides.session ?? null}
          onConfigChange={vi.fn()}
          onSignOut={vi.fn()}
          onPairDuo={vi.fn()}
          onWorkspaceSignIn={vi.fn()}
          onDuoEnded={onDuoEnded}
        />
      </SyncStatusProvider>
    </QueryClientProvider>
  );
  return { client, onDuoEnded, ...render(wrap(ui)) };
}

async function openDialog() {
  fireEvent.click(screen.getByTestId("settings-end-duo"));
  return screen.findByTestId("settings-end-duo-confirmation");
}

/** Opens the dialog and waits for the daemon's description of what would go. */
async function openDialogWithPreview() {
  const dialog = await openDialog();
  await within(dialog).findByTestId("end-duo-ends");
  return dialog;
}

function typePhrase(text: string) {
  fireEvent.change(screen.getByTestId("settings-end-duo-phrase"), { target: { value: text } });
}

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("#55 AC1 — ending is reachable: findable on Settings without documentation", () => {
  it("Settings carries a section headed 'End this duo' with a control of the same name", () => {
    stubDaemon();
    renderSettings();
    const heading = screen.getByRole("heading", { name: "End this duo" });
    expect(heading).toBeInTheDocument();
    // The section says, in a sentence, what it is for — nobody should have to open the dialog to learn what the heading means.
    const section = heading.closest("section")!;
    expect(section).toHaveTextContent(/from this device/i);
    expect(within(section).getByRole("button", { name: /end this duo/i })).toBeEnabled();
  });

  it("is the duo's own control: with no duo paired there is nothing to end, and no control", () => {
    stubDaemon();
    renderSettings({ api: null });
    expect(screen.queryByTestId("settings-end-duo")).toBeNull();
    expect(screen.queryByRole("heading", { name: "End this duo" })).toBeNull();
  });

  it("opening the control alone changes nothing: it only asks the daemon to DESCRIBE, never to delete", async () => {
    const daemon = stubDaemon();
    renderSettings();
    await openDialogWithPreview();
    const calls = daemon.endCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toEqual({ decidedBy: FALLBACK_WHO, confirmed: false });
  });
});

describe("#55 AC2 — ending is unmistakable: what ends, what is kept, what cannot be undone", () => {
  it("states what ends, from the daemon's own description — counts and the files themselves", async () => {
    stubDaemon();
    renderSettings();
    const dialog = await openDialogWithPreview();
    const ends = within(dialog).getByTestId("end-duo-ends");
    // Counts are the daemon's own lists, not the client's guess.
    expect(ends).toHaveTextContent("3 files");
    expect(ends).toHaveTextContent("4 files");
    expect(ends).toHaveTextContent(/stops answering/i);
    // Every paired device loses the duo — this one included — because the daemon drops every token.
    expect(ends).toHaveTextContent(/every paired device/i);
    // The files themselves, verbatim, one disclosure away — "exactly what happens" is checkable.
    const files = within(dialog).getByTestId("end-duo-files");
    for (const path of [...PREVIEW.storePaths, ...PREVIEW.duoDirPaths]) {
      expect(files).toHaveTextContent(path);
    }
  });

  it("states what is kept: the daemon's record of the ending, and (only when signed in) the workspace sign-in", async () => {
    stubDaemon();
    renderSettings({ session: SESSION });
    const dialog = await openDialogWithPreview();
    const kept = within(dialog).getByTestId("end-duo-kept");
    expect(kept).toHaveTextContent(/record/i);
    // The record names who decided it — and that is the signed-in member's own id when there is one.
    expect(kept).toHaveTextContent("@river:example.org");
    expect(kept).toHaveTextContent(/workspace/i);
  });

  it("does not talk about a workspace sign-in there is none of", async () => {
    stubDaemon();
    renderSettings({ session: null });
    const dialog = await openDialogWithPreview();
    expect(within(dialog).getByTestId("end-duo-kept")).not.toHaveTextContent(/workspace/i);
  });

  it("states what cannot be undone, in as many words", async () => {
    stubDaemon();
    renderSettings();
    const dialog = await openDialogWithPreview();
    const irreversible = within(dialog).getByTestId("end-duo-irreversible");
    expect(irreversible).toHaveTextContent(/cannot be undone/i);
    expect(irreversible).toHaveTextContent(/pairing again/i);
  });

  it("is an alert dialog, named for what it does, whose description is read on arrival", async () => {
    stubDaemon();
    renderSettings();
    const dialog = await openDialogWithPreview();
    expect(dialog).toHaveAttribute("role", "alertdialog");
    expect(dialog).toHaveAccessibleName("End this duo?");
    expect(dialog).toHaveAccessibleDescription(/for good/i);
  });

  it("#39 — every control in it is a touch target, and its headings nest under the dialog's own title", async () => {
    stubDaemon();
    renderSettings();
    const dialog = await openDialogWithPreview();
    for (const control of dialog.querySelectorAll("button, input, summary")) {
      expect(control.className, control.outerHTML).toMatch(/\bmin-h-11\b/);
    }
    // The title is the dialog's h2 and its three statements sit one level down — no skipped level.
    expect(within(dialog).getByRole("heading", { level: 2 })).toHaveTextContent("End this duo?");
    expect(within(dialog).getAllByRole("heading", { level: 3 }).map((h) => h.textContent)).toEqual([
      "What ends",
      "What is kept",
      "What cannot be undone",
    ]);
  });

  it("never claims more than the daemon reports: no revoking, no wiping the Mac, no channels", async () => {
    stubDaemon();
    renderSettings({ session: SESSION });
    const dialog = await openDialogWithPreview();
    expect(dialog.textContent ?? "").not.toMatch(/\b(revoke|wipe|uninstall|shut ?down|slack)\b/i);
  });

  it("takes a deliberate confirmation: End stays disabled until the phrase is typed exactly", async () => {
    const daemon = stubDaemon();
    renderSettings();
    await openDialogWithPreview();
    const confirm = screen.getByTestId("settings-end-duo-confirm");
    expect(confirm).toBeDisabled();
    for (const wrong of ["end", "EN", "END MY DUO", "yes", ""]) {
      typePhrase(wrong);
      expect(confirm).toBeDisabled();
    }
    // Clicking a disabled control, or pressing Enter in the field, sends nothing.
    fireEvent.click(confirm);
    fireEvent.keyDown(screen.getByTestId("settings-end-duo-phrase"), { key: "Enter" });
    expect(daemon.endCalls().filter((c) => c.body?.confirmed === true)).toHaveLength(0);
    typePhrase("END");
    expect(confirm).toBeEnabled();
  });

  it("the phrase is labelled for the field, and Cancel — not End — is where focus lands", async () => {
    stubDaemon();
    renderSettings();
    await openDialogWithPreview();
    expect(screen.getByLabelText(/type END to confirm/i)).toBe(screen.getByTestId("settings-end-duo-phrase"));
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("settings-end-duo-cancel")));
  });

  it("confirming sends exactly { decidedBy, confirmed: true } — the signed-in member's id when there is one", async () => {
    const daemon = stubDaemon();
    renderSettings({ session: SESSION });
    await openDialogWithPreview();
    typePhrase("END");
    fireEvent.click(screen.getByTestId("settings-end-duo-confirm"));
    await waitFor(() => expect(daemon.endCalls().filter((c) => c.body?.confirmed === true)).toHaveLength(1));
    expect(daemon.endCalls().at(-1)!.body).toEqual({ decidedBy: "@river:example.org", confirmed: true });
  });

  it("Cancel ends nothing: the dialog closes, no confirmed request was ever sent, and the phrase does not linger", async () => {
    const daemon = stubDaemon();
    const { onDuoEnded } = renderSettings();
    await openDialogWithPreview();
    typePhrase("END");
    fireEvent.click(screen.getByTestId("settings-end-duo-cancel"));
    await waitFor(() => expect(screen.queryByTestId("settings-end-duo-confirmation")).toBeNull());
    expect(daemon.endCalls().filter((c) => c.body?.confirmed === true)).toHaveLength(0);
    expect(onDuoEnded).not.toHaveBeenCalled();
    // A reopened dialog starts over: a phrase typed once is not a standing authorization.
    await openDialogWithPreview();
    expect(screen.getByTestId("settings-end-duo-phrase")).toHaveValue("");
    expect(screen.getByTestId("settings-end-duo-confirm")).toBeDisabled();
  });

  it("Escape is Cancel, and a stray click outside is not an answer", async () => {
    const daemon = stubDaemon();
    renderSettings();
    const dialog = await openDialogWithPreview();
    typePhrase("END");
    // Outside the panel: a real bubbling event, as Primitives.test does — Radix re-dispatches the original, and a synthesised PointerEvent carries no target through that path in happy-dom.
    document.body.dispatchEvent(new Event("pointerdown", { bubbles: true }));
    fireEvent.click(document.body);
    expect(screen.getByTestId("settings-end-duo-confirmation")).toBeInTheDocument();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("settings-end-duo-confirmation")).toBeNull());
    expect(daemon.endCalls().filter((c) => c.body?.confirmed === true)).toHaveLength(0);
    // Focus returns to the control that opened it.
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("settings-end-duo")));
  });

  it("if the daemon cannot say what would go, nothing can be confirmed — and nothing is claimed", async () => {
    const daemon = stubDaemon({
      preview: () => {
        throw new TypeError("fetch failed");
      },
    });
    renderSettings();
    const dialog = await openDialog();
    const problem = await within(dialog).findByTestId("settings-end-duo-error");
    expect(problem).toHaveTextContent(/nothing was ended/i);
    expect(within(dialog).queryByTestId("end-duo-ends")).toBeNull();
    // Nothing was described, so nothing is offered to confirm — no phrase to type, no button to press.
    expect(screen.queryByTestId("settings-end-duo-phrase")).toBeNull();
    expect(screen.queryByTestId("settings-end-duo-confirm")).toBeNull();
    expect(screen.getByTestId("settings-end-duo-cancel")).toBeEnabled();
    expect(daemon.endCalls().filter((c) => c.body?.confirmed === true)).toHaveLength(0);
  });

  it("a duo with nothing left to delete says so, and there is nothing to confirm", async () => {
    stubDaemon({ preview: () => new Response(JSON.stringify({ ...PREVIEW, storePaths: [], duoDirPaths: [] }), { status: 200 }) });
    renderSettings();
    const dialog = await openDialog();
    await within(dialog).findByTestId("end-duo-nothing");
    expect(within(dialog).getByTestId("end-duo-nothing")).toHaveTextContent(/nothing left to delete/i);
    expect(screen.queryByTestId("settings-end-duo-phrase")).toBeNull();
    expect(screen.queryByTestId("settings-end-duo-confirm")).toBeNull();
  });

  it("holds the dialog open while the end is in flight: Escape cannot bury a pending, irreversible request", async () => {
    let release!: (response: Response) => void;
    stubDaemon({ end: () => new Promise<Response>((resolve) => (release = resolve)) });
    const { onDuoEnded } = renderSettings();
    const dialog = await openDialogWithPreview();
    typePhrase("END");
    fireEvent.click(screen.getByTestId("settings-end-duo-confirm"));
    await waitFor(() => expect(screen.getByTestId("settings-end-duo-confirm")).toHaveTextContent(/ending/i));
    expect(screen.getByTestId("settings-end-duo-confirm")).toBeDisabled();
    expect(screen.getByTestId("settings-end-duo-cancel")).toBeDisabled();
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByTestId("settings-end-duo-confirmation")).toBeInTheDocument();
    // Only once the daemon answers does anything move on.
    expect(onDuoEnded).not.toHaveBeenCalled();
    await act(async () => release(new Response(JSON.stringify(DONE), { status: 200 })));
    await waitFor(() => expect(onDuoEnded).toHaveBeenCalledTimes(1));
  });
});

describe("#55 — the app hears of the end only when the daemon confirmed it", () => {
  it("a confirmed end reports up exactly once", async () => {
    stubDaemon();
    const { onDuoEnded } = renderSettings();
    await openDialogWithPreview();
    typePhrase("END");
    fireEvent.click(screen.getByTestId("settings-end-duo-confirm"));
    await waitFor(() => expect(onDuoEnded).toHaveBeenCalledTimes(1));
  });

  it("a refusal (4xx) is shown in the daemon's own words, and says the duo was not ended", async () => {
    stubDaemon({
      end: () => new Response(JSON.stringify({ error: { code: "bad_request", message: "Ending a duo requires naming who decided it." } }), { status: 400 }),
    });
    const { onDuoEnded } = renderSettings();
    await openDialogWithPreview();
    typePhrase("END");
    fireEvent.click(screen.getByTestId("settings-end-duo-confirm"));
    const problem = await screen.findByTestId("settings-end-duo-error");
    expect(problem).toHaveTextContent("Ending a duo requires naming who decided it.");
    expect(problem).toHaveTextContent(/was not ended/i);
    expect(onDuoEnded).not.toHaveBeenCalled();
    // The dialog stays, so the owner can cancel or try again on purpose.
    expect(screen.getByTestId("settings-end-duo-cancel")).toBeEnabled();
  });

  it("a 5xx is not 'not ended': the route deletes before it audits, so the client cannot know how far it got", async () => {
    stubDaemon({
      end: () => new Response(JSON.stringify({ error: { code: "Error", message: "ENOSPC: audit log write failed" } }), { status: 500 }),
    });
    const { onDuoEnded } = renderSettings();
    await openDialogWithPreview();
    typePhrase("END");
    fireEvent.click(screen.getByTestId("settings-end-duo-confirm"));
    const problem = await screen.findByTestId("settings-end-duo-error");
    expect(problem).toHaveTextContent("ENOSPC: audit log write failed");
    expect(problem).toHaveTextContent(/can't tell/i);
    expect(problem).not.toHaveTextContent(/was not ended/i);
    expect(onDuoEnded).not.toHaveBeenCalled();
  });

  it("an unanswered request is not 'not ended' either — and is not 'ended': the client says it cannot tell", async () => {
    stubDaemon({
      end: () => {
        throw new TypeError("fetch failed");
      },
    });
    const { onDuoEnded } = renderSettings();
    await openDialogWithPreview();
    typePhrase("END");
    fireEvent.click(screen.getByTestId("settings-end-duo-confirm"));
    const problem = await screen.findByTestId("settings-end-duo-error");
    expect(problem).toHaveTextContent(/can't tell/i);
    expect(onDuoEnded).not.toHaveBeenCalled();
  });

  it("an answer that is not a confirmation is not an ending", async () => {
    stubDaemon({ end: () => new Response(JSON.stringify(PREVIEW), { status: 200 }) });
    const { onDuoEnded } = renderSettings();
    await openDialogWithPreview();
    typePhrase("END");
    fireEvent.click(screen.getByTestId("settings-end-duo-confirm"));
    const problem = await screen.findByTestId("settings-end-duo-error");
    expect(problem).toHaveTextContent(/did not confirm/i);
    expect(onDuoEnded).not.toHaveBeenCalled();
  });
});

describe("#55 AC4 — offline cannot end anything (AR-15)", () => {
  it("with the daemon unreachable the control is disabled, says why, and opens nothing", async () => {
    const daemon = stubDaemon();
    const { client } = renderSettings();
    // The daemon goes quiet the way it does in life: every request dies at the network level —
    // including any read Settings already has in flight (the devices list), whose late success
    // would otherwise be a second, contradicting word on reachability.
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("fetch failed"))));
    await act(async () => {
      await client.refetchQueries().catch(() => undefined);
      await client
        .fetchQuery({ queryKey: ["probe"], queryFn: () => Promise.reject(new TypeError("fetch failed")), retry: false })
        .catch(() => undefined);
    });
    const trigger = screen.getByTestId("settings-end-duo");
    await waitFor(() => expect(trigger).toBeDisabled());
    expect(screen.getByTestId("settings-end-duo-offline")).toHaveTextContent(/asleep/i);
    expect(trigger).toHaveAccessibleDescription(/asleep/i);
    fireEvent.click(trigger);
    expect(screen.queryByTestId("settings-end-duo-confirmation")).toBeNull();
    expect(daemon.endCalls()).toHaveLength(0);
  });

  it("while the daemon is reachable there is no offline note", () => {
    stubDaemon();
    renderSettings();
    expect(screen.queryByTestId("settings-end-duo-offline")).toBeNull();
  });
});
