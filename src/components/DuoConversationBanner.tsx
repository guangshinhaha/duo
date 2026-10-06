import { Mark } from "./Mark.js";
import type { DuoConversation } from "../workspace/duoConversation.js";

/**
 * #313: the line that stays at the top of a conversation with a colleague's
 * duo, so nobody mistakes it for the colleague: whose duo this is, and that
 * it answers only within limits its owner set. Beneath it, where the
 * conversation stands when it isn't answering yet — waiting on the owner's
 * OK (#315), or declined in the duo's own words, verbatim.
 */
export function DuoConversationBanner({ conversation }: { conversation: DuoConversation }) {
  const owner = conversation.ownerLabel;
  return (
    <div className="border-b border-[var(--edge)] bg-[var(--surface-2)] px-4 py-2" data-state={conversation.state} data-testid="duo-conversation-banner">
      <p className="flex items-center gap-2 type-provenance text-[var(--muted)]" data-testid="duo-conversation-label">
        <Mark />
        <span>{`${owner}'s duo — answers within limits ${owner} set.`}</span>
      </p>
      {conversation.state === "waiting" && (
        <p className="mt-1 type-provenance text-[var(--muted)]" data-testid="duo-conversation-waiting">
          {`Waiting for ${owner}'s OK — ${owner}'s duo answers here once ${owner} allows it.`}
        </p>
      )}
      {conversation.state === "declined" && (
        <p className="mt-1 type-provenance text-[var(--muted)]" data-testid="duo-conversation-declined">
          {conversation.declineReason ?? `${owner}'s duo won't be answering in this conversation.`}
        </p>
      )}
    </div>
  );
}
