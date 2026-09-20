import { useEffect, useState, type ReactNode } from "react";
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
import { usePendingDrafts } from "./api/queries.js";
import { Setup } from "./routes/Setup.js";
import { Settings } from "./routes/Settings.js";
import { Review } from "./routes/Review.js";
import { Draft } from "./routes/Draft.js";
import { Corrections } from "./routes/Corrections.js";
import { Duo } from "./routes/Duo.js";
import { Trust } from "./routes/Trust.js";
import { Audit } from "./routes/Audit.js";
import { Mirror } from "./routes/Mirror.js";
import { Knowledge } from "./routes/Knowledge.js";
import { SearchOverlay } from "./components/SearchOverlay.js";

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
 * fresh launch opens with — stays the default surface: Review is the thing
 * the app exists to open (client-design.md §1.5). `#draft/:id` (#25) is the
 * one parameterized entry — a draft's own address, what a notification
 * opens — modeled as an object so no string compare can ever confuse it
 * with a named route.
 */
type Route = "review" | "corrections" | "duo" | "trust" | "audit" | "settings" | "mirror" | "knowledge" | { draft: string };

function routeFromHash(hash: string): Route {
  if (hash.startsWith("#draft/")) {
    let id = "";
    try {
      id = decodeURIComponent(hash.slice("#draft/".length));
    } catch {
      id = ""; // a malformed escape is no id at all — Review is the default
    }
    return id ? { draft: id } : "review";
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
  return "review";
}

function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => routeFromHash(window.location.hash));

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash(window.location.hash));
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return route;
}

/** One sidebar entry: same shape either way, active vs muted — the whole difference between the routes' links. */
function NavLink({
  active,
  href,
  count,
  children,
}: {
  active: boolean;
  href: string;
  /** #22: a live count, shown only when non-zero — absent for entries that carry none. */
  count?: number;
  children: ReactNode;
}) {
  return (
    <a
      className={`flex items-center gap-2 rounded-[var(--r-sm)] px-2 py-1.5 text-sm ${
        active ? "bg-[var(--surface)]" : "text-[var(--muted)]"
      }`}
      href={href}
    >
      {children}
      {count !== undefined && count > 0 && (
        <span
          data-testid="review-badge"
          className="ml-auto rounded-full bg-[var(--accent)] px-1.5 text-xs font-medium text-[var(--bg)]"
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
function ReviewLink({ api, active }: { api: DuoApiConfig; active: boolean }) {
  const { data } = usePendingDrafts(api);
  const count = data?.length ?? 0;
  useEffect(() => {
    void setDockBadgeCount(count);
    return () => void setDockBadgeCount(0);
  }, [count]);
  return (
    <NavLink active={active} href="#review" count={count}>
      Review
    </NavLink>
  );
}

/** The §3.1 route tree as one switch — each route's surface, exactly once. Settings also mutates the connection, through App's single choke point. */
function routeSurface(route: Route, api: DuoApiConfig, setApi: (config: DuoApiConfig | null) => void) {
  if (typeof route === "object") {
    return <Draft api={api} draftId={route.draft} />;
  }
  switch (route) {
    case "mirror":
      return <Mirror api={api} />;
    case "knowledge":
      return <Knowledge api={api} />;
    case "corrections":
      return <Corrections api={api} />;
    case "duo":
      return <Duo api={api} />;
    case "trust":
      return <Trust api={api} />;
    case "audit":
      return <Audit api={api} />;
    case "settings":
      return <Settings api={api} onConfigChange={setApi} />;
    case "review":
      return <Review api={api} />;
  }
}

function AppShell() {
  const [api, setApiRaw] = useApiConfig();
  // #41: the daemon refusing this device's token (401) unpairs from any
  // surface, the same choke point Settings' unpair uses — and `revoked`
  // is what Setup says when it appears for that reason rather than first run.
  const [revoked, setRevoked] = useState(false);
  // #46: corpus search, openable from any route. ⌘K and Ctrl+K are the
  // same gesture on the two platforms this client ships to; the overlay
  // renders above whatever surface is on screen, so opening it costs
  // nothing that was there, and closing returns to exactly it.
  const [searchOpen, setSearchOpen] = useState(false);
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
  useDraftReadySocket(api, (draftId) => void notifyDraftReady(draftId));

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

  // After the guard unpairs, Setup carries the explanation with it; a fresh
  // pairing is a first run again and must not keep saying "no longer paired".
  useRevokedTokenGuard(() => {
    setApi(null);
    setRevoked(true);
  });

  const route = useHashRoute();

  if (!api) {
    return (
      <Setup
        notice={revoked ? "This device is no longer paired. Run duo pair new on your Mac and paste the new token to pair again." : undefined}
        onConnect={(config) => {
          setRevoked(false);
          setApi(config);
        }}
      />
    );
  }

  return (
    <SyncStatusProvider>
      <div className="flex h-screen bg-[var(--bg)] text-[var(--text)]">
        <nav className="flex w-56 flex-col gap-1 border-r border-[var(--edge)] p-3">
          <div className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Duo</div>
          {/* A draft page belongs to the review loop — Review stays the lit
              entry while one is open, so the way back is always named. */}
          <ReviewLink api={api} active={route === "review" || typeof route === "object"} />
          {/* #44: the loop's second queue, directly under Review — deciding
              drafts and confirming what they taught are the same morning's
              work, so they read together, each still its own surface. */}
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
          <NavLink active={route === "settings"} href="#settings">
            Settings
          </NavLink>
          <button className="mt-auto px-2 py-1 text-left text-xs text-[var(--faint)]" onClick={() => setApi(null)}>
            Disconnect
          </button>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* §3.3's bar rides above every surface — it is the one state that
              is true of the whole app, not of whichever route is mounted. */}
          <OfflineBar />
          <main className="flex-1 overflow-y-auto">{routeSurface(route, api, setApi)}</main>
          {/* #46: over the screen, never instead of it — the main surface
              stays mounted underneath while search is open. */}
          {searchOpen && api && <SearchOverlay api={api} onClose={() => setSearchOpen(false)} />}
        </div>
      </div>
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
