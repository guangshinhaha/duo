import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Settings } from "../src/routes/Settings.js";
import type { DuoApiConfig } from "../src/api/client.js";

const FULL_TOKEN = "c6jzoxVdOelvnJnGZRkFSnny_kxYcQ4wsERakvyXiXk";
const api: DuoApiConfig = { baseUrl: "http://100.64.1.5:7717", token: FULL_TOKEN };

function renderSettings(onConfigChange = vi.fn()) {
  render(
    <Settings
      api={api}
      session={null}
      onConfigChange={onConfigChange}
      onSignOut={vi.fn()}
      onPairDuo={vi.fn()}
      onWorkspaceSignIn={vi.fn()}
    />,
  );
  return onConfigChange;
}

describe("Settings — this device's connection to the daemon (issue #11)", () => {
  it("shows the daemon address and the token masked to its last few characters, never in full", () => {
    renderSettings();
    expect(screen.getByTestId("settings-address")).toHaveTextContent("http://100.64.1.5:7717");
    const token = screen.getByTestId("settings-token");
    expect(token).toHaveTextContent("•••• XiXk");
    expect(token.textContent).not.toContain(FULL_TOKEN);
    expect(screen.queryByText(FULL_TOKEN)).toBeNull();
  });

  it("saves a valid new address, normalized like Setup, keeping the token", () => {
    const onConfigChange = renderSettings();
    fireEvent.change(screen.getByLabelText("Daemon address"), { target: { value: "10.0.0.5:7717" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onConfigChange).toHaveBeenCalledWith({ baseUrl: "http://10.0.0.5:7717", token: FULL_TOKEN });
    expect(screen.queryByTestId("settings-error")).toBeNull();
  });

  it("refuses an unparseable address with Setup's wording and keeps the connection in effect", () => {
    const onConfigChange = renderSettings();
    fireEvent.change(screen.getByLabelText("Daemon address"), { target: { value: "not a url" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(screen.getByTestId("settings-error")).toHaveTextContent("doesn't look like a valid address — try something like 100.64.1.5:7717");
    expect(onConfigChange).not.toHaveBeenCalled();
    // The address actually in effect is unchanged.
    expect(screen.getByTestId("settings-address")).toHaveTextContent("http://100.64.1.5:7717");
  });

  it("unpair asks first, then forgets the device through the connection's single choke point", () => {
    const onConfigChange = renderSettings();
    fireEvent.click(screen.getByTestId("settings-unpair"));
    // The copy never claims revocation: the daemon has no route for it.
    expect(screen.getByTestId("settings-unpair-confirmation")).toHaveTextContent("daemon keeps its own record");
    expect(screen.getByTestId("settings-unpair-confirmation")).not.toHaveTextContent("revoke");
    fireEvent.click(screen.getByTestId("settings-unpair-confirm"));
    expect(onConfigChange).toHaveBeenCalledWith(null);
  });

  it("cancelling the unpair confirmation changes nothing", () => {
    const onConfigChange = renderSettings();
    fireEvent.click(screen.getByTestId("settings-unpair"));
    fireEvent.click(screen.getByTestId("settings-unpair-cancel"));
    expect(screen.queryByTestId("settings-unpair-confirmation")).toBeNull();
    expect(screen.getByTestId("settings-address")).toHaveTextContent("http://100.64.1.5:7717");
    expect(onConfigChange).not.toHaveBeenCalled();
  });
});
