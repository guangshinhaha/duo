import { useState, type ReactNode } from "react";
import type { DuoApiConfig } from "../api/client.js";
import type { WorkspaceConnection, WorkspaceSession } from "../workspace/matrix.js";
import { isHostedAccess, useWorkspaceAccess } from "../workspace/access.js";
import { HostedWorkspaceStatus } from "../components/HostedWorkspaceStatus.js";
import { WorkspaceProfile } from "../components/WorkspaceProfile.js";
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
import { readHostedAccount, type AdminAccess } from "../api/hosted.js";
import { usePushSubscriptionStatus, useSubscribeToPush, useUnsubscribeFromPush } from "../api/queries.js";
import { MutationError } from "../components/MutationError.js";
import { readThemePreference, setThemePreference, type ThemePreference } from "../theme.js";
import { readUrlPreviewPref, writeUrlPreviewPref } from "../urlPreviewPrefs.js";
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
import { SETTINGS_SECTIONS, type SettingsSectionId } from "../shell/routes.js";

/** Masked to the last few characters — a paired token is a bearer credential, and a settings screen is exactly where screens get shared. */
function maskedToken(token: string): string {
  return `•••• ${token.slice(-4)}`;
}

/**
 * #308: the web-push control. A separate component (not inlined into
 * `Settings` itself) because its three hooks all need `api` non-null —
 * `Settings` renders this only once a duo is paired, which keeps the
 * hooks themselves unconditional here, same reasoning as `PairedDevices`
 * and `AskLinks` below.
 */
function PushNotificationsSection({ api }: { api: DuoApiConfig }) {
  const status = usePushSubscriptionStatus(true);
  const subscribe = useSubscribeToPush(api);
  const unsubscribe = useUnsubscribeFromPush(api);

  // Nothing is known yet about this browser's own `PushManager` state —
  // rendering neither button for a moment beats flashing the wrong one.
  // (`!status.data` alongside `isPending` is belt-and-braces for
  // TypeScript's narrowing, not a real second state: `pushSubscriptionStatus`
  // never throws, so this query has no error branch in practice.)
  if (status.isPending || !status.data) {
    return null;
  }
  if (!status.data.supported) {
    return (
      <p className="type-provenance text-[var(--muted)]" data-testid="push-unsupported">
        This browser doesn&apos;t support push notifications when the app is closed.
      </p>
    );
  }
  const subscribed = status.data.subscribed;
  return (
    <div className="flex flex-col gap-2" data-testid="push-notifications">
      <p className="type-provenance text-[var(--muted)]" data-testid="push-status">
        {subscribed
          ? "On for this browser — a draft waiting on you will notify you even with the app closed."
          : "Off. Turn this on to be notified even when the app is closed."}
      </p>
      <button
        className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
        data-testid="push-toggle"
        disabled={subscribe.isPending || unsubscribe.isPending}
        onClick={() => (subscribed ? unsubscribe.mutate() : subscribe.mutate())}
        type="button"
      >
        {subscribed ? "Turn off" : "Turn on"}
      </button>
      <MutationError error={subscribe.error ?? unsubscribe.error} />
    </div>
  );
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
  connection,
  onConfigChange,
  onSignOut,
  onPairDuo,
  onWorkspaceSignIn,
  onDuoEnded,
  section,
  admin,
}: {
  /**
   * The shell's answer to "is this device an admin of the server it is paired with" (`adminRoleOf`, from the
   * daemon's live role). The invite tool and the "as an admin" line follow it, never the stored sign-in flag, and
   * the token goes only to `admin.origin`, the paired server. Absent: no admin tools.
   */
  admin?: AdminAccess;
  /**
   * Which part of the settings is open: `"index"` is the list of sections, a
   * section id is that section alone, and no value at all is every section in
   * one page (what a caller that just wants the settings gets).
   */
  section?: SettingsSectionId | "index";
  api: DuoApiConfig | null;
  session: WorkspaceSession | null;
  /** The live workspace connection (#224's Profile section needs it to read and write the member's own name and picture) — null until one is up. */
  connection?: WorkspaceConnection | null;
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
  // #219: this member's own opt-in, off until they turn it on — never a
  // default this app chose for them (see urlPreviewPrefs.ts for why).
  const [urlPreviews, setUrlPreviews] = useState<boolean>(readUrlPreviewPref);
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

  const blocks: Record<SettingsSectionId, ReactNode> = {
    notifications: (
      <>
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

      {/* #308: web push — the one path that reaches this device while the
          app is fully closed, which nothing above this (a live tab, or the
          Tauri shell's own native path) can. Needs a paired duo: there is
          nowhere to register a subscription without one. */}
      {api && (
        <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-push">
          <h2 className="type-heading">Notify me when the app is closed</h2>
          <PushNotificationsSection api={api} />
        </section>
      )}

      </>
    ),
    appearance: (
      <>
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

      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-link-previews">
        <h2 className="type-heading">Link previews</h2>
        {/* #219: off unless this member turns it on, and nowhere else to
            turn it on — not per room, not for everyone. A preview card
            means the homeserver itself fetches whatever link was posted,
            server-side, before this member ever sees a card: every link
            anyone posts becomes a request the org's infrastructure makes,
            timed to the message. This app's gov member base can't have
            that default to on, so it doesn't — this is each member's own
            call, and it stays off until they make it. */}
        <p className="type-provenance text-[var(--muted)]">
          Shows a title, description and image under a link, when the one you&apos;re signed in to has them. Building one means the
          workspace itself fetches the page you were sent — so this is off until you turn it on, and it only ever applies to you.
        </p>
        <button
          aria-pressed={urlPreviews}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
          data-testid="settings-link-previews-toggle"
          onClick={() => {
            const next = !urlPreviews;
            writeUrlPreviewPref(next);
            setUrlPreviews(next);
          }}
          type="button"
        >
          {urlPreviews ? "Turn off link previews" : "Turn on link previews"}
        </button>
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

      </>
    ),
    profile: connection ? (
      <WorkspaceProfile connection={connection} />
    ) : (
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-profile">
        <h2 className="type-heading">Profile</h2>
        <p className="type-provenance text-[var(--muted)]">
          Sign in to a workspace to set your name and picture there.
        </p>
      </section>
    ),
    devices: api ? (
      <>
        <PairedDevices api={api} onConfigChange={onConfigChange} />
        <PairAnotherDevice api={api} />
      </>
    ) : null,
    links: api ? <AskLinks api={api} /> : null,
    claude: api ? <ConnectToClaude api={api} /> : null,
    advanced: (
      <>
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-workspace">
        <h2 className="type-heading">Workspace</h2>
        {isHostedAccess(workspaceAccess) ? (
          // #127: on a hosted build the workspace is connected for you, so
          // there is no address or account name to show and nothing to press:
          // signing out of the app ends it too.
          <HostedWorkspaceStatus access={workspaceAccess} className="flex flex-col gap-1" />
        ) : session ? (
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

        {api && admin?.role === "super" && admin.origin && <InvitePeople api={api} origin={admin.origin} />}
      {api && account && (
        <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-account">
          <h2 className="type-heading">Account</h2>
          <p className="type-body text-[var(--muted)]">
            Signed in to {account.ownerName}&apos;s duo with Google{admin?.role === "super" ? ", as an admin of this server" : ""}.
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
      </>
    ),
    end: api ? (
      <>
      {/* #55: the kill switch — the one Settings control that acts on the
          daemon itself, not on this device. Last, and its own section. */}
      {api && <EndDuoSection api={api} session={session} onEnded={onDuoEnded} />}
      </>
    ) : null,
  };
  const visible = SETTINGS_SECTIONS.filter((entry) => !entry.needsDuo || api !== null);

  // The whole page, every section in order — what a caller that names no section gets.
  if (section === undefined) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-6 p-6" data-testid="settings">
        <h1 className="type-heading sr-only">Settings</h1>
        {visible.map((entry) => (
          <div className="flex flex-col gap-6" key={entry.id}>
            {blocks[entry.id]}
          </div>
        ))}
      </div>
    );
  }

  // The index: what the settings are, in plain words, one line each.
  if (section === "index" || !visible.some((entry) => entry.id === section)) {
    return (
      <div className="mx-auto flex max-w-xl flex-col gap-4 p-6" data-testid="settings-index">
        <h1 className="type-heading">Settings</h1>
        {api === null && (
          <p className="type-provenance text-[var(--muted)]" data-testid="settings-index-no-duo">
            No duo is connected on this device.{" "}
            <a className="underline" href="#settings/advanced">
              Pair your duo under Advanced
            </a>
            .
          </p>
        )}
        <nav aria-label="Settings sections" className="flex flex-col gap-2">
          {visible.map((entry) => (
            <a
              className="shape-entry flex min-h-11 flex-col gap-1 px-4 py-3"
              data-testid={`settings-link-${entry.id}`}
              href={`#settings/${entry.id}`}
              key={entry.id}
            >
              <span className="type-body text-[var(--text)]">{entry.label}</span>
              <span className="type-provenance text-[var(--muted)]">{entry.about}</span>
            </a>
          ))}
        </nav>
      </div>
    );
  }

  const current = visible.find((entry) => entry.id === section)!;
  return (
    <div className="mx-auto flex max-w-xl flex-col gap-6 p-6" data-section={section} data-testid="settings">
      <div className="flex flex-col gap-1">
        <a className="inline-flex min-h-11 items-center self-start type-provenance text-[var(--muted)] underline" data-testid="settings-back" href="#settings">
          All settings
        </a>
        <h1 className="type-heading">{current.label}</h1>
      </div>
      {blocks[section]}
    </div>
  );
}
