/**
 * #127: what a hosted build shows where a personal daemon would offer the
 * workspace sign-in form — no homeserver, no username, no password, and no
 * jargon: the person has nothing to fill in, so the note just says so.
 */
export function WorkspaceNotSetUp({ className }: { className?: string }) {
  return (
    <div className={className} data-testid="workspace-not-set-up">
      <p className="type-body text-[var(--text)]">Workspace isn&apos;t set up yet</p>
      <p className="type-provenance text-[var(--muted)]">
        Your team&apos;s conversations will show up here once it is. There&apos;s nothing to do on your side.
      </p>
    </div>
  );
}
