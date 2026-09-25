import { useState } from "react";
import type { WorkspaceSession } from "../workspace/matrix.js";

/**
 * #62: the workspace sign-in form — the front door's primary card, and the
 * dialog Settings offers when a paired device later wants the workspace too.
 * The submit path runs through the Matrix seam (`workspace/matrix.ts`),
 * dynamically imported so nothing here loads matrix-js-sdk until the member
 * actually signs in, and hands the resulting session to `onSession`; the
 * homeserver's refusal stays on the form in its own words.
 */
export function WorkspaceSignInForm({ onSession }: { onSession: (session: WorkspaceSession) => void }) {
  const [homeserverUrl, setHomeserverUrl] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (pending) {
          return;
        }
        setPending(true);
        setError(null);
        void import("../workspace/matrix.js")
          .then(({ signIn }) => signIn(homeserverUrl, username, password))
          .then((session) => onSession(session))
          .catch((reason: unknown) => {
            // The seam's own messages are written for this spot (https
            // enforcement, the homeserver's refusal); anything else keeps
            // its Error text rather than a blank shrug.
            setError(reason instanceof Error ? reason.message : "Signing in failed — try again.");
          })
          .finally(() => setPending(false));
      }}
    >
      <label className="flex flex-col gap-1 type-body">
        Homeserver
        <input
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
          placeholder="https://matrix.example.com"
          value={homeserverUrl}
          onChange={(e) => {
            setHomeserverUrl(e.target.value);
            setError(null);
          }}
        />
      </label>
      <label className="flex flex-col gap-1 type-body">
        Username
        <input
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
          autoComplete="username"
          value={username}
          onChange={(e) => {
            setUsername(e.target.value);
            setError(null);
          }}
        />
      </label>
      <label className="flex flex-col gap-1 type-body">
        Password
        <input
          className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setError(null);
          }}
        />
      </label>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="setup-workspace-error">
          {error}
        </p>
      )}
      <button
        className="mt-2 inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
        type="submit"
        disabled={pending || !homeserverUrl.trim() || !username.trim() || !password}
      >
        Sign in
      </button>
    </form>
  );
}
