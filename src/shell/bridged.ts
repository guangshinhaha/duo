import { useMemo } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useDraftsFeed, usePendingDrafts } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { conversationOf } from "../workspace/drafts.js";

/**
 * Bridged chats (#150): a question someone asked the owner on another
 * platform — Slack today — read as a chat with that person, so every reply
 * is decided in one place. The daemon keeps drafts, not conversations: a
 * bridged question is a draft whose provenance names a channel and an asker
 * but no workspace room, and it has no thread history to read (the daemon
 * stores the thread's text as `threadContext`, and offers no endpoint for
 * the messages themselves — digital-duo files that gap). So a bridged chat
 * is the drafts that share an asker or a thread, oldest first, and the
 * views built on it say so rather than pretend to a full transcript.
 *
 * Nothing here is keyed on what the channel is called (#43): the channel
 * kind is the daemon's string and is shown as it arrived.
 */

/** A bridged chat's id — opaque, and carried in the same `#chat/:id` address a room uses. It can never be a room id: those start with `!`. */
const PREFIX = "bridge:";

export interface BridgedChat {
  readonly id: string;
  /** The daemon's channel kind, as it arrived. */
  readonly channelKind: string;
  /** Everyone who asked in it, in the order they first did. */
  readonly askers: readonly string[];
  /** The drafts in it, oldest first — pending and decided alike. */
  readonly drafts: readonly DraftRecord[];
  /** The ones still waiting on the owner (a refused one is decided by the duo, not waiting). */
  readonly waiting: readonly DraftRecord[];
  /** When the last thing happened in it. */
  readonly lastAt: string;
}

export function isBridgedId(id: string): boolean {
  return id.startsWith(PREFIX);
}

/**
 * The bridged chat a draft belongs to, or `null` when it is not a bridged
 * question: an owner-asked draft, a row that predates provenance, or a
 * draft addressed to a workspace conversation (that one is a native chat's).
 * One chat per thread when the channel says which thread, else per asker.
 */
export function bridgedIdOf(draft: Pick<DraftRecord, "provenance">): string | null {
  const provenance = draft.provenance;
  if (provenance?.origin !== "channel" || conversationOf(provenance) !== null) {
    return null;
  }
  return `${PREFIX}${provenance.channelKind}:${provenance.threadId ?? provenance.askerRef}`;
}

export function bridgedHref(id: string): string {
  return `#chat/${encodeURIComponent(id)}`;
}

/** How a channel kind reads on a row or a message — its own word, first letter up, never a lookup that could go stale. */
export function sourceLabel(channelKind: string): string {
  return channelKind.length === 0 ? channelKind : channelKind[0]!.toUpperCase() + channelKind.slice(1);
}

/** "Slack · dana" — where a message came from and who said it. */
export function askerLine(draft: Pick<DraftRecord, "provenance">): string | null {
  const provenance = draft.provenance;
  return provenance?.origin === "channel" ? `${sourceLabel(provenance.channelKind)} · ${provenance.askerRef}` : null;
}

const isWaiting = (draft: DraftRecord): boolean => draft.outcome === null && !(draft.escalated && draft.refused);

/** Folds drafts into their bridged chats, most recently active first. Pure. */
export function groupBridged(drafts: readonly DraftRecord[]): BridgedChat[] {
  const byId = new Map<string, DraftRecord[]>();
  const seen = new Set<string>();
  for (const draft of drafts) {
    const id = bridgedIdOf(draft);
    if (id === null || seen.has(draft.id)) {
      continue;
    }
    seen.add(draft.id);
    byId.set(id, [...(byId.get(id) ?? []), draft]);
  }
  const chats: BridgedChat[] = [];
  for (const [id, list] of byId) {
    const ordered = [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    const first = ordered[0]!;
    const provenance = first.provenance;
    if (provenance.origin !== "channel") {
      continue;
    }
    const askers: string[] = [];
    for (const draft of ordered) {
      const ref = draft.provenance.origin === "channel" ? draft.provenance.askerRef : null;
      if (ref !== null && !askers.includes(ref)) {
        askers.push(ref);
      }
    }
    chats.push({
      id,
      channelKind: provenance.channelKind,
      askers,
      drafts: ordered,
      waiting: ordered.filter(isWaiting),
      lastAt: ordered.flatMap((draft) => [draft.createdAt, draft.outcomeRecordedAt ?? ""]).sort().pop()!,
    });
  }
  return chats.sort((a, b) => b.lastAt.localeCompare(a.lastAt));
}

/** The name a bridged chat goes by in the list: who asked. */
export function bridgedTitle(chat: Pick<BridgedChat, "askers">): string {
  return chat.askers.length === 0 ? "Unknown asker" : chat.askers.join(", ");
}

/**
 * Every bridged chat the daemon's recent drafts make up — the pending queue
 * and the newest window of the draft log, joined (a draft is in both while
 * it waits, and only the log holds it once decided).
 */
export function useBridgedChats(api: DuoApiConfig | null): { chats: BridgedChat[]; isLoading: boolean } {
  const pending = usePendingDrafts(api);
  const feed = useDraftsFeed(api);
  const pendingList = pending.data;
  const pages = feed.data?.pages;
  const chats = useMemo(() => {
    const logged = (pages ?? []).filter(Array.isArray).flat();
    return groupBridged([...(Array.isArray(pendingList) ? pendingList : []), ...logged]);
  }, [pendingList, pages]);
  return { chats, isLoading: api !== null && (pending.isLoading || feed.isLoading) };
}
