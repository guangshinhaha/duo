import { useEffect } from "react";
import type { ReactNode } from "react";
import { ChevronLeft } from "lucide-react";
import type { DuoApiConfig } from "../api/client.js";
import { Mark } from "../components/Mark.js";
import { OfflineBar } from "../components/OfflineBar.js";
import { useFirstRunRedirect } from "../routes/Onboarding.js";
import { setDockBadgeCount } from "../dockBadge.js";
import { setTrayPendingCount } from "../tray.js";
import type { WorkspaceConnection, WorkspaceSession } from "../workspace/matrix.js";
import { ChatList } from "./ChatList.js";
import { useWaitingCount } from "./waiting.js";
import { DESKTOP_QUERY, useMediaQuery } from "./useMediaQuery.js";
import type { Route } from "./routes.js";

/**
 * Mirrors the waiting count to the dock and the menu bar — the one place
 * the count leaves the window, so a stale number never outlives its pairing
 * (the cleanup clears both on unpair or unmount).
 */
function WaitingMirror({ api }: { api: DuoApiConfig }) {
  const count = useWaitingCount(api);
  useEffect(() => {
    void setDockBadgeCount(count);
    void setTrayPendingCount(count);
    // The window title carries it too — the same number, where a background tab or the app switcher shows it.
    document.title = count > 0 ? `(${count}) Duo` : "Duo";
    return () => {
      void setDockBadgeCount(0);
      void setTrayPendingCount(0);
      document.title = "Duo";
    };
  }, [count]);
  return null;
}

const FILTER_KEY = "duo.waiting-filter";

/**
 * Whether the list is filtered to "Waiting on you". The `#waiting` address
 * turns it on, `#chats` (All) turns it off, and it stays on while the owner
 * works down the list — opening a chat, deciding its draft, moving to the
 * next — so the filter is a mode of the list, not a page you leave. It lives
 * in this tab's session only.
 */
function useWaitingFilter(route: Route): boolean {
  useEffect(() => {
    try {
      if (route === "waiting") {
        sessionStorage.setItem(FILTER_KEY, "1");
      } else if (route === "chats") {
        sessionStorage.removeItem(FILTER_KEY);
      }
    } catch {
      // no storage: the filter simply follows the address
    }
  }, [route]);
  if (route === "waiting") {
    return true;
  }
  if (route === "chats") {
    return false;
  }
  try {
    return sessionStorage.getItem(FILTER_KEY) === "1";
  } catch {
    return false;
  }
}

/** A brand-new duo opens on its first run, not an empty list. */
function FirstRun({ api }: { api: DuoApiConfig }) {
  useFirstRunRedirect(api);
  return null;
}

/** The pane's face when no chat is open (desktop, on the chat list itself). */
function EmptyPane({ hasDuo }: { hasDuo: boolean }) {
  return (
    <div className="m-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center" data-testid="chats-empty-pane">
      <Mark />
      <h1 className="type-heading">Your chats</h1>
      <p className="type-body text-[var(--muted)]">
        {hasDuo
          ? "Pick a conversation, or ask your duo anything. When someone asks you something, your duo's draft waits above the box you reply in, and only you can see it."
          : "Pick a conversation to start."}
      </p>
      {hasDuo && (
        <a className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" href="#duo">
          Ask your duo
        </a>
      )}
    </div>
  );
}

/**
 * The chat-first shell (docs/design-language.md §6.2): the chat list on the
 * left, the open surface on the right; on a phone, one at a time — the list
 * is home and everything else is a screen you push onto it, with the way
 * back always named. What is mounted follows the width (see `useMediaQuery`),
 * so the two layouts share one tree of components rather than one hidden by
 * CSS. Everything that must run whichever is on screen — the offline bar,
 * the dock mirror, the first-run door, the confirmation watcher — sits
 * outside both.
 */
export function ChatShell({
  api,
  session,
  connection,
  workspaceError,
  route,
  pane,
  banners,
  overlays,
  onSignIn,
  onPairDuo,
  onSignOutWorkspace,
  footer,
}: {
  api: DuoApiConfig | null;
  session: WorkspaceSession | null;
  connection: WorkspaceConnection | null;
  workspaceError: string | null;
  route: Route;
  /** The surface the route names. */
  pane: ReactNode;
  banners?: ReactNode;
  overlays?: ReactNode;
  onSignIn: () => void;
  onPairDuo: () => void;
  onSignOutWorkspace: () => void;
  footer?: ReactNode;
}) {
  const desktop = useMediaQuery(DESKTOP_QUERY);
  // Home is the list: the chat list itself, or that list filtered to what waits on the owner.
  const atHome = route === "chats" || route === "waiting";
  const filterWaiting = useWaitingFilter(route);
  const showList = desktop || atHome;
  const showPane = desktop || !atHome;
  // The page has exactly one main landmark: the open surface — or, on a
  // phone's home screen where the list is all there is, the list itself.
  const ListTag = showPane ? "aside" : "main";
  return (
    <div className="flex h-dvh flex-col bg-[var(--bg)] text-[var(--text)]">
      {banners}
      <OfflineBar />
      {api && <WaitingMirror api={api} />}
      {api && (route === "chats" || route === "waiting") && <FirstRun api={api} />}
      <div className="flex min-h-0 flex-1">
        {showList && (
          <ListTag
            aria-label="Chats"
            className="flex min-h-0 w-full flex-col bg-[var(--surface)] md:w-80 md:shrink-0 md:border-r md:border-[var(--edge)]"
            data-testid="chat-list-column"
          >
            <ChatList
              api={api}
              connection={connection}
              filterWaiting={filterWaiting}
              footer={footer}
              onPairDuo={onPairDuo}
              onSignIn={onSignIn}
              onSignOutWorkspace={onSignOutWorkspace}
              route={route}
              session={session}
              titleAs={showPane ? "h2" : "h1"}
              workspaceError={workspaceError}
            />
          </ListTag>
        )}
        {showPane && (
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {!desktop && (
              <header className="flex items-center border-b border-[var(--edge)] px-2" data-testid="mobile-topbar">
                <a
                  aria-label="Back to chats"
                  className="inline-flex min-h-11 items-center gap-1 rounded-[var(--r-sm)] px-2 type-body text-[var(--muted)]"
                  data-testid="mobile-back"
                  href="#chats"
                >
                  <ChevronLeft aria-hidden="true" size={18} />
                  Chats
                </a>
              </header>
            )}
            <main className="min-h-0 flex-1 overflow-y-auto" data-testid="pane">
              {route === "chats" ? <EmptyPane hasDuo={api !== null} /> : pane}
            </main>
          </div>
        )}
      </div>
      {overlays}
    </div>
  );
}
