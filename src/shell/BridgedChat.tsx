import type { DuoApiConfig } from "../api/client.js";
import type { DraftRecord } from "../api/types.js";
import { DeliveryStateLine } from "../components/DeliveryStateLine.js";
import { DraftTray } from "../components/DraftTray.js";
import { OwnerMessage } from "../components/OwnerMessage.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { Timestamp } from "../components/Timestamp.js";
import { askerLine, bridgedTitle, sourceLabel, useBridgedChats } from "./bridged.js";

/** Where a chat came from — on its row, in its header, on every message it holds. Never a person's status: this is a place. */
export function SourceBadge({ channelKind, testId = "source-badge" }: { channelKind: string; testId?: string }) {
  return (
    <span className="shrink-0 rounded-full border border-[var(--edge)] px-2 type-provenance text-[var(--muted)]" data-testid={testId}>
      {sourceLabel(channelKind)}
    </span>
  );
}

function dayLabel(iso: string): string {
  const when = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  return when.toDateString() === today.toDateString() ? "Today" : when.toDateString() === yesterday.toDateString() ? "Yesterday" : when.toLocaleDateString();
}

/** The asker's side of one question: their words, leading, saying which platform they said them on. */
function AskerMessage({ draft }: { draft: DraftRecord }) {
  return (
    <div className="flex max-w-[80%] flex-col gap-1" data-testid="asker-message">
      <p className="type-provenance text-[var(--muted)]" data-testid="asker-line">
        {askerLine(draft)} · <Timestamp iso={draft.createdAt} />
      </p>
      <div className="rounded-[var(--r-lg)] rounded-bl-[var(--r-sm)] border border-[var(--edge)] px-4 py-2 type-body text-[var(--text)]">{draft.question}</div>
      {draft.threadContext && (
        <p className="line-clamp-2 type-provenance text-[var(--faint)]" data-testid="asker-context">
          In the thread: {draft.threadContext}
        </p>
      )}
    </div>
  );
}

/** What you did about it, on your side — a reply that went back, or a plain note that you let it go. */
function OwnerSide({ draft }: { draft: DraftRecord }) {
  if ((draft.outcome === "sent" || draft.outcome === "edited" || draft.outcome === "escalation_answered") && draft.sentText) {
    return (
      <div className="flex flex-col items-end gap-1" data-testid="bridged-reply">
        <OwnerMessage bubble>{draft.sentText}</OwnerMessage>
        <DeliveryStateLine delivery={draft.delivery} />
      </div>
    );
  }
  if (draft.outcome === "discarded") {
    return (
      <p className="self-end type-provenance text-[var(--faint)]" data-testid="bridged-dismissed">
        You dismissed your duo’s draft.
      </p>
    );
  }
  return null;
}

/**
 * A question from another platform as a chat (#150): the person who asked
 * on their side, your replies on yours, your duo's draft in the tray above
 * where you decide it — the same tray, the same Send/Edit/Dismiss and the
 * same offline rule as any chat. Sending posts back through the bridge the
 * way it always has (the delivery line says how that went).
 *
 * It never passes for a native conversation: the header and every message
 * name the platform, and it says plainly what it does not have — the
 * platform's own thread history, which the daemon does not keep. When it
 * does, this pane fills in from it.
 */
export function BridgedChat({ api, chatId }: { api: DuoApiConfig; chatId: string }) {
  const { chats, isLoading } = useBridgedChats(api);
  const chat = chats.find((candidate) => candidate.id === chatId);

  if (isLoading && !chat) {
    return <RouteLoading />;
  }
  if (!chat) {
    return (
      <div className="flex flex-col items-start gap-3 p-6" data-testid="bridged-not-found">
        <h1 className="type-heading">Conversation</h1>
        <p className="type-body text-[var(--muted)]">This conversation isn’t in your duo’s recent questions.</p>
        <a className="type-body underline" href="#chats">
          Back to chats
        </a>
      </div>
    );
  }

  let previousDay = "";
  return (
    <div className="flex h-full flex-col" data-testid="bridged-chat">
      <header className="flex items-center gap-3 border-b border-[var(--edge)] px-4 py-3">
        <span
          aria-hidden="true"
          className="inline-flex size-10 shrink-0 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] type-identifier text-[var(--muted)]"
        >
          {bridgedTitle(chat).slice(0, 2).toUpperCase()}
        </span>
        <div className="flex min-w-0 flex-col">
          <h1 className="flex min-w-0 items-center gap-2 type-heading">
            <span className="truncate" data-testid="bridged-title">
              {bridgedTitle(chat)}
            </span>
            <SourceBadge channelKind={chat.channelKind} testId="bridged-source" />
          </h1>
          <p className="type-provenance text-[var(--faint)]" data-testid="bridged-note">
            From {sourceLabel(chat.channelKind)} — this shows the questions your duo was asked; the rest of the thread stays there.
          </p>
        </div>
      </header>
      <div className="flex-1 overflow-y-auto p-4">
        <section className="flex flex-col gap-5" data-testid="bridged-turns">
          {chat.drafts.map((draft) => {
            const day = dayLabel(draft.createdAt);
            const divider = day !== previousDay;
            previousDay = day;
            return (
              <div className="flex flex-col gap-3" data-testid="bridged-turn" key={draft.id}>
                {divider && <p className="self-center type-identifier text-[var(--faint)]">{day}</p>}
                <AskerMessage draft={draft} />
                <OwnerSide draft={draft} />
              </div>
            );
          })}
        </section>
      </div>
      {chat.waiting.length > 0 && (
        <section aria-label="Drafts from your duo" className="flex max-h-96 flex-col overflow-y-auto" data-testid="bridged-drafts">
          <p className="border-t border-[var(--edge)] px-4 pt-3 type-provenance text-[var(--muted)]">
            Only you can see your duo’s drafts — nothing is sent to {sourceLabel(chat.channelKind)} until you send one.
          </p>
          {chat.waiting.map((draft, index) => (
            <DraftTray api={api} draft={draft} key={draft.id} keyboard={index === 0} />
          ))}
        </section>
      )}
    </div>
  );
}
