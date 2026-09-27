import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { ChevronLeft, X } from "lucide-react";
import type { DuoApiConfig } from "../api/client.js";
import { Mark } from "../components/Mark.js";
import { OfflineBar } from "../components/OfflineBar.js";
import { useFirstRunRedirect } from "../routes/Onboarding.js";
import { setDockBadgeCount } from "../dockBadge.js";
import { setTrayPendingCount } from "../tray.js";
import type {
  WorkspaceConnection,
  WorkspaceSession,
} from "../workspace/matrix.js";
import { ChatList } from "./ChatList.js";
import { useWaitingCount } from "./waiting.js";
import { DESKTOP_QUERY, useMediaQuery } from "./useMediaQuery.js";
import { InspectorBody, useInspectorTarget } from "./Inspector.js";
import { InfoPanelProvider } from "./InspectorContext.js";
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

/** The inspector column needs room for three columns; below this it gives way and the tray's Why? sheet takes over. */
export const INSPECTOR_QUERY = "(min-width: 1100px)";
const INSPECTOR_KEY = "duo.inspector";

/** Whether the owner has the Info panel open — remembered on this device, closed by default (#184). */
function useInspectorPreference(): [boolean, (open: boolean) => void] {
  const [open, setOpenState] = useState(() => {
    try {
      return localStorage.getItem(INSPECTOR_KEY) === "open";
    } catch {
      return false;
    }
  });
  const setOpen = (next: boolean): void => {
    setOpenState(next);
    try {
      localStorage.setItem(INSPECTOR_KEY, next ? "open" : "closed");
    } catch {
      // not remembered: it simply follows this session
    }
  };
  return [open, setOpen];
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
    <div
      className="m-auto flex max-w-sm flex-col items-center gap-3 p-6 text-center"
      data-testid="chats-empty-pane"
    >
      <Mark />
      <h1 className="type-heading">Your chats</h1>
      <p className="type-body text-[var(--muted)]">
        {hasDuo
          ? "Pick a conversation, or ask your duo anything. When someone asks you something, your duo's draft waits above the box you reply in, and only you can see it."
          : "Pick a conversation to start."}
      </p>
      {hasDuo && (
        <a
          className="inline-flex min-h-11 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body"
          href="#duo"
        >
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
  // The Info panel (#184): a third column only when the owner opens it — from the chat header or ⌘I — and there is room.
  const wide = useMediaQuery(INSPECTOR_QUERY);
  const target = useInspectorTarget(api, connection, route);
  const [inspectorOn, setInspectorOn] = useInspectorPreference();
  const showInspector = desktop && wide && target !== null && inspectorOn;
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (
        (e.metaKey || e.ctrlKey) &&
        !e.altKey &&
        e.key.toLowerCase() === "i"
      ) {
        e.preventDefault();
        setInspectorOn(!inspectorOn);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });
  // The page has exactly one main landmark: the open surface — or, on a
  // phone's home screen where the list is all there is, the list itself.
  const ListTag = showPane ? "aside" : "main";
  return (
    // Installed on a phone the page runs edge to edge (`viewport-fit=cover`), so the notch and the home indicator are kept clear here; everywhere else these insets are zero.
    <div className="box-border flex h-dvh flex-col bg-[var(--bg)] pt-[env(safe-area-inset-top)] pr-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)] pl-[env(safe-area-inset-left)] text-[var(--text)]">
      {banners}
      <OfflineBar />
      {api && <WaitingMirror api={api} />}
      {api && (route === "chats" || route === "waiting") && (
        <FirstRun api={api} />
      )}
      <InfoPanelProvider value={{ available: desktop && wide && target !== null, open: inspectorOn, toggle: () => setInspectorOn(!inspectorOn) }}>
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
                <header
                  className="flex items-center border-b border-[var(--edge)] px-2"
                  data-testid="mobile-topbar"
                >
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
              <main
                className="relative min-h-0 flex-1 overflow-y-auto"
                data-testid="pane"
              >
                {route === "chats" ? <EmptyPane hasDuo={api !== null} /> : pane}
              </main>
            </div>
          )}
          {showInspector && target && (
            <aside
              aria-label="Info"
              className="flex min-h-0 w-80 shrink-0 flex-col overflow-y-auto border-l border-[var(--edge)] bg-[var(--surface)]"
              data-testid="inspector"
            >
              <div className="flex justify-end px-2 pt-2">
                <button
                  aria-label="Hide info (⌘I)"
                  className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-[var(--r-md)] text-[var(--muted)]"
                  data-testid="inspector-hide"
                  onClick={() => setInspectorOn(false)}
                  type="button"
                >
                  <X aria-label="Hide info" size={18} />
                </button>
              </div>
              <div className="p-4 pt-0">
                <InspectorBody target={target} />
              </div>
            </aside>
          )}
        </div>
      </InfoPanelProvider>
      {overlays}
    </div>
  );
}
