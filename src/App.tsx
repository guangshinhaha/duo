import { useEffect, useState, type ReactNode } from "react";
import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { createSyncStoragePersister } from "@tanstack/query-sync-storage-persister";
import { useApiConfig } from "./api/config.js";
import type { DuoApiConfig } from "./api/client.js";
import { useDraftReadySocket } from "./api/ws.js";
import { SyncStatusProvider } from "./sync.js";
import { OfflineBar } from "./components/OfflineBar.js";
import { notifyDraftReady } from "./notifications.js";
import { Setup } from "./routes/Setup.js";
import { Review } from "./routes/Review.js";
import { Duo } from "./routes/Duo.js";
import { Trust } from "./routes/Trust.js";
import { Mirror } from "./routes/Mirror.js";

// §3.3: the cache persists to localStorage and rehydrates at launch. gcTime
// is stretched to match maxAge — the 5-minute default would garbage-collect
// an inactive query long before the persister's 7-day window was up, so
// "cached views render" would silently be true only for the route you were
// last on.
const ONE_WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const queryClient = new QueryClient({ defaultOptions: { queries: { gcTime: ONE_WEEK_MS } } });
const persister = createSyncStoragePersister({ storage: localStorage, key: "duo-cache" });

/**
 * Route = the location hash, no router dependency (`client-tech-design.md`
 * §3.1's route tree is six entries; a library would be the only dependency
 * the client has that isn't load-bearing). `#review` — and the empty hash a
 * fresh launch opens with — stays the default surface: Review is the thing
 * the app exists to open (client-design.md §1.5).
 */
type Route = "review" | "duo" | "trust" | "mirror";

function routeFromHash(hash: string): Route {
  if (hash === "#mirror") {
    return "mirror";
  }
  if (hash === "#duo") {
    return "duo";
  }
  if (hash === "#trust") {
    return "trust";
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
function NavLink({ active, href, children }: { active: boolean; href: string; children: ReactNode }) {
  return (
    <a
      className={
        active
          ? "rounded-[var(--r-sm)] bg-[var(--surface)] px-2 py-1.5 text-sm"
          : "rounded-[var(--r-sm)] px-2 py-1.5 text-sm text-[var(--muted)]"
      }
      href={href}
    >
      {children}
    </a>
  );
}

/** The §3.1 route tree as one switch — each route's surface, exactly once. */
function routeSurface(route: Route, api: DuoApiConfig) {
  switch (route) {
    case "mirror":
      return <Mirror api={api} />;
    case "duo":
      return <Duo api={api} />;
    case "trust":
      return <Trust api={api} />;
    case "review":
      return <Review api={api} />;
  }
}

function AppShell() {
  const [api, setApiRaw] = useApiConfig();
  // The one push channel (C7): keeps a socket open while paired, so a draft
  // that lands without this device asking refreshes Review on its own.
  // The native notification rides on the push message — in the Tauri shell
  // (C5) it posts "a new draft is waiting"; in a plain browser tab
  // notifyDraftReady quietly no-ops (feature-detected, never throws).
  useDraftReadySocket(api, () => void notifyDraftReady());

  // Wraps the raw setter so the cache is cleared *before* the next
  // render, not reactively after it in a useEffect: React Query's
  // useQuery reads from cache synchronously during render, so an
  // effect-based clear would still let one render slip through showing
  // whichever daemon's drafts happened to be cached under the same query
  // keys — a real risk when reconnecting to a different daemon (or
  // duo/owner) without a full page reload in between.
  function setApi(next: DuoApiConfig | null): void {
    queryClient.clear();
    setApiRaw(next);
  }

  const route = useHashRoute();

  if (!api) {
    return <Setup onConnect={setApi} />;
  }

  return (
    <SyncStatusProvider>
      <div className="flex h-screen bg-[var(--bg)] text-[var(--text)]">
        <nav className="flex w-56 flex-col gap-1 border-r border-[var(--edge)] p-3">
          <div className="mb-2 px-2 text-xs font-medium uppercase tracking-wide text-[var(--faint)]">Duo</div>
          <NavLink active={route === "review"} href="#review">
            Review
          </NavLink>
          <NavLink active={route === "duo"} href="#duo">
            Duo
          </NavLink>
          <NavLink active={route === "trust"} href="#trust">
            Trust
          </NavLink>
          <NavLink active={route === "mirror"} href="#mirror">
            Mirror
          </NavLink>
          <button className="mt-auto px-2 py-1 text-left text-xs text-[var(--faint)]" onClick={() => setApi(null)}>
            Disconnect
          </button>
        </nav>
        <div className="flex min-w-0 flex-1 flex-col">
          {/* §3.3's bar rides above every surface — it is the one state that
              is true of the whole app, not of whichever route is mounted. */}
          <OfflineBar />
          <main className="flex-1 overflow-y-auto">{routeSurface(route, api)}</main>
        </div>
      </div>
    </SyncStatusProvider>
  );
}

export function App() {
  return (
    <PersistQueryClientProvider client={queryClient} persistOptions={{ persister, maxAge: ONE_WEEK_MS }}>
      <AppShell />
    </PersistQueryClientProvider>
  );
}
