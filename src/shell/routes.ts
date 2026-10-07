/**
 * The client's addresses (docs/design-language.md §6.3), chat-first: home is
 * the chat list, a conversation is `#chat/:id`, the duo is a chat of its own
 * (`#duo`) with a profile behind its name (`#duo/profile/:tab`). One module,
 * pure: no React, so the grammar and every old address's new home are
 * unit-testable without a DOM.
 *
 * Old addresses still work — a bookmark, a notification's tag, an invite in a
 * chat — and `routeFromHash` resolves them to their new home directly, so a
 * stale link renders the right surface on its first paint. `canonicalHash`
 * says what the address bar should read afterwards; the shell rewrites it in
 * place (no history entry) so the bar never keeps teaching the retired names.
 *
 * #225: a `matrix.to` permalink's own fragment (`#/!room:server/$event`) is
 * read the same way — a foreign grammar, not a retired one, but resolved to
 * `#chat/<room>/<event>` by the same door, and rewritten the same way once
 * resolved.
 */

/** Plain addresses (`#name`) that are one surface each. */
export const NAMED_ROUTES = [
  "chats",
  "waiting",
  "mentions",
  "duo",
  "confirmations",
  "later",
  "settings",
  "onboarding",
  "admin",
  // #324: where the OS's share sheet lands (`public/sw.js` redirects a
  // caught share here) — the picker that chooses a conversation or Your duo.
  "share",
] as const;

export type NamedRoute = (typeof NAMED_ROUTES)[number];

/** The five tabs of the duo's profile (tap its name). */
export const PROFILE_TABS = ["portrait", "knows", "may", "rules", "activity"] as const;
export type ProfileTab = (typeof PROFILE_TABS)[number];

/**
 * The parts of Settings, in the order they are listed. They read like
 * preferences, not plumbing (docs/design-language.md §6.2): the daemon's
 * address and token, and signing out of a workspace, live only under
 * Advanced, and ending your duo is a section of its own, last. `needsDuo`
 * marks the ones that mean nothing without a paired duo.
 */
export const SETTINGS_SECTIONS = [
  { id: "notifications", label: "Notifications", about: "Do not disturb, quiet hours, and what was held back.", needsDuo: false },
  { id: "appearance", label: "Appearance", about: "Light or dark, and the keyboard shortcuts.", needsDuo: false },
  { id: "sending", label: "Sending", about: "Time to undo a Send, and the working hours Send later uses.", needsDuo: false },
  { id: "profile", label: "Profile", about: "Your own name and picture in this workspace.", needsDuo: false },
  { id: "status", label: "Status & presence", about: "A status with an end time, and whether colleagues see you online.", needsDuo: false },
  { id: "privacy", label: "Privacy & data", about: "Where your data goes, in plain words, and a switch for each source.", needsDuo: true },
  { id: "devices", label: "Devices", about: "The devices that can reach your duo. Pair another, or cut one off.", needsDuo: true },
  { id: "links", label: "Ask links", about: "Links that let a colleague ask your duo something.", needsDuo: true },
  { id: "claude", label: "Connect to Claude", about: "Use your duo from claude.ai.", needsDuo: true },
  { id: "advanced", label: "Advanced", about: "Workspace sign-in, this device's connection, and your account.", needsDuo: false },
  { id: "end", label: "End this duo", about: "Delete your duo and everything it learned.", needsDuo: true },
] as const;

export type SettingsSectionId = (typeof SETTINGS_SECTIONS)[number]["id"];

export type Route =
  | NamedRoute
  | { draft: string }
  | { adminOrg: string }
  | { profile: ProfileTab }
  | { settings: SettingsSectionId }
  | { chat: string; at?: string }
  | { thread: { roomId: string; rootEventId: string; at?: string } };

/** Retired single-word addresses and where each one lives now. */
const LEGACY_ROUTES: Readonly<Record<string, string>> = {
  review: "#waiting",
  conversations: "#chats",
  corrections: "#duo/profile/rules",
  mirror: "#duo/profile/portrait",
  knowledge: "#duo/profile/knows",
  channels: "#duo/profile/knows",
  trust: "#duo/profile/may",
  audit: "#duo/profile/activity",
  escalations: "#duo/profile/activity",
};

function decode(part: string | undefined): string {
  try {
    return decodeURIComponent(part ?? "");
  } catch {
    return ""; // a malformed escape is no id at all
  }
}

/**
 * Resolves an address to a route. A retired address resolves to its new
 * home; an unknown or empty one to `fallback` (the shell's default surface).
 */
export function routeFromHash(hash: string, fallback: Route = "chats"): Route {
  if (hash.startsWith("#admin/")) {
    const id = decode(hash.slice("#admin/".length));
    return id ? { adminOrg: id } : "admin";
  }
  if (hash.startsWith("#draft/")) {
    const id = decode(hash.slice("#draft/".length));
    return id ? { draft: id } : fallback;
  }
  if (hash.startsWith("#duo/profile")) {
    const tab = decode(hash.slice("#duo/profile".length).replace(/^\//, ""));
    return { profile: (PROFILE_TABS as readonly string[]).includes(tab) ? (tab as ProfileTab) : "portrait" };
  }
  if (hash.startsWith("#chat/")) {
    // `#chat/<room>/thread/<root>[/<at>]` is a thread; `#chat/<room>[/<event>]`
    // lands at an event in context (a search hit's address). Every part is
    // encoded whole, so a `/` is the grammar's own.
    const parts = hash.slice("#chat/".length).split("/");
    const roomId = decode(parts[0]);
    if (!roomId) {
      return "chats";
    }
    if (parts[1] === "thread") {
      const rootEventId = decode(parts[2]);
      const at = decode(parts[3]);
      return rootEventId ? { thread: { roomId, rootEventId, ...(at ? { at } : {}) } } : { chat: roomId };
    }
    const at = decode(parts[1]);
    return { chat: roomId, ...(at ? { at } : {}) };
  }
  // #225: a `matrix.to` permalink's own fragment — `#/!room:server/$event`,
  // optionally `?via=…` — landing here directly when a copied link (one
  // this app's own "Copy link" hands out, or another client's) opens
  // against this app. Only a room id names a conversation unambiguously
  // (never an alias): the same rule `workspace/drafts.ts`'s `conversationOf`
  // already holds for a draft's own provenance permalink.
  if (hash.startsWith("#/!")) {
    const address = hash.slice("#/".length).split("?")[0] ?? "";
    const [room, event] = address.split("/");
    const roomId = decode(room);
    if (!roomId.startsWith("!")) {
      return "chats";
    }
    const at = event === undefined ? "" : decode(event);
    return at.startsWith("$") ? { chat: roomId, at } : { chat: roomId };
  }
  // Legacy: `#room/<room>[/<event>]` and `#thread/<room>/<root>[/<at>]`.
  if (hash.startsWith("#room/")) {
    const parts = hash.slice("#room/".length).split("/");
    const roomId = decode(parts[0]);
    const at = decode(parts[1]);
    return roomId ? { chat: roomId, ...(at ? { at } : {}) } : "chats";
  }
  if (hash.startsWith("#thread/")) {
    const parts = hash.slice("#thread/".length).split("/");
    const roomId = decode(parts[0]);
    const rootEventId = decode(parts[1]);
    const at = decode(parts[2]);
    return roomId && rootEventId ? { thread: { roomId, rootEventId, ...(at ? { at } : {}) } } : "chats";
  }
  const legacy = Object.entries(LEGACY_ROUTES).find(([name]) => hash === `#${name}`);
  if (legacy) {
    return routeFromHash(legacy[1], fallback);
  }
  const named = NAMED_ROUTES.find((name) => hash === `#${name}`);
  if (named) {
    return named;
  }
  if (hash.startsWith("#settings/")) {
    const id = decode(hash.slice("#settings/".length).split("/")[0]);
    const section = SETTINGS_SECTIONS.find((entry) => entry.id === id);
    return section ? { settings: section.id } : "settings";
  }
  return fallback;
}

/** The address a route reads as — what the bar shows once a retired address has been resolved. */
export function canonicalHash(route: Route): string {
  if (typeof route === "string") {
    return `#${route}`;
  }
  if ("draft" in route) {
    return `#draft/${encodeURIComponent(route.draft)}`;
  }
  if ("adminOrg" in route) {
    return `#admin/${encodeURIComponent(route.adminOrg)}`;
  }
  if ("profile" in route) {
    return route.profile === "portrait" ? "#duo/profile" : `#duo/profile/${route.profile}`;
  }
  if ("settings" in route) {
    return `#settings/${route.settings}`;
  }
  if ("chat" in route) {
    const room = encodeURIComponent(route.chat);
    return route.at ? `#chat/${room}/${encodeURIComponent(route.at)}` : `#chat/${room}`;
  }
  const { roomId, rootEventId, at } = route.thread;
  const base = `#chat/${encodeURIComponent(roomId)}/thread/${encodeURIComponent(rootEventId)}`;
  return at ? `${base}/${encodeURIComponent(at)}` : base;
}

/** True when `hash` is a retired address — the shell rewrites those in place. */
export function isLegacyHash(hash: string): boolean {
  return (
    hash.startsWith("#room/") ||
    hash.startsWith("#thread/") ||
    hash.startsWith("#/!") || // #225: a matrix.to permalink's own fragment
    Object.keys(LEGACY_ROUTES).some((name) => hash === `#${name}`)
  );
}

/** The room a route is about, if any — what "the conversation on screen" means for a notification. */
export function roomOfRoute(route: Route): string | null {
  if (typeof route === "string") {
    return null;
  }
  if ("chat" in route) {
    return route.chat;
  }
  if ("thread" in route) {
    return route.thread.roomId;
  }
  return null;
}

/**
 * What makes one surface a *different* surface, for the shell's pane
 * transition (docs/motion-plan.md B5): a chat opening another chat is a new
 * pane, but moving between the duo's profile tabs, or between Settings'
 * sections, or to another message in the same chat, is the same pane
 * changing its mind — it must not remount (and must not animate).
 */
export function paneKey(route: Route): string {
  if (typeof route === "string") {
    return route;
  }
  if ("draft" in route) {
    return `draft:${route.draft}`;
  }
  if ("chat" in route) {
    return `chat:${route.chat}`;
  }
  if ("thread" in route) {
    return `thread:${route.thread.roomId}:${route.thread.rootEventId}`;
  }
  if ("profile" in route) {
    return "profile";
  }
  if ("settings" in route) {
    return "settings";
  }
  return "admin";
}
