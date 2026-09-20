import { useOutbox } from "../outbox.js";

/**
 * #61: the owner's undelivered messages, in the order they were typed.
 * Pending entries are the honest state — held on this device, going out
 * when the workspace answers again — so the pending line is quiet, the
 * same expected-state voice as the daemon-asleep bar. A failed entry is
 * the one place the outbox raises its voice: what happened, verbatim,
 * that the text is kept, and a retry that is the owner's choice to press.
 *
 * The workspace conversation surface (post-#185) embeds this above its
 * composer; the component is mounted wherever messages are typed.
 */
export function QueuedMessages() {
  const { messages, retry } = useOutbox();
  if (messages.length === 0) {
    return null;
  }
  return (
    <div data-testid="queued-messages" className="flex flex-col gap-2">
      {messages.map((message) => (
        <div
          key={message.id}
          data-testid="queued-message"
          data-state={message.state}
          className="rounded-[var(--r-md)] border border-dashed border-[var(--edge)] px-4 py-3"
        >
          <p className="whitespace-pre-wrap type-body text-[var(--text)]">{message.text}</p>
          {message.state !== "failed" ? (
            <p data-testid="queued-pending" className="mt-1 type-provenance text-[var(--muted)]">
              {message.state === "sending" ? "Sending…" : "Sending when the workspace is back"}
            </p>
          ) : (
            <>
              <p data-testid="queued-error" className="mt-1 type-provenance text-[var(--escalate)]">
                Couldn&apos;t send — {message.error}. Your message is kept here.
              </p>
              <button
                data-testid="queued-retry"
                className="mt-1 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 py-1 type-provenance"
                onClick={() => retry(message.id)}
              >
                Retry
              </button>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
