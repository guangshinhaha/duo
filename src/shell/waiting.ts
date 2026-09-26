import { useQuery } from "@tanstack/react-query";
import type { DuoApiConfig } from "../api/client.js";
import { usePendingDrafts, usePendingT4 } from "../api/queries.js";
import type { DraftRecord, PendingT4RequestForJudgement } from "../api/types.js";
import { hairlineState, type HairlineState } from "../components/ConfidenceHairline.js";
import { toDraftPipelineResult } from "../components/DraftCard.js";
import { conversationOf } from "../workspace/drafts.js";
import { roomHref } from "../workspace/links.js";
import type { RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";

/**
 * Where a piece of waiting work is decided (docs/design-language.md §6.2):
 *
 * - `chat`: a draft for a message that arrived in a conversation the member
 *   holds — decided in that chat's tray.
 * - `duo`: an answer to a question the owner asked their own duo — decided in
 *   Your duo.
 * - `draft`: a draft with no chat of its own (a question bridged from
 *   Slack, a row that predates provenance) — decided on its own page until
 *   bridged questions become chats (#150).
 * - `confirmations`: an action staged for the owner's explicit yes.
 */
export type WaitingKind = "chat" | "duo" | "draft" | "confirmations";

export interface WaitingItem {
  /** Stable across refreshes: the room id, the draft id, or the kind. */
  readonly key: string;
  readonly kind: WaitingKind;
  readonly href: string;
  /** The room, for a chat. */
  readonly roomId: string | null;
  /** How many decisions wait behind this row. */
  readonly count: number;
  /** When the oldest of them arrived — rows sort by it, oldest first: the longest wait leads. */
  readonly oldestAt: string;
  /** The oldest one's state, in the hairline's own terms; `null` for a confirmation, which has no hairline. */
  readonly state: HairlineState | null;
  /** Whose question or what work, when there is no room to name it (a bridged asker, a channel). */
  readonly label: string | null;
  /** The question, for a draft row that has no chat above it to hold it. */
  readonly question: string | null;
}

/** The words a row's preview line uses for what waits. */
export function waitingWords(item: Pick<WaitingItem, "kind" | "state" | "count">): string {
  if (item.kind === "confirmations") {
    return item.count === 1 ? "An action needs your yes" : `${item.count} actions need your yes`;
  }
  if (item.count > 1) {
    return `${item.count} waiting on you`;
  }
  switch (item.state) {
    case "escalated":
      return "Passed to you";
    case "refused":
      return "Refused";
    case "hedged":
      return "Draft · hedging";
    default:
      return "Draft ready";
  }
}

const byAge = (a: { oldestAt: string }, b: { oldestAt: string }): number => a.oldestAt.localeCompare(b.oldestAt);

function askerOf(draft: DraftRecord): string | null {
  const provenance = draft.provenance;
  return provenance?.origin === "channel" ? `${provenance.channelKind} · ${provenance.askerRef}` : null;
}

/**
 * Folds the two queues the daemon keeps — pending drafts and staged
 * confirmations — into the rows of the "Waiting on you" filter. Pure: the
 * caller says which rooms the member holds (a draft only belongs to a chat
 * the member can open) and this decides where each piece of work lives.
 */
export function buildWaitingItems(
  drafts: readonly DraftRecord[],
  confirmations: readonly Pick<PendingT4RequestForJudgement, "createdAt">[],
  rooms: readonly Pick<RoomSummary, "roomId">[],
): WaitingItem[] {
  const held = new Set(rooms.map((room) => room.roomId));
  const groups = new Map<string, DraftRecord[]>();
  const single: DraftRecord[] = [];
  const add = (key: string, draft: DraftRecord): void => {
    groups.set(key, [...(groups.get(key) ?? []), draft]);
  };
  for (const draft of drafts) {
    const conversation = conversationOf(draft.provenance);
    if (conversation !== null && held.has(conversation.roomId)) {
      add(`chat:${conversation.roomId}`, draft);
    } else if (draft.provenance?.origin === "owner") {
      add("duo", draft);
    } else {
      single.push(draft);
    }
  }
  const oldest = (list: readonly DraftRecord[]): DraftRecord => [...list].sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0]!;
  const items: WaitingItem[] = [];
  for (const [key, list] of groups) {
    const first = oldest(list);
    const chat = key.startsWith("chat:");
    const roomId = chat ? key.slice("chat:".length) : null;
    items.push({
      key: chat ? roomId! : "duo",
      kind: chat ? "chat" : "duo",
      href: chat ? roomHref(roomId!) : "#duo",
      roomId,
      count: list.length,
      oldestAt: first.createdAt,
      state: hairlineState(toDraftPipelineResult(first)),
      label: null,
      question: null,
    });
  }
  for (const draft of single) {
    items.push({
      key: draft.id,
      kind: "draft",
      href: `#draft/${encodeURIComponent(draft.id)}`,
      roomId: null,
      count: 1,
      oldestAt: draft.createdAt,
      state: hairlineState(toDraftPipelineResult(draft)),
      label: askerOf(draft),
      question: draft.question,
    });
  }
  if (confirmations.length > 0) {
    items.push({
      key: "confirmations",
      kind: "confirmations",
      href: "#confirmations",
      roomId: null,
      count: confirmations.length,
      oldestAt: [...confirmations].map((c) => c.createdAt).sort()[0]!,
      state: null,
      label: null,
      question: null,
    });
  }
  return items.sort(byAge);
}

/** The workspace's rooms, read from the one cache entry every workspace surface shares. */
export function useHeldRooms(connection: WorkspaceConnection | null): readonly RoomSummary[] {
  const rooms = useQuery({
    queryKey: ["workspace", "rooms"],
    queryFn: () => connection!.rooms(),
    enabled: connection !== null,
    meta: { target: "workspace" },
  });
  return rooms.data ?? [];
}

/** What is waiting on the owner, as rows — and the loading state of the two queues behind it. */
export function useWaitingItems(api: DuoApiConfig | null, connection: WorkspaceConnection | null) {
  const drafts = usePendingDrafts(api);
  const confirmations = usePendingT4(api);
  const rooms = useHeldRooms(connection);
  const items = buildWaitingItems(drafts.data ?? [], confirmations.data ?? [], rooms);
  return {
    items,
    /** Decisions, not rows: what every count in the app says. */
    count: items.reduce((total, item) => total + item.count, 0),
    isLoading: drafts.isLoading,
    error: drafts.error,
    refetch: () => void drafts.refetch(),
  };
}

/**
 * The one number: drafts nobody has decided (a passed-on question is a draft
 * too) plus actions staged for an explicit yes. The chip, the dock, the menu
 * bar and the window title all read it from here, so they cannot disagree.
 * `null` (no duo paired) is nothing waiting.
 */
export function useWaitingCount(api: DuoApiConfig | null): number {
  const drafts = usePendingDrafts(api);
  const confirmations = usePendingT4(api);
  return (drafts.data?.length ?? 0) + (confirmations.data?.length ?? 0);
}
