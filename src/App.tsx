import { useEffect, useRef, useState } from "react";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { useApiConfig } from "./api/config.js";
import { ApiRequestError, apiRequest, type DuoApiConfig } from "./api/client.js";
import { useRevokedTokenGuard } from "./api/revocation.js";
import { endedNoticeText, useEndedMarker } from "./api/lifecycle.js";
import { useDraftReadySocket } from "./api/ws.js";
import { markDraftArrived } from "./arrivals.js";
import { SyncStatusProvider } from "./sync.js";
import { ConfirmationWatcher } from "./components/ConfirmationWatcher.js";
import { draftArrivalBody, notifyDraftReady, postNotification, wireNotificationClicks } from "./notifications.js";
import { isDndActive, readDndPrefs, recordMissed } from "./notificationPrefs.js";
import { wireTrayReview } from "./tray.js";
import { onDraftsChanged, wireMenu, wireOpenHash } from "./shell/native.js";
import { shouldPersistQuery, useOrgOverview } from "./api/queries.js";
import type { DraftRecord } from "./api/types.js";
import { Setup } from "./routes/Setup.js";
import { Admin } from "./routes/Admin.js";
import { Connect } from "./routes/Connect.js";
import { Join } from "./routes/Join.js";
import { Landing } from "./routes/Landing.js";
import {
  adminRoleOf,
  rememberLiveRole,
  configuredDaemonOrigin,
  pairedHostedAccount,
  readHostedAccount,
  trustedDaemonOrigins,
  writeHostedAccount,
  type AdminAccess,
} from "./api/hosted.js";
import { Settings } from "./routes/Settings.js";
import { Onboarding } from "./routes/Onboarding.js";
import { WaitingHome } from "./shell/WaitingHome.js";
import { Draft } from "./routes/Draft.js";
import { BridgedChat } from "./shell/BridgedChat.js";
import { isBridgedId } from "./shell/bridged.js";
import { ChatShell } from "./shell/ChatShell.js";
import { canonicalHash, isLegacyHash, roomOfRoute, routeFromHash, type Route, type SettingsSectionId } from "./shell/routes.js";
import { roomTitle } from "./shell/roomTitle.js";
import { roomHref } from "./workspace/links.js";
import { Room } from "./routes/Room.js";
import { RoomDrafts } from "./components/RoomDrafts.js";
import { ThreadView } from "./routes/Thread.js";
import { Duo } from "./routes/Duo.js";
import { Confirmations } from "./routes/Confirmations.js";
import { SearchOverlay } from "./components/SearchOverlay.js";
import { NoDuoPanel } from "./components/NoDuoPanel.js";
import { PairDuoDialog } from "./components/PairDuoDialog.js";
import { WorkspaceSignInDialog } from "./components/WorkspaceSignInDialog.js";
import { isHostedAccess, useHostedWorkspace, WorkspaceAccessProvider } from "./workspace/access.js";
import { useWorkspaceSession } from "./workspace/session.js";
import { duoOwnerLabel, isDuoUserId, localpartOf } from "./workspace/identity.js";
import type { LiveArrival, RoomSummary, WorkspaceConnection, WorkspaceSession } from "./workspace/matrix.js";
import { ProfilePane } from "./shell/ProfilePane.js";

// §3.3: the cache persists to localStorage and rehydrates at launch. gcTime
// is stretched to match maxAge — the 5-minute default would garbage-collect
// an inactive query long before the persister's 7-day window was up, so
// "cached views render" would silently be true only for the route you were
// last on.
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
// The persisted cache's schema buster (#30). Change the string whenever a
// wire shape gains a field this client dereferences at render: a record
// cached before the field existed rehydrates and renders BEFORE the
// refetch heals it, and `provenance` was the first dereference-grade field
// (a bare `.origin` read would crash that first render with no boundary to
// catch it — killing the very refetch that heals the data). A persisted
// cache whose buster doesn't match is dropped wholesale, so every
// pre-provenance cache dies at launch instead of rendering wrong shapes;
// the per-field render guards are the belt, this is the braces — the
// durable pattern for every future wire-shape change. The value names the
// last field that forced a bump: `delivery` (#21), whose `.state` read
// joined `provenance`'s `.origin` at the dereference grade.
const CACHE_BUSTER = "delivery";
// A 401 is exempt from the retry default: a revoked token never
// re-authenticates on attempt two, so retrying only delays the return to
// Setup by TanStack's full backoff window (~7s). A 404 is exempt with it
// (#25): a draft this daemon does not know is a deterministic answer, and
// three backed-off retries would only stall the "not on this duo" screen
// behind ~7s of pretending otherwise. Everything else — including
// network-level TypeErrors — keeps the default three attempts.
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      gcTime: ONE_WEEK_MS,
      retry: (failureCount, error) =>
        !(error instanceof ApiRequestError && (error.status === 401 || error.status === 404)) && failureCount < 3,
    },
  },
});
const persister = createSyncStoragePersister({ storage: localStorage, key: "duo-cache" });

// Route = the location hash, no router dependency: the grammar, and where every
// retired address lives now, is shell/routes.ts.

/** The location hash while it starts with `prefix`, else null; follows `hashchange`. */
function useHashStartingWith(prefix: string): string | null {
  const read = () => (window.location.hash.startsWith(prefix) ? window.location.hash : null);
  const [hash, setHash] = useState<string | null>(read);
  useEffect(() => {
    const onHashChange = () => setHash(read());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [prefix]);
  return hash;
}

/**
 * Invite-only hosted mode: `#join?host=…&invite=…` is an invite link, and it
 * outranks every other surface — paired or not, a person who opened an
 * invite sees the Join screen, never Setup or the shell. Tracked apart from
 * `Route` because it is not a place in the app; it is the way in.
 */
function useJoinHash(): string | null {
  return useHashStartingWith("#join");
}

function useHashRoute(fallback: Route): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash, fallback));

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash, fallback));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [fallback]);

  // The default surface follows the shell: the fallback changing re-derives a
  // still-empty hash. A non-empty hash is the member's own navigation and
  // keeps standing.
  useEffect(() => {
    setRoute(routeFromHash(window.location.hash, fallback));
  }, [fallback]);

  // A retired address (a bookmark, a notification's tag, an old link) already
  // rendered its new home above; rewrite the bar to that home in place, with
  // no history entry, so it never keeps teaching the old names.
  useEffect(() => {
    if (isLegacyHash(window.location.hash)) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}${canonicalHash(route)}`);
    }
  }, [route]);

  return route;
}

/**
 * #69: the conversation on screen, read from the hash the way the route
 * itself is. An arrival about the surface the member is already looking at
 * is not news — the notification module's own rule: a notification the
 * owner already saw in the open window is noise. A thread's hash carries
 * its room in the first segment.
 */
function openRoomIdFromHash(hash: string): string | null {
  return roomOfRoute(routeFromHash(hash, "chats"));
}

/**
 * #69: the interruption decision, one place, hearing the same live
 * arrivals every surface hears. The member's own words are not news — from
 * any device; neither is the conversation on screen about itself. The
 * member's OWN duo acting on their behalf is its own category, governed by
 * no conversation's setting, because it isn't a conversation. Every other
 * message interrupts by its conversation's mode — the server's answer,
 * read from the same cache the list renders — and do-not-disturb holds any
 * of it back, recorded, visibly, for afterwards. Nothing here changes what
 * any surface renders; it only decides whether the shell speaks.
 */
async function dispatchArrival(
  connection: WorkspaceConnection,
  roomId: string,
  arrival: LiveArrival | undefined,
): Promise<void> {
  if (!arrival || arrival.senderId === connection.userId) {
    return;
  }
  if (openRoomIdFromHash(window.location.hash) === roomId) {
    return;
  }
  const rooms =
    queryClient.getQueryData<readonly RoomSummary[]>(["workspace", "rooms"]) ?? (await connection.rooms());
  const room = rooms.find((candidate) => candidate.roomId === roomId);
  const title = room ? roomTitle(room) : roomId;
  const hash = roomHref(roomId);
  // Whose duo it is comes from the id grammar, never a chosen name: the
  // member's own duo is the one acting on their behalf; a colleague's duo
  // is a participant like anyone else.
  const mine = isDuoUserId(arrival.senderId) && duoOwnerLabel(arrival.senderId) === localpartOf(connection.userId);
  if (!mine) {
    const mode = room?.notifications ?? "all";
    if (mode === "nothing" || (mode === "mentions" && !arrival.mentionsMe)) {
      // The member's standing choice, not something missed: the record is
      // for what do-not-disturb held back, and nothing else.
      return;
    }
  }
  const sender = isDuoUserId(arrival.senderId)
    ? `${duoOwnerLabel(arrival.senderId) ?? localpartOf(arrival.senderId)}'s duo`
    : arrival.senderName;
  const body = mine ? `Your duo answered on your behalf in ${title}.` : `${sender} in ${title}: ${arrival.body}`;
  if (isDndActive(readDndPrefs(), new Date())) {
    recordMissed({ at: Date.now(), body, hash });
    return;
  }
  await postNotification(body, hash);
}

/**
 * #128, #254: which admin screens this browser may open, and the server to open them against. The Admin entry
 * is drawn, and the Admin screen talks, only for a hosted account of the server this app is paired with, and
 * only as the role the daemon says (`adminRoleOf`): the super admin's, an org admin's, or none. The stored
 * account's flags are a first paint's hint; the daemon's answer to `GET {basePath}/org` corrects them, and it
 * re-checks the role on every admin call anyway, so a stale "yes" only ever shows an entry whose screen says it
 * isn't for you. The bearer token is `api.token`: super admin calls go to the origin of `api.baseUrl` and to no
 * other, an org admin's to `api.baseUrl` itself, and a stored account for a different server receives neither.
 */
function adminAccess(api: DuoApiConfig | null, overview: ReturnType<typeof useOrgOverview>): AdminAccess {
  const account = pairedHostedAccount(api);
  // A "no org" or "not yours" is an answer too (`{ none: true }`, kept as data so a refetch can't blank it), and it replaces whatever an earlier answer said.
  const role = adminRoleOf(account, overview.data);
  return { role, origin: role ? (account?.origin ?? null) : null };
}

/** #49: where onboarding lands — the duo's Rules, on the ones the daemon just derived, to approve or reject. */
function goToRules(): void {
  window.location.hash = "#duo/profile/rules";
}

/** What each route renders, and what it needs from the shell — one switch, each surface exactly once. */
interface SurfaceContext {
  api: DuoApiConfig | null;
  session: WorkspaceSession | null;
  connection: WorkspaceConnection | null;
  workspaceError: string | null;
  setApi: (config: DuoApiConfig | null) => void;
  signOutWorkspace: () => void;
  onPairDuo: () => void;
  onWorkspaceSignIn: () => void;
  onDuoEnded: () => void;
  /** #254: the admin screens this device may open, and where. */
  admin: AdminAccess;
}

/** Settings: the index of its sections, or one section alone (#148). */
function settingsSurface(section: SettingsSectionId | "index", shell: SurfaceContext) {
  return (
    <Settings
      api={shell.api}
      onConfigChange={shell.setApi}
      onDuoEnded={shell.onDuoEnded}
      onPairDuo={shell.onPairDuo}
      onSignOut={shell.signOutWorkspace}
      onWorkspaceSignIn={shell.onWorkspaceSignIn}
      admin={shell.admin}
      section={section}
      session={shell.session}
    />
  );
}

/** The route tree as one switch — each route's surface, exactly once. Settings also mutates the connections, through App's single choke points. A duo surface reached without a pairing (a member's URL) explains and offers instead — #62's "offered rather than demanded". The chat list itself (`chats`) is the shell's own, so it has no entry here. */
function routeSurface(route: Route, shell: SurfaceContext) {
  if (typeof route === "object") {
    if ("adminOrg" in route) {
      return shell.api ? (
        <Admin api={shell.api} origin={shell.admin.origin} orgId={route.adminOrg} role={shell.admin.role} />
      ) : (
        <NoDuoPanel onPairDuo={shell.onPairDuo} />
      );
    }
    if ("chat" in route && isBridgedId(route.chat)) {
      return shell.api ? <BridgedChat api={shell.api} chatId={route.chat} /> : <NoDuoPanel onPairDuo={shell.onPairDuo} />;
    }
    if ("chat" in route) {
      return (
        <Room
          at={route.at}
          connection={shell.connection}
          roomId={route.chat}
          drafts={shell.api ? <RoomDrafts api={shell.api} roomId={route.chat} /> : null}
        />
      );
    }
    if ("thread" in route) {
      return (
        <ThreadView
          at={route.thread.at}
          connection={shell.connection}
          roomId={route.thread.roomId}
          rootEventId={route.thread.rootEventId}
        />
      );
    }
    if ("profile" in route) {
      return shell.api ? <ProfilePane api={shell.api} tab={route.profile} /> : <NoDuoPanel onPairDuo={shell.onPairDuo} />;
    }
    if ("settings" in route) {
      return settingsSurface(route.settings, shell);
    }
    return shell.api ? (
      <Draft api={shell.api} draftId={route.draft} connection={shell.connection} />
    ) : (
      <NoDuoPanel onPairDuo={shell.onPairDuo} />
    );
  }
  // The routes below this line are the duo's own surfaces (Settings and the chat list are not).
  if (route !== "chats" && route !== "settings" && !shell.api) {
    return <NoDuoPanel onPairDuo={shell.onPairDuo} />;
  }
  switch (route) {
    case "chats":
      return null;
    case "settings":
      return settingsSurface("index", shell);
    case "admin":
      return <Admin api={shell.api!} origin={shell.admin.origin} orgId={null} role={shell.admin.role} />;
    case "confirmations":
      return <Confirmations api={shell.api!} />;
    case "duo":
      return <Duo api={shell.api!} />;
    case "onboarding":
      // #49: the first run, ending at the Mirror once the first rules exist.
      return <Onboarding api={shell.api!} onFinish={goToRules} />;
    case "waiting":
      // What is waiting on the owner: the list filtered beside it, and this front door. (#49: an empty duo is taken to its first run by the shell.)
      return <WaitingHome api={shell.api!} connection={shell.connection} />;
  }
}

/** The static landing page (`public/welcome.html`); its Sign in links come back to `/#signin`. */
export const WELCOME_PATH = "/welcome.html";

/** A visitor opened the bare root: no route, no invite, no query. Anything else is somewhere they meant to go. */
export function opensOnWelcome(location: Pick<Location, "pathname" | "hash" | "search">): boolean {
  return location.pathname === "/" && location.hash === "" && location.search === "";
}

function GoToWelcome() {
  useEffect(() => {
    window.location.replace(WELCOME_PATH);
  }, []);
  return null;
}

function AppShell() {
  const [api, setApiRaw] = useApiConfig();
  // #62: the second credential — the workspace session (who the member is,
  // in the org), remembered beside but independent of the pairing, so each
  // can begin and end without the other.
  const [session, setSessionRaw] = useWorkspaceSession();
  // The held workspace connection: built once a session exists, stopped
  // when it leaves. Null while connecting; `workspaceError` carries why a
  // connect that should have worked didn't.
  const [connection, setConnection] = useState<WorkspaceConnection | null>(null);
  const connectionRef = useRef<WorkspaceConnection | null>(null);
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);
  // The two door dialogs the member shell offers: pairing and sign-in.
  const [pairOpen, setPairOpen] = useState(false);
  const [signInOpen, setSignInOpen] = useState(false);
  // #41: the daemon refusing this device's token (401) unpairs from any
  // surface, the same choke point Settings' unpair uses — and `revoked`
  // is what Setup says when it appears for that reason rather than first run.
  const [revoked, setRevoked] = useState(false);
  // #55: this device ended its duo. After a confirmed end every token is
  // dead, so the daemon can only ever answer 401 — indistinguishable from a
  // revocation — and this device's own memory is the one honest source for
  // saying "ended" instead. It outranks `revoked` wherever both could show.
  const [ended, setEnded] = useEndedMarker();
  // #127: on a hosted build the workspace session is not typed in — the
  // daemon hands the signed-in person their own, held in memory and never
  // written to storage. From here on `activeSession` is whichever door this
  // device uses: that one, or the stored manual sign-in of a personal daemon.
  const hosted = useHostedWorkspace(api, () => {
    // The daemon no longer knows this device: the same answer as any other 401.
    if (!ended) {
      setApi(null);
      setRevoked(true);
    }
  });
  const hostedActive = isHostedAccess(hosted.access);
  // #254: the person's role, asked of the daemon each time the app opens and on a timer and focus after (storage
  // is only the first paint's hint), so an appointment or a revoke reaches a phone that is already signed in.
  const overview = useOrgOverview(api, pairedHostedAccount(api) !== null);
  const admin = adminAccess(api, overview);
  // What the daemon answered is written back to the stored account, so the next cold start's first paint isn't the sign-in's stale hint.
  useEffect(() => {
    if (overview.data) {
      rememberLiveRole(api, overview.data);
    }
  }, [api, overview.data]);
  const activeSession = hostedActive ? hosted.session : session;
  // The public front door: a signed-out visitor who arrives at the bare
  // root of a hosted build sees the landing page, not the sign-in card.
  // Decided once, at arrival — signing out later returns to sign-in, never
  // to marketing.
  // A ref, not state: clearing it must never re-render the shell.
  const arrivedAtFrontDoor = useRef(opensOnWelcome(window.location));
  if (api || activeSession) {
    arrivedAtFrontDoor.current = false;
  }
  // #46: corpus search, openable from any route. ⌘K and Ctrl+K are the
  // same gesture on the two platforms this client ships to; the overlay
  // renders above whatever surface is on screen, so opening it costs
  // nothing that was there, and closing returns to exactly it.
  const [searchOpen, setSearchOpen] = useState(false);
  // #38: the folded navigation's open state. Below the desktop width
  // there is no sidebar to be in — the surfaces live behind this one
  // control until called for.
  // #39: the polite channel for draft arrivals — text set by the
  // draft-ready push below, self-cleared so each arrival announces.
  const [arrivalNotice, setArrivalNotice] = useState("");
  const noticeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (noticeTimer.current !== null) {
        clearTimeout(noticeTimer.current);
      }
    },
    [],
  );
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "k" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setSearchOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);
  // The one push channel (C7): keeps a socket open while paired, so a draft
  // that lands without this device asking refreshes Review on its own.
  // The native notification rides on the push message — in the Tauri shell
  // (C5) it posts "a new draft is waiting", tagged so a click opens that
  // draft's own address (#25); in a plain browser tab notifyDraftReady
  // quietly no-ops (feature-detected, never throws).
  const announce = (text: string): void => {
    setArrivalNotice(text);
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = setTimeout(() => setArrivalNotice(""), 5000);
  };
  useDraftReadySocket(api, (draftId) => {
    // The draft arrived while the owner is here: it rises in, and its hairline draws (motion-plan A5).
    markDraftArrived(draftId);
    // #69: the push names the draft; what the draft IS decides the words.
    // The duo escalating or refusing on the owner's behalf is its own
    // category — its words come from the record, not the waiting-draft
    // copy — and do-not-disturb holds it the same way it holds a message,
    // into the record Settings shows. A record that can't be read
    // (offline, already actioned) still announces as the waiting draft it
    // most conservatively is; per-conversation modes never apply, because
    // the duo's own acts belong to no conversation.
    void (async () => {
      const hash = `#draft/${encodeURIComponent(draftId)}`;
      let body: string | null = null;
      if (api) {
        try {
          body = draftArrivalBody(await apiRequest<DraftRecord>(api, `/drafts/${encodeURIComponent(draftId)}`));
        } catch {
          body = null; // announce without naming what only the record could say
        }
      }
      if (body !== null) {
        if (isDndActive(readDndPrefs(), new Date())) {
          recordMissed({ at: Date.now(), body, hash });
        } else {
          await postNotification(body, hash);
        }
        return;
      }
      void notifyDraftReady(draftId);
    })();
    // #39: the same push that fires the OS notification also feeds the
    // app's polite live region — a draft arriving is otherwise silent to
    // a screen reader. The notice self-clears, because a live region
    // does not repeat identical content: the next arrival needs an empty
    // region to fill.
    announce("A draft is waiting on you.");
  });

  // #25/#69: one subscription for the app's life — a clicked notification
  // routes to what it was about, a draft or a conversation. Null outside
  // the shell (nothing to click there), and the unmount unwire keeps a
  // remount from double-firing.
  useEffect(() => {
    let unwire: (() => void) | null = null;
    void wireNotificationClicks().then((dispose) => {
      unwire = dispose;
    });
    return () => unwire?.();
  }, []);

  // #69: the interruption decision's ear — the same live arrivals every
  // surface hears, held for the connection's life. The decision itself is
  // dispatchArrival above, beside the routes it speaks for.
  useEffect(() => {
    if (!connection) {
      return;
    }
    return connection.subscribe((roomId, arrival) => {
      void dispatchArrival(connection, roomId, arrival);
    });
  }, [connection]);

  // #42: the tray's Review item — the same shape as the subscription above
  // it. The Rust half shows and focuses the window; the navigation to
  // Review is the client's half, exactly as a notification click's is.
  useEffect(() => {
    let unwire: (() => void) | null = null;
    void wireTrayReview().then((dispose) => {
      unwire = dispose;
    });
    return () => unwire?.();
  }, []);

  // #151: the Mac shell's other doors into the app — what the menu-bar tray
  // sends here ("open this chat"), the native menu's actions, and a decision
  // made in the tray that this window's lists have not seen yet. All null
  // outside the shell.
  useEffect(() => {
    const unwires: Array<() => void> = [];
    let live = true;
    const keep = (dispose: (() => void) | null): void => {
      if (dispose === null) {
        return;
      }
      if (live) {
        unwires.push(dispose);
      } else {
        dispose();
      }
    };
    void wireOpenHash().then(keep);
    void wireMenu().then(keep);
    void onDraftsChanged(() => void queryClient.invalidateQueries()).then(keep);
    return () => {
      live = false;
      unwires.forEach((dispose) => dispose());
    };
  }, []);

  // Wraps the raw setter so the cache is cleared *before* the next
  // render, not reactively after it in a useEffect: React Query's
  // useQuery reads from cache synchronously during render, so an
  // effect-based clear would still let one render slip through showing
  // whichever daemon's drafts happened to be cached under the same query
  // keys — a real risk when reconnecting to a different daemon (or
  // duo/owner) without a full page reload in between. The persisted
  // `duo-cache` blob goes with it (`removeClient`), or unpairing would
  // leave the old duo's data readable in localStorage under a dead token.
  function setApi(next: DuoApiConfig | null): void {
    queryClient.clear();
    void persister.removeClient();
    // Hosted mode: who this browser is signed in as goes with the pairing it
    // describes — unpairing (forget, sign out, revocation, the duo's end)
    // leaves no name or admin flag behind.
    if (next === null) {
      // The workspace session goes first: ended at the workspace with its own
      // credential (the daemon cannot revoke it), then forgotten.
      hosted.signOut();
      writeHostedAccount(null);
      if (hostedActive) {
        // A hosted device ignores a stored manual sign-in and Settings offers no
        // button to clear it, so it must not outlive the account here: signing
        // out leaves no live workspace token behind in this browser.
        setSessionRaw(null);
      }
    }
    setApiRaw(next);
  }

  // #62: the workspace session's own choke point, same stance as `setApi` —
  // signing in or out clears the cache before the next render (cached
  // rooms and timelines are another member's business, or nobody's) and
  // drops the persisted blob. Signing out is what #62 AC4 means by "leaves
  // nothing behind": cached messages and cached duo data both go, while
  // the pairing itself stands.
  function setSession(next: WorkspaceSession | null): void {
    queryClient.clear();
    void persister.removeClient();
    setSessionRaw(next);
  }
  function signOutWorkspace(): void {
    setSession(null);
  }

  // The held workspace connection: dial out once a session exists, stop it
  // when the session leaves or changes. The SDK loads here and only here
  // (dynamic import behind the seam), so an owner who never signs in never
  // pays for it. A connect that fails sets `workspaceError` — surfaced by
  // Conversations with the way out — rather than silently staying empty.
  useEffect(() => {
    if (!activeSession) {
      return;
    }
    const target = activeSession;
    let disposed = false;
    let held: WorkspaceConnection | null = null;
    setWorkspaceError(null);
    void (async () => {
      const { connect } = await import("./workspace/matrix.js");
      try {
        const handle = hostedActive
          ? await connect(target, {
              // The credential expired while the conversations were open: the
              // sync has stopped, so let go of it and ask for a fresh session.
              onSessionRejected: () => {
                if (disposed) {
                  return;
                }
                connectionRef.current = null;
                setConnection(null);
                void held?.stop();
                hosted.report("rejected");
              },
            })
          : await connect(target);
        if (disposed) {
          void handle.stop();
          return;
        }
        held = handle;
        connectionRef.current = handle;
        setConnection(handle);
        if (hostedActive) {
          hosted.report("up");
        }
      } catch (reason) {
        if (disposed) {
          return;
        }
        if (hostedActive) {
          // Nothing to sign out of here and nothing for the person to fix:
          // the hook asks the daemon again (a fresh session if this one was
          // refused, the same one after a pause if the workspace was slow).
          hosted.report((reason as { errcode?: unknown } | null)?.errcode === "M_UNKNOWN_TOKEN" ? "rejected" : "failed");
          return;
        }
        setWorkspaceError(reason instanceof Error ? reason.message : "The workspace connection failed.");
      }
    })();
    return () => {
      disposed = true;
      const handle = connectionRef.current;
      connectionRef.current = null;
      setConnection(null);
      if (handle) {
        void handle.stop();
      }
    };
    // The session object is stable per sign-in; its credential fields are
    // its identity in practice. A hosted session is renewed in place (below),
    // so its identity is the hook's `reconnectKey`, which moves only when the
    // connection has to be made again.
  }, [activeSession?.homeserverUrl, hostedActive ? hosted.reconnectKey : activeSession?.accessToken]);

  // #127: a renewed hosted credential replaces the old one under the open
  // connection — the conversation on screen never blinks.
  useEffect(() => {
    if (hostedActive && hosted.session) {
      connectionRef.current?.renewToken?.(hosted.session.accessToken);
    }
  }, [hostedActive, hosted.session?.accessToken]);

  // After the guard unpairs, Setup carries the explanation with it; a fresh
  // pairing is a first run again and must not keep saying "no longer paired".
  useRevokedTokenGuard(() => {
    // #55: a 401 that follows this device's own end is the ending, not a revocation.
    if (ended) {
      return;
    }
    setApi(null);
    setRevoked(true);
  });

  // #55: the daemon confirmed the end. The pairing leaves through the same
  // choke point as any unpair (cache, persisted blob and stored config all
  // go — nothing of the dead duo stays readable), and the marker says why.
  function duoEnded(): void {
    setRevoked(false);
    setEnded({ endedAt: new Date().toISOString() });
    setApi(null);
  }

  // The default surface is the chat list, whoever is signed in (docs/design-language.md §6.2).
  const route = useHashRoute("chats");
  const joinHash = useJoinHash();
  // claude.ai's sign-in lands here (#connect?host=…&request=…, digital-duo#240) and, like an invite, outranks the shell.
  const connectHash = useHashStartingWith("#connect");

  if (connectHash) {
    return <Connect hash={connectHash} key={connectHash} trustedOrigins={trustedDaemonOrigins(api)} />;
  }

  if (joinHash) {
    return (
      <Join
        alreadyPaired={!!api}
        hash={joinHash}
        onJoined={(config, account) => {
          setRevoked(false);
          setEnded(null);
          setApi(config);
          writeHostedAccount(account);
          // The invite is spent: its hash must not survive in history or a
          // reload would offer the Join screen again for a used code.
          window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#onboarding`);
          window.dispatchEvent(new HashChangeEvent("hashchange"));
        }}
      />
    );
  }

  if (!api && !activeSession) {
    // A hosted build knows its server: the front door is sign-in, not an
    // address form. Without VITE_DUO_DAEMON_URL the app is exactly the
    // pair-with-your-Mac app it always was.
    const hostedOrigin = configuredDaemonOrigin();
    const connectManually = (config: DuoApiConfig) => {
      setRevoked(false);
      setEnded(null);
      setApi(config);
      writeHostedAccount(null);
    };
    const notice = ended
      ? endedNoticeText(ended)
      : revoked
        ? hostedOrigin
          ? "This browser was signed out — its device was revoked. Sign in again to continue."
          : "This device is no longer paired. Run duo pair new on your Mac and paste the new token to pair again."
        : undefined;
    if (hostedOrigin && arrivedAtFrontDoor.current && !notice) {
      return <GoToWelcome />;
    }
    if (hostedOrigin) {
      return (
        <Landing
          notice={notice}
          onConnect={connectManually}
          onSignedIn={(config, account) => {
            setRevoked(false);
            setEnded(null);
            setApi(config);
            writeHostedAccount(account);
          }}
          onWorkspaceSession={setSession}
          origin={hostedOrigin}
        />
      );
    }
    return <Setup notice={notice} onConnect={connectManually} onWorkspaceSession={setSession} />;
  }

  const openPairDuo = (): void => setPairOpen(true);
  const openWorkspaceSignIn = (): void => setSignInOpen(true);

  const banners = (
    <>
      {/* #41 meets #62: a revoked pairing drops the member into the member
          shell, and the reason must not vanish with Setup — the banner says
          what happened until a fresh pairing clears it. */}
      {/* #55: the same banner slot for an ended duo — and the true one: it
          outranks "no longer paired", which the same 401 would say. */}
      {ended && !api && (
        <p
          className="border-b border-[var(--edge)] bg-[var(--surface-2)] px-4 py-2 text-center type-provenance text-[var(--escalate)]"
          data-testid="ended-notice"
          role="status"
        >
          {endedNoticeText(ended)}
        </p>
      )}
      {revoked && !ended && !api && (
        <p
          className="border-b border-[var(--edge)] bg-[var(--surface-2)] px-4 py-2 text-center type-provenance text-[var(--escalate)]"
          data-testid="revoked-notice"
          role="status"
        >
          This device is no longer paired. Run duo pair new on your Mac and paste the new token to pair again.
        </p>
      )}
    </>
  );
  const overlays = (
    <>
      {/* #39: the app's polite live region — a draft arriving announces
          here, once, never stealing focus. */}
      <p className="sr-only" role="status">
        {arrivalNotice}
      </p>
      {/* #52: the confirmation moment's ear — while paired, the pending
          confirmations are read on an interval (the daemon has no push for
          them); a new one notifies and announces here. It holds no way to
          confirm anything. */}
      {api && <ConfirmationWatcher api={api} onArrived={() => announce("An action is waiting for your confirmation.")} />}
      {/* #46: over the screen, never instead of it — the main surface stays
          mounted underneath while search is open. */}
      {api && <SearchOverlay api={api} onClose={() => setSearchOpen(false)} open={searchOpen} />}
    </>
  );
  const footer = (
    <>
      {admin.role && (
        <a
          aria-current={route === "admin" || (typeof route === "object" && "adminOrg" in route) ? "page" : undefined}
          className="inline-flex min-h-11 items-center type-provenance text-[var(--muted)] aria-[current=page]:text-[var(--text)]"
          href="#admin"
        >
          Admin
        </a>
      )}
      {api && (
        <button className="inline-flex min-h-11 items-center text-left type-provenance text-[var(--faint)]" onClick={() => setApi(null)}>
          {/* Hosted mode says "Sign out" for the same local forget: the
              browser holds a signed-in device, and signing in again is one tap. */}
          {readHostedAccount() ? "Sign out" : "Forget this device"}
        </button>
      )}
    </>
  );

  return (
    <WorkspaceAccessProvider access={hosted.access}>
    <SyncStatusProvider>
      <ChatShell
        api={api}
        banners={banners}
        connection={connection}
        footer={footer}
        onPairDuo={openPairDuo}
        onSignIn={openWorkspaceSignIn}
        onSignOutWorkspace={signOutWorkspace}
        overlays={overlays}
        pane={routeSurface(route, {
          api,
          session: activeSession,
          connection,
          workspaceError,
          setApi,
          signOutWorkspace,
          onPairDuo: openPairDuo,
          onWorkspaceSignIn: openWorkspaceSignIn,
          onDuoEnded: duoEnded,
          admin,
        })}
        route={route}
        session={activeSession}
        workspaceError={workspaceError}
      />
      <PairDuoDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        onConnect={(config) => {
          setRevoked(false);
          setEnded(null);
          setPairOpen(false);
          setApi(config);
        }}
      />
      <WorkspaceSignInDialog
        open={signInOpen}
        onOpenChange={setSignInOpen}
        onSession={(next) => {
          setSignInOpen(false);
          setSession(next);
        }}
      />
    </SyncStatusProvider>
    </WorkspaceAccessProvider>
  );
}

export function App() {
  return (
    <PersistQueryClientProvider
      client={queryClient}
      persistOptions={{
        persister,
        maxAge: ONE_WEEK_MS,
        buster: CACHE_BUSTER,
        // #70: a message search is asked, answered, and forgotten — what a
        // member looked for, and what came back, never rests in storage, and
        // a restored answer could never outlive a membership that ended.
        // #128: nor does the super admin's view of the server — the orgs, who is in them (names and
        // Google addresses) and the invites — rest in storage; it is fetched afresh each visit.
        dehydrateOptions: { shouldDehydrateQuery: shouldPersistQuery },
      }}
    >
      <AppShell />
    </PersistQueryClientProvider>
  );
}
