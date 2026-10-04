import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceProfile } from "../src/components/WorkspaceProfile.js";
import type { WorkspaceConnection } from "../src/workspace/matrix.js";

/*
 * #224: set your own name and picture in the workspace. `profile()`,
 * `setDisplayName` and `setAvatarUrl` are the three verbs this screen
 * drives — matrix.ts's own seam test (WorkspaceMatrixSeam.test.ts) pins
 * what they do to the SDK; this file pins what the screen does with them:
 * shows what the homeserver already has, saves what the member changes,
 * and on a refusal says why without losing what they typed.
 */

function fakeConnection(
  over: Partial<{
    name: string | null;
    avatarUrl: string | null;
    setDisplayName: WorkspaceConnection["setDisplayName"];
    setAvatarUrl: WorkspaceConnection["setAvatarUrl"];
    profile: WorkspaceConnection["profile"];
    loadMedia: WorkspaceConnection["loadMedia"];
  }> = {},
): WorkspaceConnection {
  return {
    profile: over.profile ?? vi.fn(async () => ({ name: over.name ?? null, avatarUrl: over.avatarUrl ?? null })),
    setDisplayName: over.setDisplayName ?? vi.fn(async () => {}),
    setAvatarUrl: over.setAvatarUrl ?? vi.fn(async () => "mxc://workspace.example/new-avatar"),
    loadMedia: over.loadMedia ?? vi.fn(async () => new Blob(["bytes"], { type: "image/png" })),
  } as unknown as WorkspaceConnection;
}

// jsdom has no object URLs: a numbered stand-in is enough to prove the
// preview wires a blob at all, and that it ties back to the right fetch.
let objectUrlSequence = 0;
beforeEach(() => {
  objectUrlSequence = 0;
  Object.assign(URL, { createObjectURL: () => `blob:mock/${(objectUrlSequence += 1)}`, revokeObjectURL: () => {} });
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("loading the current profile", () => {
  it("shows the homeserver's own name in the field once it answers", async () => {
    const connection = fakeConnection({ name: "Ana Ng" });
    render(<WorkspaceProfile connection={connection} />);

    expect(await screen.findByTestId("profile-name-input")).toHaveValue("Ana Ng");
    expect(connection.profile).toHaveBeenCalledTimes(1);
  });

  it("an unset name is an empty field, not a placeholder guess", async () => {
    const connection = fakeConnection({ name: null });
    render(<WorkspaceProfile connection={connection} />);

    expect(await screen.findByTestId("profile-name-input")).toHaveValue("");
  });

  it("a set picture is fetched through the member's own authenticated door and shown", async () => {
    const connection = fakeConnection({ avatarUrl: "mxc://workspace.example/ana" });
    render(<WorkspaceProfile connection={connection} />);

    const img = await screen.findByTestId("profile-avatar-preview");
    expect(connection.loadMedia).toHaveBeenCalledWith("mxc://workspace.example/ana");
    expect(img).toHaveAttribute("src", expect.stringMatching(/^blob:/));
    expect(screen.queryByTestId("profile-avatar-placeholder")).toBeNull();
  });

  it("no picture set shows a placeholder, never a broken image", async () => {
    const connection = fakeConnection({ avatarUrl: null });
    render(<WorkspaceProfile connection={connection} />);

    await screen.findByTestId("profile-name-input");
    expect(screen.getByTestId("profile-avatar-placeholder")).toBeInTheDocument();
    expect(screen.queryByTestId("profile-avatar-preview")).toBeNull();
  });

  it("a profile that fails to load says so and offers to try again", async () => {
    const profile = vi.fn().mockRejectedValueOnce(new Error("The workspace didn't answer in time."));
    const connection = fakeConnection({ profile });
    render(<WorkspaceProfile connection={connection} />);

    expect(await screen.findByTestId("profile-load-error")).toHaveTextContent("didn't answer in time");
    expect(screen.queryByTestId("profile-name-input")).toBeNull();
  });
});

describe("changing the display name", () => {
  it("saves the typed name and reflects it once the homeserver accepts", async () => {
    const setDisplayName = vi.fn(async () => {});
    const connection = fakeConnection({ name: "Ana", setDisplayName });
    render(<WorkspaceProfile connection={connection} />);
    await screen.findByTestId("profile-name-input");

    fireEvent.change(screen.getByTestId("profile-name-input"), { target: { value: "Ana Ng" } });
    fireEvent.click(screen.getByTestId("profile-name-save"));

    await waitFor(() => expect(setDisplayName).toHaveBeenCalledWith("Ana Ng"));
    expect(await screen.findByTestId("profile-name-saved")).toBeInTheDocument();
    expect(screen.getByTestId("profile-name-input")).toHaveValue("Ana Ng");
  });

  it("the save button is disabled until the name actually changed", async () => {
    const connection = fakeConnection({ name: "Ana" });
    render(<WorkspaceProfile connection={connection} />);
    await screen.findByTestId("profile-name-input");

    expect(screen.getByTestId("profile-name-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("profile-name-input"), { target: { value: "Ana " } });
    expect(screen.getByTestId("profile-name-save")).toBeDisabled(); // trims to the same name
    fireEvent.change(screen.getByTestId("profile-name-input"), { target: { value: "" } });
    expect(screen.getByTestId("profile-name-save")).toBeDisabled(); // an empty name is never offered
  });

  it("a refused name change states the reason and keeps exactly what was typed", async () => {
    const setDisplayName = vi.fn().mockRejectedValueOnce(new Error("The workspace said: Display names may not be empty."));
    const connection = fakeConnection({ name: "Ana", setDisplayName });
    render(<WorkspaceProfile connection={connection} />);
    await screen.findByTestId("profile-name-input");

    fireEvent.change(screen.getByTestId("profile-name-input"), { target: { value: "Someone New" } });
    fireEvent.click(screen.getByTestId("profile-name-save"));

    expect(await screen.findByTestId("profile-name-error")).toHaveTextContent("Display names may not be empty");
    // The typed value survives the refusal — nothing here resets it to the old name or blanks it.
    expect(screen.getByTestId("profile-name-input")).toHaveValue("Someone New");
    expect(screen.queryByTestId("profile-name-saved")).toBeNull();
  });
});

describe("changing the picture", () => {
  function pngFile(name = "me.png", size = 1024): File {
    return new File([new Uint8Array(size)], name, { type: "image/png" });
  }

  it("uploads the picked image and shows it once the homeserver accepts", async () => {
    const setAvatarUrl = vi.fn(async () => "mxc://workspace.example/fresh");
    const loadMedia = vi.fn(async (url: string) => (url === "mxc://workspace.example/fresh" ? new Blob(["x"], { type: "image/png" }) : null));
    const connection = fakeConnection({ avatarUrl: null, setAvatarUrl, loadMedia });
    render(<WorkspaceProfile connection={connection} />);
    await screen.findByTestId("profile-avatar-placeholder");

    fireEvent.change(screen.getByTestId("profile-avatar-input"), { target: { files: [pngFile()] } });

    await waitFor(() => expect(setAvatarUrl).toHaveBeenCalled());
    const [staged] = setAvatarUrl.mock.calls[0]!;
    expect(staged).toMatchObject({ name: "me.png", mimeType: "image/png", size: 1024 });
    expect(await screen.findByTestId("profile-avatar-preview")).toHaveAttribute("src", expect.stringMatching(/^blob:/));
  });

  it("refuses a non-image file without ever calling the upload", async () => {
    const setAvatarUrl = vi.fn(async () => "mxc://workspace.example/fresh");
    const connection = fakeConnection({ avatarUrl: null, setAvatarUrl });
    render(<WorkspaceProfile connection={connection} />);
    await screen.findByTestId("profile-avatar-placeholder");

    const text = new File([new Uint8Array(10)], "notes.txt", { type: "text/plain" });
    fireEvent.change(screen.getByTestId("profile-avatar-input"), { target: { files: [text] } });

    expect(await screen.findByTestId("profile-avatar-error")).toHaveTextContent("isn't a picture");
    expect(setAvatarUrl).not.toHaveBeenCalled();
  });

  it("refuses an image over the share limit with the same wording sharing uses, and keeps the old picture", async () => {
    const setAvatarUrl = vi.fn(async () => "mxc://workspace.example/fresh");
    const connection = fakeConnection({ avatarUrl: "mxc://workspace.example/old", setAvatarUrl });
    render(<WorkspaceProfile connection={connection} />);
    await screen.findByTestId("profile-avatar-preview");

    const tooBig = pngFile("huge.png", 9 * 1024 * 1024);
    fireEvent.change(screen.getByTestId("profile-avatar-input"), { target: { files: [tooBig] } });

    expect(await screen.findByTestId("profile-avatar-error")).toHaveTextContent(/caps? at/);
    expect(setAvatarUrl).not.toHaveBeenCalled();
    // The picture shown is still the one the homeserver already had.
    expect(screen.getByTestId("profile-avatar-preview")).toBeInTheDocument();
  });

  it("a refused upload states the reason and leaves the previous picture showing", async () => {
    const setAvatarUrl = vi.fn().mockRejectedValueOnce(new Error("Your picture is over the workspace's own upload limit."));
    const connection = fakeConnection({ avatarUrl: "mxc://workspace.example/old", setAvatarUrl });
    render(<WorkspaceProfile connection={connection} />);
    await screen.findByTestId("profile-avatar-preview");

    fireEvent.change(screen.getByTestId("profile-avatar-input"), { target: { files: [pngFile()] } });

    expect(await screen.findByTestId("profile-avatar-error")).toHaveTextContent("over the workspace's own upload limit");
    expect(screen.getByTestId("profile-avatar-preview")).toBeInTheDocument();
  });
});
