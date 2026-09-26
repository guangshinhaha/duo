import type { WorkspaceAccess } from "../workspace/access.js";
import { WorkspaceNotSetUp } from "./WorkspaceNotSetUp.js";

/**
 * #127: what a hosted build says about the workspace where a personal daemon
 * would offer the sign-in form. There is nothing to fill in and nothing to
 * press, so every state just says where things stand — in plain words: no
 * address, no account names, no protocol.
 */
export function HostedWorkspaceStatus({ access, className }: { access: WorkspaceAccess; className?: string }) {
  switch (access.kind) {
    case "hosted-not-set-up":
      return <WorkspaceNotSetUp className={className} />;
    case "hosted-retrying":
      return access.why === "pending" ? (
        <StatusNote
          className={className}
          state="pending"
          title="Setting things up…"
          detail="Your team's conversations will show up here in a moment. There's nothing to do on your side."
        />
      ) : (
        <StatusNote
          className={className}
          state="unreachable"
          title="Couldn't reach your conversations — trying again"
          detail="This will keep trying by itself. There's nothing to do on your side."
        />
      );
    case "hosted-signed-out":
      return (
        <StatusNote
          className={className}
          state="signed-out"
          title="You've been signed out"
          detail="Sign in again to see your conversations."
        />
      );
    case "hosted-connected":
      return <StatusNote className={className} state="connected" title="Connected" detail="Your team's conversations are here." />;
    default:
      return <StatusNote className={className} state="connecting" title="Connecting…" detail="Getting your conversations ready." />;
  }
}

function StatusNote({ className, state, title, detail }: { className?: string; state: string; title: string; detail: string }) {
  return (
    <div className={className} data-state={state} data-testid="workspace-status" role="status">
      <p className="type-body text-[var(--text)]">{title}</p>
      <p className="type-provenance text-[var(--muted)]">{detail}</p>
    </div>
  );
}
