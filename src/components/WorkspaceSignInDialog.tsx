import type { WorkspaceSession } from "../workspace/matrix.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./primitives/Dialog.js";
import { useWorkspaceAccess } from "../workspace/access.js";
import { WorkspaceSignInForm } from "./WorkspaceSignInForm.js";

/**
 * #62: the workspace sign-in, as an overlay — what Settings offers when a
 * device paired to a duo before the workspace existed (or signed out and
 * wants back in). The same form component the front door renders; the
 * session lands through the same choke point. A hosted build never opens it
 * (#127): there is no homeserver form to show.
 */
export function WorkspaceSignInDialog({
  open,
  onOpenChange,
  onSession,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSession: (session: WorkspaceSession) => void;
}) {
  if (useWorkspaceAccess().kind === "hosted-pending") {
    return null;
  }
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="workspace-signin-dialog">
        <DialogTitle className="type-heading">Sign in to your workspace</DialogTitle>
        <DialogDescription className="sr-only">Sign this device in to your workspace as its member.</DialogDescription>
        <div className="flex flex-col gap-3">
          <p className="type-body text-[var(--muted)]">Who you are, in your org — separate from your duo, which only you reach.</p>
          <WorkspaceSignInForm onSession={onSession} />
        </div>
      </DialogContent>
    </Dialog>
  );
}
