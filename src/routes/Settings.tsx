import { useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import type { WorkspaceSession } from "../workspace/matrix.js";
import { useWorkspaceAccess } from "../workspace/access.js";
import { WorkspaceNotSetUp } from "../components/WorkspaceNotSetUp.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "../components/primitives/AlertDialog.js";
import { EndDuoSection } from "../components/EndDuoSection.js";
import { Timestamp } from "../components/Timestamp.js";
import { PairedDevices } from "../components/PairedDevices.js";
import { ConnectToClaude } from "../components/ConnectToClaude.js";
import { PairAnotherDevice } from "../components/PairAnotherDevice.js";
import { AskLinks } from "../components/AskLinks.js";
import { InvitePeople } from "../components/InvitePeople.js";
import { readHostedAccount } from "../api/hosted.js";
import { readThemePreference, setThemePreference, type ThemePreference } from "../theme.js";
import {
  clearMissed,
  isDndActive,
  readDndPrefs,
  readMissed,
  writeDndPrefs,
  type DndPrefs,
  type MissedArrival,
} from "../notificationPrefs.js";
import { normalizeBaseUrl } from "./Setup.js";

/** Masked to the last few characters — a paired token is a bearer credential, and a settings screen is exactly where screens get shared. */
function maskedToken(token: string): string {
  return `•••• ${token.slice(-4)}`;
}

/**
 * §3.1's `/settings`, widened to #62's two credentials: the workspace
 * sign-in (who you are, in an org) and this device's duo pairing (which
 * only you reach). Each is shown, startable, and endable INDEPENDENTLY —
 * signing out never unpairs, unpairing never signs out — and each empty
 * state offers its own door rather than apologizing. The address stays
 * editable with Setup's own validator and wording; "Forget this device" is
 * a local forget and its copy says so — it does not revoke. Revoking is the
 * Devices section's act (#48, over digital-duo #177's routes), which also
 * answers issue #11's old open question: the daemon now serves each
 * device's name, so the list shows them.
 */
export function Settings({
  api,
  session,
  onConfigChange,
  onSignOut,
  onPairDuo,
  onWorkspaceSignIn,
  onDuoEnded,
}: {
  api: DuoApiConfig | null;
  session: WorkspaceSession | null;
  onConfigChange: (config: DuoApiConfig | null) => void;
  onSignOut: () => void;
  onPairDuo: () => void;
  onWorkspaceSignIn: () => void;
  /** #55: the daemon confirmed the duo's end — App answers by leaving the pairing and saying so. */
  onDuoEnded?: () => void;
}) {
  const workspaceAccess = useWorkspaceAccess();
  const [addressInput, setAddressInput] = useState(api?.baseUrl ?? "");
  const [error, setError] = useState<string | null>(null);
  const [theme, setTheme] = useState<ThemePreference>(readThemePreference);
  // #69: this device's own rule. State read on mount (the route mounts
  // fresh per visit), written through — the log's read is the same story.
  const [dnd, setDnd] = useState<DndPrefs>(readDndPrefs);
  const [missed, setMissed] = useState<readonly MissedArrival[]>(readMissed);
  // Hosted mode: who this browser is signed in as (null on a paired-by-address app).
  const [account] = useState(readHostedAccount);

  const writeDnd = (next: DndPrefs): void => {
    writeDndPrefs(next);
    setDnd(next);
  };

  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6" data-testid="settings">
      {/* #39: the page's h1 above its sections' h2s — the sections name
          themselves; the page did not. */}
      <h1 className="type-heading sr-only">Settings</h1>
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-workspace">
        <h2 className="type-heading">Workspace</h2>
        {session ? (
          <>
            <div className="flex flex-col gap-1 type-provenance text-[var(--muted)]">
              {/* The user id verbatim — the protocol's own spelling and the
                  one stable identity; a display name is a claim, not a key. */}
              <div data-testid="settings-workspace-user">{session.userId}</div>
              <div data-testid="settings-workspace-homeserver">{session.homeserverUrl}</div>
            </div>
            <button
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
              data-testid="settings-sign-out"
              onClick={onSignOut}
            >
              Sign out
            </button>
          </>
        ) : workspaceAccess.kind === "hosted-pending" ? (
          <WorkspaceNotSetUp className="flex flex-col gap-1" />
        ) : (
          <>
            <p className="type-provenance text-[var(--muted)]">No workspace signed in on this device.</p>
            <button
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
              data-testid="settings-workspace-signin"
              onClick={onWorkspaceSignIn}
            >
              Sign in to a workspace
            </button>
          </>
        )}
      </section>
      {api ? (
        <section className="shape-container flex flex-col gap-3 p-4">
          <h2 className="type-heading">Connection</h2>
          <div className="flex flex-col gap-1 type-provenance text-[var(--muted)]">
            <div data-testid="settings-address">{api.baseUrl}</div>
            <div data-testid="settings-token">{maskedToken(api.token)}</div>
          </div>
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              const normalized = normalizeBaseUrl(addressInput);
              if (!normalized) {
                setError(`"${addressInput}" doesn't look like a valid address — try something like 100.64.1.5:7717`);
                return;
              }
              setError(null);
              // Token unchanged: a moved daemon keeps its paired devices;
              // re-pairing is the flow when the token itself is wrong.
              onConfigChange({ ...api, baseUrl: normalized });
            }}
          >
            <label className="type-provenance text-[var(--muted)]" htmlFor="settings-address-input">
              Daemon address
            </label>
            <div className="flex gap-2">
              <input
                className="min-h-11 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
                id="settings-address-input"
                onChange={(e) => setAddressInput(e.target.value)}
                value={addressInput}
              />
              <button
                className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
                disabled={!addressInput.trim()}
                type="submit"
              >
                Save
              </button>
            </div>
            {error && (
              <p className="type-provenance text-[var(--refused)]" data-testid="settings-error">
                {error}
              </p>
            )}
          </form>
        </section>
      ) : (
        <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-no-duo">
          <h2 className="type-heading">Connection</h2>
          <p className="type-provenance text-[var(--muted)]">No duo is connected on this device.</p>
          <button
            className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
            data-testid="settings-pair"
            onClick={onPairDuo}
          >
            Pair your duo
          </button>
        </section>
      )}

      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-notifications">
        <h2 className="type-heading">Notifications</h2>
        {/* #69: this device's own rule — what may interrupt HERE. The
            per-conversation half lives on the conversations themselves
            (server-side, every device); do-not-disturb is the member
            standing at this machine, so it stays on this machine. */}
        <p className="type-provenance text-[var(--muted)]" data-testid="dnd-status">
          {isDndActive(dnd, new Date()) ? "Do not disturb is on." : "Do not disturb is off."}
        </p>
        <button
          aria-pressed={dnd.manual}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
          data-testid="dnd-toggle"
          onClick={() => writeDnd({ ...dnd, manual: !dnd.manual })}
          type="button"
        >
          {dnd.manual ? "Turn off do not disturb" : "Turn on do not disturb"}
        </button>
        <div className="flex flex-wrap items-center gap-2">
          <label className="type-provenance text-[var(--muted)]" htmlFor="dnd-from-input">
            Quiet hours start
          </label>
          <input
            aria-label="Quiet hours start"
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
            data-testid="dnd-from"
            id="dnd-from-input"
            onChange={(e) => writeDnd({ ...dnd, from: e.target.value || null })}
            type="time"
            value={dnd.from ?? ""}
          />
          <span className="type-provenance text-[var(--muted)]">to</span>
          <label className="type-provenance text-[var(--muted)]" htmlFor="dnd-to-input">
            Quiet hours end
          </label>
          <input
            aria-label="Quiet hours end"
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
            data-testid="dnd-to"
            id="dnd-to-input"
            onChange={(e) => writeDnd({ ...dnd, to: e.target.value || null })}
            type="time"
            value={dnd.to ?? ""}
          />
        </div>
        {/* What the rule held back stays visible afterwards — the record,
            not the interruptions, replayed. */}
        <div className="flex flex-col gap-2" data-testid="missed-list">
          {missed.length === 0 ? (
            <p className="type-provenance text-[var(--muted)]">Nothing was held back.</p>
          ) : (
            <>
              {missed.map((entry) => (
                <a
                  className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-2 type-body text-[var(--text)]"
                  data-testid="missed-entry"
                  href={entry.hash}
                  key={`${entry.at}-${entry.hash}-${entry.body}`}
                >
                  <span className="mr-2 type-provenance text-[var(--muted)]">
                    <Timestamp iso={new Date(entry.at).toISOString()} />
                  </span>
                  {entry.body}
                </a>
              ))}
              <button
                className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
                data-testid="missed-clear"
                onClick={() => {
                  clearMissed();
                  setMissed([]);
                }}
                type="button"
              >
                Clear what was missed
              </button>
            </>
          )}
        </div>
      </section>

      <section className="shape-container flex flex-col gap-3 p-4">
        <h2 className="type-heading">Appearance</h2>
        {/* #35: light, dark, or follow the system — applied the moment it
            is picked and remembered for the next launch. "System" is the
            absence of a stamp: the OS's own prefers-color-scheme media
            query carries the palette from there, without a reload. */}
        <label className="type-provenance text-[var(--muted)]" htmlFor="settings-theme-input">
          Theme
        </label>
        <select
          aria-label="Theme"
          className="min-h-11 self-start rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
          data-testid="settings-theme"
          id="settings-theme-input"
          value={theme}
          onChange={(e) => {
            const next = e.target.value as ThemePreference;
            setThemePreference(next);
            setTheme(next);
          }}
        >
          <option value="system">Follow the system</option>
          <option value="light">Light</option>
          <option value="dark">Dark</option>
        </select>
      </section>

      <section className="shape-container flex flex-col gap-3 p-4">
        <h2 className="type-heading">Keyboard</h2>
        {/* #36: the one place the shortcuts are listed — only what
            exists, so the list can never promise a key nothing answers
            to. */}
        <dl className="flex flex-col gap-2 type-provenance text-[var(--muted)]">
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 type-identifier text-[var(--text)]">⌘K</dt>
            <dd>Search what your duo knows.</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 type-identifier text-[var(--text)]">J K</dt>
            <dd>Move to the next or previous chat — in Waiting on you, to the next one waiting.</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 type-identifier text-[var(--text)]">⌘ 1–9</dt>
            <dd>Open the first nine chats, your duo first.</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 type-identifier text-[var(--text)]">⏎ E X</dt>
            <dd>On your duo's draft: send it, edit it, dismiss it.</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 type-identifier text-[var(--text)]">Tab</dt>
            <dd>Reach a draft's actions.</dd>
          </div>
          <div className="flex gap-2">
            <dt className="w-16 shrink-0 type-identifier text-[var(--text)]">Esc</dt>
            <dd>Leave an open editor, dialog or menu.</dd>
          </div>
        </dl>
      </section>

      {api && <PairedDevices api={api} onConfigChange={onConfigChange} />}
      {api && <PairAnotherDevice api={api} />}
      {api && <ConnectToClaude api={api} />}
      {api && <AskLinks api={api} />}
      {api && account?.isAdmin && <InvitePeople api={api} origin={account.origin} />}

      {api && account && (
        <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-account">
          <h2 className="type-heading">Account</h2>
          <p className="type-body text-[var(--muted)]">
            Signed in to {account.ownerName}&apos;s duo with Google{account.isAdmin ? ", as an admin of this server" : ""}.
          </p>
          <p className="type-provenance text-[var(--muted)]">
            Signing out forgets this browser&apos;s connection; sign in again any time. To cut a browser off for good, revoke it under Devices.
          </p>
          <button
            className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
            data-testid="settings-sign-out"
            onClick={() => onConfigChange(null)}
            type="button"
          >
            Sign out
          </button>
        </section>
      )}

      {api && !account && (
        <section className="shape-container flex flex-col gap-3 p-4">
          <h2 className="type-heading">This device</h2>
          {/* #34: the destructive confirmation is the alert-dialog primitive
              — focus trap, Escape-equals-Cancel and the alertdialog role come
              with it; a stray click outside is not an answer. The copy and
              the two buttons are exactly what the inline version had. */}
          <AlertDialog>
            <AlertDialogTrigger
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)]"
              data-testid="settings-unpair"
            >
              Forget this device…
            </AlertDialogTrigger>
            <AlertDialogContent className="w-[calc(100vw-3rem)] max-w-md" data-testid="settings-unpair-confirmation">
              <AlertDialogTitle className="type-heading">Forget this device?</AlertDialogTitle>
              <AlertDialogDescription className="type-provenance text-[var(--muted)]">
                Forget this device's stored connection? The daemon keeps its own record — this removes the address and token here, on this device only. It does not revoke the token: to cut a device off, revoke it under Devices.
              </AlertDialogDescription>
              <div className="flex gap-2">
                <AlertDialogAction
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] bg-[var(--refused)] px-3 text-white"
                  data-testid="settings-unpair-confirm"
                  onClick={() => onConfigChange(null)}
                >
                  Forget this device
                </AlertDialogAction>
                <AlertDialogCancel
                  className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3"
                  data-testid="settings-unpair-cancel"
                >
                  Cancel
                </AlertDialogCancel>
              </div>
            </AlertDialogContent>
          </AlertDialog>
        </section>
      )}
      {/* #55: the kill switch — the one Settings control that acts on the
          daemon itself, not on this device. Last, and its own section. */}
      {api && <EndDuoSection api={api} session={session} onEnded={onDuoEnded} />}
    </div>
  );
}
