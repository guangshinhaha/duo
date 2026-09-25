import { useEffect, useRef, useState, type ReactNode } from "react";
import { Menu, X } from "lucide-react";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { useApiConfig } from "./api/config.js";
import { ApiRequestError, type DuoApiConfig } from "./api/client.js";
import { useRevokedTokenGuard } from "./api/revocation.js";
import { useDraftReadySocket } from "./api/ws.js";
import { SyncStatusProvider } from "./sync.js";
import { OfflineBar } from "./components/OfflineBar.js";
import { notifyDraftReady, wireDraftNotificationClicks } from "./notifications.js";
import { setDockBadgeCount } from "./dockBadge.js";
import { setTrayPendingCount, wireTrayReview } from "./tray.js";
import { usePendingDrafts } from "./api/queries.js";
import { Setup } from "./routes/Setup.js";
import { Settings } from "./routes/Settings.js";
import { Review } from "./routes/Review.js";
import { Draft } from "./routes/Draft.js";
import { Corrections } from "./routes/Corrections.js";
import { Conversations } from "./routes/Conversations.js";
import { Room } from "./routes/Room.js";
import { ThreadView } from "./routes/Thread.js";
import { Duo } from "./routes/Duo.js";
import { Trust } from "./routes/Trust.js";
import { Audit } from "./routes/Audit.js";
import { Mirror } from "./routes/Mirror.js";
import { Knowledge } from "./routes/Knowledge.js";
import { SearchOverlay } from "./components/SearchOverlay.js";
import { DuoRoster } from "./components/DuoRoster.js";
import { NoDuoPanel } from "./components/NoDuoPanel.js";
import { PairDuoDialog } from "./components/PairDuoDialog.js";
import { WorkspaceSignInDialog } from "./components/WorkspaceSignInDialog.js";
import { useWorkspaceSession } from "./workspace/session.js";
import type { WorkspaceConnection, WorkspaceSession } from "./workspace/matrix.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./components/primitives/Dialog.js";

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

/**
 * Route = the location hash, no router dependency (`client-tech-design.md`
 * §3.1's route tree is six entries; a library would be the only dependency
 * the client has that isn't load-bearing). `#review` — and the empty hash a
 * fresh launch opens with — stays the default surface for an owner-only
 * app: Review is the thing the app exists to open (client-design.md §1.5).
 * #62 adds the member's half: `#conversations` (the default once a
 * workspace session exists — the member's space) and `#room/:id`, one
 * conversation's own address. #64 adds `#thread/:room/:root`, a thread's
 * own address within it. The parameterized entries are objects so no
 * string compare can ever confuse them with a named route.
 */
type Route =
  | "review"
  | "conversations"
  | "corrections"
  | "duo"
  | "trust"
  | "audit"
  | "settings"
  | "mirror"
  | "knowledge"
  | { draft: string }
  | { room: string }
  | { thread: { roomId: string; rootEventId: string } };

function routeFromHash(hash: string, fallback: Route = "review"): Route {
  if (hash.startsWith("#draft/")) {
    let id = "";
    try {
      id = decodeURIComponent(hash.slice("#draft/".length));
    } catch {
      id = ""; // a malformed escape is no id at all — the fallback is the default
    }
    return id ? { draft: id } : fallback;
  }
  if (hash.startsWith("#thread/")) {
    // Both halves are encoded whole, so the first `/` is the grammar's own
    // separator — anything after it belongs to the root event's id.
    const parts = hash.slice("#thread/".length).split("/");
    let roomId = "";
    let rootEventId = "";
    try {
      roomId = decodeURIComponent(parts[0] ?? "");
      rootEventId = decodeURIComponent(parts[1] ?? "");
    } catch {
      roomId = ""; // a malformed escape is no id at all
    }
    return roomId && rootEventId ? { thread: { roomId, rootEventId } } : "conversations";
  }
  if (hash.startsWith("#room/")) {
    let id = "";
    try {
      id = decodeURIComponent(hash.slice("#room/".length));
    } catch {
      id = ""; // a malformed escape is no id at all
    }
    return id ? { room: id } : "conversations";
  }
  if (hash === "#conversations") {
    return "conversations";
  }
  if (hash === "#mirror") {
    return "mirror";
  }
  if (hash === "#knowledge") {
    return "knowledge";
  }
  if (hash === "#corrections") {
    return "corrections";
  }
  if (hash === "#duo") {
    return "duo";
  }
  if (hash === "#trust") {
    return "trust";
  }
  if (hash === "#audit") {
    return "audit";
  }
  if (hash === "#settings") {
    return "settings";
  }
  return fallback;
}

function useHashRoute(fallback: Route): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash, fallback));

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash, fallback));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, [fallback]);

  // The default surface follows the shell: signing in makes Conversations
  // the empty-hash route, signing out gives the empty hash back to Review —
  // so the fallback changing re-derives a still-empty hash. A non-empty
  // hash is the member's own navigation and keeps standing.
  useEffect(() => {
    setRoute(routeFromHash(window.location.hash, fallback));
  }, [fallback]);

  return route;
}

/** One sidebar entry: same shape either way, active vs muted — the whole difference between the routes' links. */
function NavLink({
  active,
  href,
  count,
  onClick,
  children,
}: {
  active: boolean;
  href: string;
  /** #22: a live count, shown only when non-zero — absent for entries that carry none. */
  count?: number;
  /** #38: the folded navigation passes this so following a link also
   * dismisses it — an overlay must never outstay the route it chose. */
  onClick?: () => void;
  children: ReactNode;
}) {
  return (
    <a
      className={`flex min-h-11 items-center gap-2 rounded-[var(--r-sm)] px-2 type-body ${
        active ? "bg-[var(--surface)]" : "text-[var(--muted)]"
      }`}
      href={href}
      onClick={onClick}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span
          data-testid="review-badge"
          className="ml-auto rounded-full bg-[var(--accent)] px-2 type-identifier text-[var(--bg)]"
        >
          {count}
        </span>
      )}
    </a>
  );
}

/**
 * Review's sidebar entry with its count (#22 / §3.1: "badge = drafts where
 * outcome is null"). The count is the pending-drafts query itself, so it
 * already follows the one push channel: a `draft-ready` push invalidates
 * `["drafts"]`, the pending list refetches, and both badges move without a
 * manual refresh. The dock mirror lives here too — the one place the count
 * exists — and its cleanup clears the dock on unpair, so a stale count
 * never outlives its pairing.
 */
function ReviewLink({ api, active, onNavigate }: { api: DuoApiConfig; active: boolean; onNavigate?: () => void }) {
  const { data } = usePendingDrafts(api);
  const count = data?.length ?? 0;
  useEffect(() => {
    void setDockBadgeCount(count);
    // #42: the menu-bar mirror — the same count, carried to the tray the
    // same way. The cleanup clears it on unpair (and unmount) so a stale
    // count never outlives its pairing, exactly like the dock's.
    void setTrayPendingCount(count);
    return () => {
      void setDockBadgeCount(0);
      void setTrayPendingCount(0);
    };
  }, [count]);
  return (
    <NavLink active={active} href="#review" count={count} onClick={onNavigate}>
      Review
    </NavLink>
  );
}

/**
 * #38: the phone's notification surrogate (AR-15 — no push can reach a
 * browser tab over Tailscale), so Review's count is read without opening
 * anything. Same query the Review link observes; the badge is the point,
 * not a second source of truth.
 */
function TopBarCount({ api }: { api: DuoApiConfig }) {
  const { data } = usePendingDrafts(api);
  const count = data?.length ?? 0;
  if (count === 0) {
    return null;
  }
  return (
    <span data-testid="topbar-count" className="rounded-full bg-[var(--accent)] px-2 type-identifier text-[var(--bg)]">
      {count}
    </span>
  );
}

/**
 * #38: the folded navigation — §1.5's "phone-width folds the same map, it
 * does not replace it". No tab bar, no second product: the same surfaces
 * nav, arranged for the width, with §3.1's one mobile-only rule applied —
 * Trust and Audit, the rare globals, share one "More" section instead of
 * two top-level entries. The dialog primitive (#34) supplies the focus
 * trap, Escape, and the scrim; every entry is still a real anchor, and
 * following one dismisses the overlay on the way through.
 *
 * #62: `api` is nullable now — a member signed in to the workspace with no
 * paired duo folds the member's map (Conversations, Settings, and the
 * pairing offer) instead of the owner's, the same conditional the sidebar
 * applies.
 */
function MobileNav({
  api,
  session,
  route,
  open,
  onOpenChange,
  onDisconnect,
  onPairDuo,
}: {
  api: DuoApiConfig | null;
  session: WorkspaceSession | null;
  route: Route;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDisconnect: () => void;
  onPairDuo: () => void;
}) {
  const close = () => onOpenChange(false);
  // The same actives the sidebar computes — one map, folded differently.
  const onReview = route === "review" || (typeof route === "object" && "draft" in route);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-sm" data-testid="mobile-nav">
        <div className="flex items-center justify-between gap-2">
          <DialogTitle className="type-heading">Duo</DialogTitle>
          {/* The phone's dismissal: Escape is a keyboard's gesture, and a
              scrim-tap is an invisible one — a labelled control is the
              honest way out. */}
          <button
            aria-label="Close navigation"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2"
            onClick={close}
          >
            <X aria-label="Close navigation" size={20} />
          </button>
        </div>
        <DialogDescription className="sr-only">The surfaces, folded for this width.</DialogDescription>
        {/* #40: the same roster the sidebar carries — one map, folded. The
            title stays "Duo" (the dialog's name); whose duos these are is
            the roster's half to say. */}
        {api ? <DuoRoster api={api} /> : <NoDuoPanel onPairDuo={onPairDuo} condensed />}
        <nav aria-label="Surfaces" className="flex flex-col gap-1">
          {api && <ReviewLink api={api} active={onReview} onNavigate={close} />}
          {session && (
            <NavLink
              active={route === "conversations" || (typeof route === "object" && ("room" in route || "thread" in route))}
              href="#conversations"
              onClick={close}
            >
              Conversations
            </NavLink>
          )}
          {api && (
            <>
              <NavLink active={route === "corrections"} href="#corrections" onClick={close}>
                Corrections
              </NavLink>
              <NavLink active={route === "duo"} href="#duo" onClick={close}>
                Duo
              </NavLink>
              <NavLink active={route === "mirror"} href="#mirror" onClick={close}>
                Mirror
              </NavLink>
              <NavLink active={route === "knowledge"} href="#knowledge" onClick={close}>
                Knowledge
              </NavLink>
              <section className="mt-2 flex flex-col gap-1">
                <div className="px-2 type-provenance uppercase text-[var(--faint)]">More</div>
                <NavLink active={route === "trust"} href="#trust" onClick={close}>
                  Trust
                </NavLink>
                <NavLink active={route === "audit"} href="#audit" onClick={close}>
                  Audit
                </NavLink>
              </section>
            </>
          )}
          <NavLink active={route === "settings"} href="#settings" onClick={close}>
            Settings
          </NavLink>
          {api && (
            <button
              className="mt-2 inline-flex min-h-11 items-center border-t border-[var(--edge)] px-2 pt-3 text-left type-provenance text-[var(--faint)]"
              onClick={() => {
                close();
                onDisconnect();
              }}
            >
              Forget this device
            </button>
          )}
        </nav>
      </DialogContent>
    </Dialog>
  );
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
}

/** The §3.1 route tree as one switch — each route's surface, exactly once. Settings also mutates the connections, through App's single choke points. A duo surface reached without a pairing (a member's URL) explains and offers instead — #62's "offered rather than demanded". */
function routeSurface(route: Route, shell: SurfaceContext) {
  if (typeof route === "object") {
    if ("room" in route) {
      return <Room connection={shell.connection} roomId={route.room} />;
    }
    if ("thread" in route) {
      return (
        <ThreadView connection={shell.connection} roomId={route.thread.roomId} rootEventId={route.thread.rootEventId} />
      );
    }
    return shell.api ? <Draft api={shell.api} draftId={route.draft} /> : <NoDuoPanel onPairDuo={shell.onPairDuo} />;
  }
  // The routes below this line are the duo's own surfaces.
  if (route !== "conversations" && route !== "settings" && !shell.api) {
    return <NoDuoPanel onPairDuo={shell.onPairDuo} />;
  }
  switch (route) {
    case "conversations":
      return (
        <Conversations
          connection={shell.connection}
          error={shell.workspaceError}
          onSignIn={shell.onWorkspaceSignIn}
          onSignOut={shell.signOutWorkspace}
        />
      );
    case "settings":
      return (
        <Settings
          api={shell.api}
          session={shell.session}
          onConfigChange={shell.setApi}
          onSignOut={shell.signOutWorkspace}
          onPairDuo={shell.onPairDuo}
          onWorkspaceSignIn={shell.onWorkspaceSignIn}
        />
      );
    case "mirror":
      return <Mirror api={shell.api!} />;
    case "knowledge":
      return <Knowledge api={shell.api!} />;
    case "corrections":
      return <Corrections api={shell.api!} />;
    case "duo":
      return <Duo api={shell.api!} />;
    case "trust":
      return <Trust api={shell.api!} />;
    case "audit":
      return <Audit api={shell.api!} />;
    case "review":
      return <Review api={shell.api!} />;
  }
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
  // #46: corpus search, openable from any route. ⌘K and Ctrl+K are the
  // same gesture on the two platforms this client ships to; the overlay
  // renders above whatever surface is on screen, so opening it costs
  // nothing that was there, and closing returns to exactly it.
  const [searchOpen, setSearchOpen] = useState(false);
  // #38: the folded navigation's open state. Below the desktop width
  // there is no sidebar to be in — the surfaces live behind this one
  // control until called for.
  const [navOpen, setNavOpen] = useState(false);
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
  useDraftReadySocket(api, (draftId) => {
    void notifyDraftReady(draftId);
    // #39: the same push that fires the OS notification also feeds the
    // app's polite live region — a draft arriving is otherwise silent to
    // a screen reader. The notice self-clears, because a live region
    // does not repeat identical content: the next arrival needs an empty
    // region to fill.
    setArrivalNotice("A draft is waiting in the Review queue.");
    if (noticeTimer.current !== null) {
      clearTimeout(noticeTimer.current);
    }
    noticeTimer.current = setTimeout(() => setArrivalNotice(""), 5000);
  });

  // #25: one subscription for the app's life — a clicked notification
  // routes to the draft it was about. Null outside the shell (nothing to
  // click there), and the unmount unwire keeps a remount from double-firing.
  useEffect(() => {
    let unwire: (() => void) | null = null;
    void wireDraftNotificationClicks().then((dispose) => {
      unwire = dispose;
    });
    return () => unwire?.();
  }, []);

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
    if (!session) {
      return;
    }
    let disposed = false;
    setWorkspaceError(null);
    void (async () => {
      const { connect } = await import("./workspace/matrix.js");
      try {
        const handle = await connect(session);
        if (disposed) {
          void handle.stop();
          return;
        }
        connectionRef.current = handle;
        setConnection(handle);
      } catch (reason) {
        if (!disposed) {
          setWorkspaceError(reason instanceof Error ? reason.message : "The workspace connection failed.");
        }
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
    // its identity in practice.
  }, [session?.homeserverUrl, session?.accessToken]);

  // After the guard unpairs, Setup carries the explanation with it; a fresh
  // pairing is a first run again and must not keep saying "no longer paired".
  useRevokedTokenGuard(() => {
    setApi(null);
    setRevoked(true);
  });

  // #62: the default surface follows the shell — Conversations for a
  // signed-in member (§1.5's default space), Review for the owner-only app.
  const route = useHashRoute(session ? "conversations" : "review");

  if (!api && !session) {
    return (
      <Setup
        notice={revoked ? "This device is no longer paired. Run duo pair new on your Mac and paste the new token to pair again." : undefined}
        onConnect={(config) => {
          setRevoked(false);
          setApi(config);
        }}
        onWorkspaceSession={setSession}
      />
    );
  }

  const openPairDuo = (): void => setPairOpen(true);
  const openWorkspaceSignIn = (): void => setSignInOpen(true);

  return (
    <SyncStatusProvider>
      {/* #38: a column on a phone, a row from the desktop breakpoint up —
          the same shell folding, not a second one. dvh, not vh: mobile
          Safari's collapsing URL bar would otherwise bury the composer. */}
      <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)] md:flex-row">
        {/* #38: the narrow-width top bar — the sidebar's replacement is a
            bar and one control, not a shrunken column (§1.5: no tab bar,
            no second product). Gone entirely at the desktop width. */}
        <header className="flex items-center justify-between gap-2 border-b border-[var(--edge)] p-3 md:hidden" data-testid="mobile-topbar">
          <span className="px-1 type-provenance uppercase text-[var(--faint)]">Duo</span>
          {api && <TopBarCount api={api} />}
          <button
            aria-label="Open navigation"
            className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2"
            onClick={() => setNavOpen(true)}
          >
            {/* Self-labelled (the #34 icon law): an icon that speaks alone
                says what it is; the button's name says what it does. */}
            <Menu aria-label="Open navigation" size={20} />
          </button>
        </header>
        <MobileNav
          api={api}
          session={session}
          route={route}
          open={navOpen}
          onOpenChange={setNavOpen}
          onDisconnect={() => setApi(null)}
          onPairDuo={openPairDuo}
        />
        {/* #41 meets #62: a revoked pairing drops the member into the
            member shell, and the reason must not vanish with Setup — the
            banner says what happened until a fresh pairing clears it. */}
        {revoked && !api && (
          <p
            className="border-b border-[var(--edge)] bg-[var(--surface-2)] px-4 py-2 text-center type-provenance text-[var(--escalate)]"
            data-testid="revoked-notice"
            role="status"
          >
            This device is no longer paired. Run duo pair new on your Mac and paste the new token to pair again.
          </p>
        )}
        <nav aria-label="Surfaces" className="hidden w-56 flex-col gap-1 border-r border-[var(--edge)] p-3 md:flex">
          {/* #40: the duos the daemon reports, where the hardcoded wordmark
              stood — `useDuos` stops being dead code the moment the shell
              renders it. Falls back to the plain wordmark above. For a
              member with no duo paired, the same slot explains and offers
              (#62: pairing is offered, never demanded). */}
          {api ? (
            <>
              <DuoRoster api={api} />
              {/* A draft page belongs to the review loop — Review stays the
                  lit entry while one is open, so the way back is always
                  named. */}
              <ReviewLink api={api} active={route === "review" || (typeof route === "object" && "draft" in route)} />
            </>
          ) : (
            <NoDuoPanel onPairDuo={openPairDuo} condensed />
          )}
          {/* #62: Conversations — the member's default space — sits under
              Review where §1.5 puts it, only when there is a workspace to
              read. */}
          {session && (
            <NavLink
              active={route === "conversations" || (typeof route === "object" && ("room" in route || "thread" in route))}
              href="#conversations"
            >
              Conversations
            </NavLink>
          )}
          {api && (
            <>
              {/* #44: the loop's second queue, directly under Review —
                  deciding drafts and confirming what they taught are the
                  same morning's work, so they read together, each still its
                  own surface. */}
              <NavLink active={route === "corrections"} href="#corrections">
                Corrections
              </NavLink>
              <NavLink active={route === "duo"} href="#duo">
                Duo
              </NavLink>
              <NavLink active={route === "trust"} href="#trust">
                Trust
              </NavLink>
              <NavLink active={route === "audit"} href="#audit">
                Audit
              </NavLink>
              <NavLink active={route === "mirror"} href="#mirror">
                Mirror
              </NavLink>
              {/* #45: with the your-duo surfaces — what it derived (Mirror),
                  then what it knows (Knowledge). */}
              <NavLink active={route === "knowledge"} href="#knowledge">
                Knowledge
              </NavLink>
            </>
          )}
          <NavLink active={route === "settings"} href="#settings">
            Settings
          </NavLink>
          {api && (
            <button
              className="mt-auto inline-flex min-h-11 items-center px-2 text-left type-provenance text-[var(--faint)]"
              onClick={() => setApi(null)}
            >
              Forget this device
            </button>
          )}
        </nav>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          {/* §3.3's bar rides above every surface — it is the one state that
              is true of the whole app, not of whichever route is mounted. */}
          <OfflineBar />
          <main className="flex-1 overflow-y-auto">
            {routeSurface(route, {
              api,
              session,
              connection,
              workspaceError,
              setApi,
              signOutWorkspace,
              onPairDuo: openPairDuo,
              onWorkspaceSignIn: openWorkspaceSignIn,
            })}
          </main>
          {/* #39: the app's polite live region — a draft arriving
              announces here, once, never stealing focus. */}
          <p className="sr-only" role="status">
            {arrivalNotice}
          </p>
          {/* #46: over the screen, never instead of it — the main surface
              stays mounted underneath while search is open. */}
          {searchOpen && api && <SearchOverlay api={api} onClose={() => setSearchOpen(false)} />}
        </div>
      </div>
      {/* #62's two doors, as overlays from the shell: pairing from the
          member surfaces' offer, sign-in from Settings' empty state. Each
          lands through the same choke point the front door uses. */}
      <PairDuoDialog
        open={pairOpen}
        onOpenChange={setPairOpen}
        onConnect={(config) => {
          setRevoked(false);
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
  );
}

export function App() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: ONE_WEEK_MS, buster: CACHE_BUSTER }}>
      <AppShell />
    </PersistQueryClientProvider>
  );
}
