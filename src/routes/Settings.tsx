import { useState, type ReactNode } from "react";
import type { DuoApiConfig } from "../api/client.js";
import type { WorkspaceConnection, WorkspaceSession } from "../workspace/matrix.js";
import { isHostedAccess, useWorkspaceAccess } from "../workspace/access.js";
import { HostedWorkspaceStatus } from "../components/HostedWorkspaceStatus.js";
import { WorkspaceProfile } from "../components/WorkspaceProfile.js";
import { KeywordAlerts } from "../components/KeywordAlerts.js";
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
import { PrivacyControls } from "../components/PrivacyControls.js";
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
import { readFactCheckPref, writeFactCheckPref } from "../factCheckPrefs.js";
import { readCatchUpEnabled, writeCatchUpEnabled } from "../catchUpPrefs.js";
import { readDailyBriefEnabled, writeDailyBriefEnabled } from "../dailyBriefPrefs.js";
import { readSuggestionChipsEnabled, writeSuggestionChipsEnabled } from "../suggestionsPrefs.js";
import { readTypingPref, writeTypingPref } from "../typingPrefs.js";
import { readPrivateReceiptsPref, writePrivateReceiptsPref } from "../readReceiptPrefs.js";
import {
  NOTIFICATION_CATEGORIES,
  readNotificationCategoryPrefs,
  writeNotificationCategoryPrefs,
  type CategorySetting,
  type NotificationCategoryPrefs,
} from "../notificationCategoryPrefs.js";
import { SendingSettings } from "../components/SendingSettings.js";
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
  // #264: off until this member turns it on — same "their own call, on
  // their own device" default as link previews above.
  const [factCheck, setFactCheck] = useState<boolean>(readFactCheckPref);
  // duo#280/#281: on by default — a new catch-up setting must never
  // silently hide a card or a sidebar line that would otherwise meet its
  // own threshold, the same stance #285's typing setting takes below.
  const [catchUpEnabled, setCatchUpEnabled] = useState<boolean>(readCatchUpEnabled);
  // duo#282: on by default, same stance as the catch-up switch above.
  const [dailyBriefEnabled, setDailyBriefEnabled] = useState<boolean>(readDailyBriefEnabled);
  const [suggestionChipsEnabled, setSuggestionChipsEnabled] = useState<boolean>(readSuggestionChipsEnabled);
  const [sendTyping, setSendTyping] = useState<boolean>(readTypingPref);
  // #286: off (ordinary, visible receipts — this app's behavior since #63)
  // until this member turns it on — same "their own call, on their own
  // device" default as the two above.
  const [privateReceipts, setPrivateReceipts] = useState<boolean>(readPrivateReceiptsPref);
  // #69: this device's own rule. State read on mount (the route mounts
  // fresh per visit), written through — the log's read is the same story.
  const [dnd, setDnd] = useState<DndPrefs>(readDndPrefs);
  const [missed, setMissed] = useState<readonly MissedArrival[]>(readMissed);
  // #309: each of the four categories' own immediate/batched/off setting.
  const [notificationCategories, setNotificationCategories] = useState<NotificationCategoryPrefs>(readNotificationCategoryPrefs);
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

      {/* #309: a category on every notification, each with its own setting
          — drafts ready, mentions, passed-on questions and direct messages,
          independently immediate, batched into one summary every few
          minutes, or off. Immediate is every category's default: a new
          setting must never silently change what already ships. */}
      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-notification-categories">
        <h2 className="type-heading">Notification categories</h2>
        <p className="type-provenance text-[var(--muted)]">
          Choose how you&apos;re told about each kind — right away, batched into one summary every few minutes, or not at
          all.
        </p>
        <div className="flex flex-col gap-2">
          {NOTIFICATION_CATEGORIES.map((category) => (
            <div className="flex flex-wrap items-center gap-2" key={category.id}>
              <label className="type-provenance min-w-32 text-[var(--muted)]" htmlFor={`notif-category-${category.id}-input`}>
                {category.label}
              </label>
              <select
                aria-label={category.label}
                className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 text-[var(--text)]"
                data-testid={`notif-category-${category.id}`}
                id={`notif-category-${category.id}-input`}
                onChange={(e) => {
                  const next = { ...notificationCategories, [category.id]: e.target.value as CategorySetting };
                  writeNotificationCategoryPrefs(next);
                  setNotificationCategories(next);
                }}
                value={notificationCategories[category.id]}
              >
                <option value="immediate">Immediate</option>
                <option value="batched">Batched</option>
                <option value="off">Off</option>
              </select>
            </div>
          ))}
        </div>
      </section>

      {/* #310: keyword alerts — managed here because the list is this
          account's own Matrix content push rules, which needs a live
          workspace connection, not a paired duo (unlike the push section
          below). A member signed in with no duo paired still gets to set
          these. */}
      {connection ? (
        <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-keyword-alerts">
          <h2 className="type-heading">Keyword alerts</h2>
          <KeywordAlerts connection={connection} />
        </section>
      ) : (
        <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-keyword-alerts">
          <h2 className="type-heading">Keyword alerts</h2>
          <p className="type-provenance text-[var(--muted)]">Sign in to a workspace to set keyword alerts.</p>
        </section>
      )}

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

      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-fact-check">
        <h2 className="type-heading">Quiet fact-check</h2>
        {/* #264: off unless this member turns it on, same stance as link
            previews just above — a flag is shown only in the composer
            this member is typing in, and only after they've opted in
            here. At most one flag at a time, only above a real
            confidence threshold (the daemon's own call); sending is
            never blocked by it, on or off. */}
        <p className="type-provenance text-[var(--muted)]">
          While you're typing your own reply, your duo quietly checks it against what it already knows — a wrong date, number, or
          commitment gets a subtle underline with its source, nothing more. Off until you turn it on, and it never blocks sending.
        </p>
        <button
          aria-pressed={factCheck}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
          data-testid="settings-fact-check-toggle"
          onClick={() => {
            const next = !factCheck;
            writeFactCheckPref(next);
            setFactCheck(next);
          }}
          type="button"
        >
          {factCheck ? "Turn off quiet fact-check" : "Turn on quiet fact-check"}
        </button>
      </section>

      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-summaries">
        <h2 className="type-heading">Summaries</h2>
        {/* duo#280/#281 (epic #279): the one switch for both catch-up
            surfaces — the card above the unread line in a busy
            conversation, and the one-line gist under a conversation in
            the list. On by default; #280's card has its own per-room off
            as well, next to the conversation itself. */}
        <p className="type-provenance text-[var(--muted)]">
          When a conversation gets busy while you're away, your duo summarizes what you missed — a short card above the unread
          line, and a one-line gist in the chat list. On by default; turn it off here, or per-conversation from that conversation's
          own menu.
        </p>
        <button
          aria-pressed={catchUpEnabled}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
          data-testid="settings-summaries-toggle"
          onClick={() => {
            const next = !catchUpEnabled;
            writeCatchUpEnabled(next);
            setCatchUpEnabled(next);
          }}
          type="button"
        >
          {catchUpEnabled ? "Turn off summaries" : "Turn on summaries"}
        </button>
      </section>

      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-daily-brief">
        <h2 className="type-heading">Daily brief</h2>
        {/* duo#282: what's waiting, what was passed on, and what your duo
            handled on its own — the first card in Your duo once a day. On
            by default. */}
        <p className="type-provenance text-[var(--muted)]">
          One card each day in Your duo: what's waiting on you, what was passed on, and what your duo handled by itself. On by
          default.
        </p>
        <button
          aria-pressed={dailyBriefEnabled}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
          data-testid="settings-daily-brief-toggle"
          onClick={() => {
            const next = !dailyBriefEnabled;
            writeDailyBriefEnabled(next);
            setDailyBriefEnabled(next);
          }}
          type="button"
        >
          {dailyBriefEnabled ? "Turn off the daily brief" : "Turn on the daily brief"}
        </button>
      </section>

      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-suggestion-chips">
        <h2 className="type-heading">Suggested questions</h2>
        {/* duo#305: starters for an empty Your duo, and up to three
            follow-ups after an answer — one switch for both, the same
            affordance offered at two moments. On by default. */}
        <p className="type-provenance text-[var(--muted)]">
          Your duo suggests things to ask when the chat is empty, and up to three follow-ups after it answers. On by default.
        </p>
        <button
          aria-pressed={suggestionChipsEnabled}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
          data-testid="settings-suggestion-chips-toggle"
          onClick={() => {
            const next = !suggestionChipsEnabled;
            writeSuggestionChipsEnabled(next);
            setSuggestionChipsEnabled(next);
          }}
          type="button"
        >
          {suggestionChipsEnabled ? "Turn off suggested questions" : "Turn on suggested questions"}
        </button>
      </section>

      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-typing">
        <h2 className="type-heading">Typing</h2>
        {/* #285: on by default — the ordinary messenger behaviour every
            member already expects, unlike the two settings above it (each
            off by default because it costs something: a server fetch, a
            quiet corpus check). Turning this off only ever stops SENDING
            this member's own typing; seeing everyone else's has no
            setting at all. */}
        <p className="type-provenance text-[var(--muted)]">
          Lets people you're chatting with see when you're typing a reply. On by default — turn it off and you'll
          still see when others are typing, you just won't show it yourself.
        </p>
        <button
          aria-pressed={sendTyping}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
          data-testid="settings-typing-toggle"
          onClick={() => {
            const next = !sendTyping;
            writeTypingPref(next);
            setSendTyping(next);
          }}
          type="button"
        >
          {sendTyping ? "Turn off sending typing" : "Turn on sending typing"}
        </button>
      </section>

      <section className="shape-container flex flex-col gap-3 p-4" data-testid="settings-private-receipts">
        <h2 className="type-heading">Private read receipts</h2>
        {/* #286: off unless this member turns it on — the ordinary,
            visible receipt (#63) stays the default. Turning this on
            doesn't stop this account reading its own place in a
            conversation (unread counts and every device still agree) —
            it only stops other members seeing that this account in
            particular has read up to here. Matrix's own distinction
            (`m.read` vs `m.read.private`), not a client-side pretense. */}
        <p className="type-provenance text-[var(--muted)]">
          Other members see a tick turn to "Read" once you've seen their message — the same way you see theirs. Turn this on and your
          own reading stops showing: you still keep your place, nobody else sees it.
        </p>
        <button
          aria-pressed={privateReceipts}
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)]"
          data-testid="settings-private-receipts-toggle"
          onClick={() => {
            const next = !privateReceipts;
            writePrivateReceiptsPref(next);
            setPrivateReceipts(next);
          }}
          type="button"
        >
          {privateReceipts ? "Turn off private read receipts" : "Turn on private read receipts"}
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
    sending: <SendingSettings api={api} />,
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
    privacy: api ? <PrivacyControls api={api} /> : null,
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
