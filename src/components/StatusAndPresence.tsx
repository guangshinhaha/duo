import { useEffect, useState, type FormEvent } from "react";
import type { OwnStatus, WorkspaceConnection } from "../workspace/matrix.js";

/** "Mon 12 Oct, 09:00" in this device's zone — the same rendering `awayUntilWords` (`profile/Away.tsx`) uses for an end time, so the two features read alike. */
function statusUntilWords(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

/** One hour from now, as a `datetime-local` value — a short, ordinary default; the owner can always pick further out. */
function defaultUntilInput(now: Date = new Date()): string {
  const next = new Date(now.getTime() + 60 * 60 * 1000);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${next.getFullYear()}-${pad(next.getMonth() + 1)}-${pad(next.getDate())}T${pad(next.getHours())}:${pad(next.getMinutes())}`;
}

/**
 * #287: a short status with an end time ("In a meeting until 3pm"),
 * colleagues read beside your name wherever presence shows (#287's own
 * `presenceOf`/`statusMessageOf`, the same door every colleague's own
 * status rides through) — and whether your own presence is hidden from
 * them at all. Both live on this account (`connection.status`/
 * `presenceHidden`), so a status set here, or on another signed-in
 * device, reads the same everywhere; a status whose time has passed reads
 * as none at all without anyone having to come back and clear it by hand.
 */
export function StatusAndPresence({ connection }: { connection: WorkspaceConnection }) {
  const [loading, setLoading] = useState(true);
  const [status, setStatus] = useState<OwnStatus | null>(null);
  const [hidden, setHidden] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [message, setMessage] = useState("");
  const [until, setUntil] = useState(defaultUntilInput);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [hiddenSaving, setHiddenSaving] = useState(false);
  const [hiddenError, setHiddenError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    void Promise.all([connection.status?.() ?? Promise.resolve(null), connection.presenceHidden?.() ?? Promise.resolve(false)])
      .then(([loadedStatus, loadedHidden]) => {
        if (cancelled) {
          return;
        }
        setStatus(loadedStatus);
        setHidden(loadedHidden);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(error instanceof Error ? error.message : "Couldn't load your status.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });
    // Lives for as long as this section does — another signed-in device's
    // write, or this one's own end time arriving, both show up here with
    // no manual refresh.
    const unsubscribe = connection.subscribeStatus?.(setStatus);
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [connection]);

  const save = (e: FormEvent): void => {
    e.preventDefault();
    const trimmed = message.trim();
    if (trimmed === "" || until === "" || saving) {
      return;
    }
    setSaving(true);
    setSaveError(null);
    void connection
      .setStatus?.({ message: trimmed, until: new Date(until).toISOString() })
      .then(() => setMessage(""))
      .catch((error: unknown) => setSaveError(error instanceof Error ? error.message : "Couldn't set your status."))
      .finally(() => setSaving(false));
  };

  const clear = (): void => {
    setSaving(true);
    setSaveError(null);
    void connection
      .setStatus?.(null)
      .catch((error: unknown) => setSaveError(error instanceof Error ? error.message : "Couldn't clear your status."))
      .finally(() => setSaving(false));
  };

  const toggleHidden = (): void => {
    const next = !hidden;
    setHiddenSaving(true);
    setHiddenError(null);
    void connection
      .setPresenceHidden?.(next)
      .then(() => setHidden(next))
      .catch((error: unknown) => setHiddenError(error instanceof Error ? error.message : "Couldn't change that."))
      .finally(() => setHiddenSaving(false));
  };

  if (loading) {
    return (
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-status">
        <h2 className="type-heading">Status &amp; presence</h2>
        <p className="type-provenance text-[var(--muted)]" role="status">
          Loading…
        </p>
      </section>
    );
  }

  if (loadError !== null) {
    return (
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-status">
        <h2 className="type-heading">Status &amp; presence</h2>
        <p className="type-provenance text-[var(--refused)]" data-testid="status-load-error" role="status">
          {loadError}
        </p>
      </section>
    );
  }

  return (
    <section className="shape-container flex flex-col gap-4 p-4" data-testid="settings-status">
      <h2 className="type-heading">Status &amp; presence</h2>
      <div className="flex flex-col gap-2">
        <h3 className="type-heading">Status</h3>
        <p className="type-provenance text-[var(--muted)]">A short line colleagues see beside your name, until it clears itself.</p>
        {status !== null ? (
          <div className="flex flex-col gap-2" data-testid="status-active">
            <p className="type-body" data-testid="status-active-message">
              “{status.message}” — until <span data-testid="status-active-until">{statusUntilWords(status.until)}</span>
            </p>
            <button
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body disabled:opacity-40"
              data-testid="status-clear"
              disabled={saving}
              onClick={clear}
              type="button"
            >
              Clear status
            </button>
          </div>
        ) : (
          <form className="flex flex-col gap-2" data-testid="status-form" onSubmit={save}>
            <input
              aria-label="Status"
              className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 type-body text-[var(--text)]"
              data-testid="status-message-input"
              onChange={(e) => setMessage(e.target.value)}
              placeholder="In a meeting"
              value={message}
            />
            <label className="flex flex-col gap-1 type-body">
              Until
              <input
                aria-label="Status until"
                className="min-h-11 self-start rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-2"
                data-testid="status-until-input"
                onChange={(e) => setUntil(e.target.value)}
                type="datetime-local"
                value={until}
              />
            </label>
            <button
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-body text-[var(--bg)] disabled:opacity-40"
              data-testid="status-set"
              disabled={saving || message.trim() === "" || until === ""}
              type="submit"
            >
              {saving ? "Setting…" : "Set status"}
            </button>
          </form>
        )}
        {saveError !== null && (
          <p className="type-provenance text-[var(--refused)]" data-testid="status-error" role="status">
            {saveError}
          </p>
        )}
      </div>
      <div className="flex flex-col gap-2">
        <h3 className="type-heading">Presence</h3>
        <p className="type-provenance text-[var(--muted)]">
          {hidden ? "Colleagues don't see whether you're online." : "Colleagues see when you're online or away, the ordinary way."}
        </p>
        <button
          aria-pressed={hidden}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body disabled:opacity-40"
          data-testid="presence-hidden-toggle"
          disabled={hiddenSaving}
          onClick={toggleHidden}
          type="button"
        >
          {hidden ? "Show my presence" : "Hide my presence"}
        </button>
        {hiddenError !== null && (
          <p className="type-provenance text-[var(--refused)]" data-testid="presence-hidden-error" role="status">
            {hiddenError}
          </p>
        )}
      </div>
    </section>
  );
}
