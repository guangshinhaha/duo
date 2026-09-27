import type { WorkspaceAccess } from "../workspace/access.js";
import { WorkspaceNotSetUp } from "./WorkspaceNotSetUp.js";

/**
 * #127: what a hosted build says about the workspace where a personal daemon
 * would offer the sign-in form. There is nothing to fill in and nothing to
 * press, so every state just says where things stand — in plain words: no
 * address, no account names, no protocol.
 *
 * Every state renders through the one `role="status"` element, so a screen
 * reader hears the text change in place (connecting, then trying again, then
 * connected) — a live region that appears already holding its text is not
 * reliably announced.
 */
export function HostedWorkspaceStatus({ access, className }: { access: WorkspaceAccess; className?: string }) {
  const note = noteFor(access);
  return (
    <div className={className} data-state={note.state} data-testid="workspace-status" role="status">
      {note.state === "not-set-up" ? (
        <WorkspaceNotSetUp />
      ) : (
        <>
          <p className="type-body text-[var(--text)]">{note.title}</p>
          <p className="type-provenance text-[var(--muted)]">{note.detail}</p>
        </>
      )}
    </div>
  );
}

function noteFor(access: WorkspaceAccess): { state: string; title: string; detail: string } {
  switch (access.kind) {
    case "hosted-not-set-up":
      return { state: "not-set-up", title: "", detail: "" };
    case "hosted-retrying":
      return access.why === "pending"
        ? {
            state: "pending",
            title: "Setting things up…",
            detail: "Your team's conversations will show up here in a moment. There's nothing to do on your side.",
          }
        : {
            state: "unreachable",
            title: "Couldn't reach your conversations — trying again",
            detail: "This will keep trying by itself. There's nothing to do on your side.",
          };
    case "hosted-signed-out":
      return { state: "signed-out", title: "You've been signed out", detail: "Sign in again to see your conversations." };
    case "hosted-connected":
      return { state: "connected", title: "Connected", detail: "Your team's conversations are here." };
    default:
      return { state: "connecting", title: "Connecting…", detail: "Getting your conversations ready." };
  }
}
