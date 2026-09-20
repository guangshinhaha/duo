import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useSyncStatus } from "./sync.js";

/**
 * #61 / §3.3's split: ordinary messages queue and deliver on reconnect;
 * drafts and duo actions are disabled, never queued (AR-15 — see the
 * disable gates in DraftCard / Composer / RuleCard, which bind the daemon's
 * health). This module is the *message* half: a device-local outbox that
 * holds what the owner typed in the order they typed it, delivers strictly
 * in that order once the workspace answers again, and on failure tells the
 * owner, keeps the text, and retries only by choice.
 *
 * Delivery runs against an injected sender — the workspace layer
 * (post-#185) provides it. Nothing here knows or invents a server route:
 * the outbox is client state machine plus a seam.
 */
export interface OutboxMessage {
  id: string;
  text: string;
  enqueuedAt: number;
  state: "pending" | "sending" | "failed";
  /** The delivery failure, shown to the owner verbatim — null until a real attempt fails. */
  error: string | null;
}

/** Delivers one message. Resolves on success; any throw is a failed delivery. */
export type OutboxSender = (message: OutboxMessage) => Promise<void>;

const STORAGE_KEY = "duo.outbox";

function load(): OutboxMessage[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) {
      return [];
    }
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    // "sending" exists only inside a live flush loop, which never survives a
    // reload — anything persisted as sending was interrupted mid-delivery.
    // Normalize to pending, in place, or the next flush would skip it and
    // deliver what is behind it: later messages jumping the queue.
    return (parsed as OutboxMessage[]).map((message) =>
      message.state === "sending" ? { ...message, state: "pending" } : message,
    );
  } catch {
    // A cache that can't be read is not a reason to lose the queue.
    return [];
  }
}

let localSeq = 0;
function newId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  localSeq += 1;
  return `outbox-${localSeq}`;
}

export class Outbox {
  private messages: OutboxMessage[] = load();
  private listeners = new Set<() => void>();
  private sender: OutboxSender | null = null;
  private canSend: () => boolean = () => false;
  private flushing = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): OutboxMessage[] => this.messages;

  /** The workspace layer's seam: its send function plus a live reachability check. */
  attach(sender: OutboxSender, canSend: () => boolean): void {
    this.sender = sender;
    this.canSend = canSend;
    void this.flush();
  }

  enqueue(text: string): void {
    const trimmed = text.trim();
    if (trimmed === "") {
      return;
    }
    this.messages = [...this.messages, { id: newId(), text: trimmed, enqueuedAt: Date.now(), state: "pending", error: null }];
    this.persist();
    this.emit();
    void this.flush();
  }

  /** The owner's choice, never automatic — resets the message to pending at its original place in line. */
  retry(id: string): void {
    if (!this.messages.some((message) => message.id === id && message.state === "failed")) {
      return;
    }
    this.messages = this.messages.map((message) =>
      message.id === id ? { ...message, state: "pending", error: null } : message,
    );
    this.persist();
    this.emit();
    void this.flush();
  }

  /**
   * Delivers strictly in order. The first undelivered message that is
   * `failed` holds the line — nothing behind it is attempted, because "in
   * order" means in order. Does nothing while the workspace is unreachable:
   * a pending message is the honest state, not a failure.
   */
  async flush(): Promise<void> {
    if (this.flushing || this.sender === null || !this.canSend()) {
      return;
    }
    this.flushing = true;
    try {
      for (;;) {
        const next = this.messages.find((message) => message.state !== "sending");
        if (next === undefined || next.state === "failed") {
          return;
        }
        this.messages = this.messages.map((message) =>
          message.id === next.id ? { ...message, state: "sending" } : message,
        );
        this.emit();
        try {
          await this.sender(next);
          // Delivered: it leaves the outbox — the conversation view owns
          // delivered messages once that surface exists.
          this.messages = this.messages.filter((message) => message.id !== next.id);
          this.persist();
          this.emit();
        } catch (err) {
          this.messages = this.messages.map((message) =>
            message.id === next.id
              ? { ...message, state: "failed", error: err instanceof Error ? err.message : String(err) }
              : message,
          );
          this.persist();
          this.emit();
          return; // head of the line failed — what's behind it waits
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  private persist(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.messages));
    } catch {
      // Storage full or unavailable: the in-memory queue still works; the
      // message is lost only if the app dies before delivery.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener();
    }
  }
}

interface OutboxApi {
  messages: OutboxMessage[];
  /** Queues a message; delivers immediately if the workspace is answering. */
  send: (text: string) => void;
  retry: (id: string) => void;
}

const OutboxContext = createContext<OutboxApi | null>(null);

export function useOutbox(): OutboxApi {
  const api = useContext(OutboxContext);
  if (api === null) {
    throw new Error("useOutbox must be used inside OutboxProvider");
  }
  return api;
}

export function OutboxProvider({ sender, children }: { sender: OutboxSender; children: ReactNode }) {
  const outbox = useMemo(() => new Outbox(), []);
  const workspace = useSyncStatus("workspace");
  // A ref the outbox's flush (triggered from enqueue deep inside click
  // handlers, outside React's render) can read for live reachability.
  // This effect is declared before the ones that consume it so a reconnect
  // commit updates the ref before any flush it triggers.
  const reachableRef = useRef(workspace.reachable);
  useEffect(() => {
    reachableRef.current = workspace.reachable;
  }, [workspace.reachable]);
  useEffect(() => {
    outbox.attach(sender, () => reachableRef.current);
  }, [outbox, sender]);
  // Reconnect is the delivery moment: health flipped to reachable → flush.
  useEffect(() => {
    if (workspace.reachable) {
      void outbox.flush();
    }
  }, [workspace.reachable, outbox]);

  const [api, setApi] = useState<OutboxApi>(() => ({
    messages: outbox.getSnapshot(),
    send: (text: string) => outbox.enqueue(text),
    retry: (id: string) => outbox.retry(id),
  }));
  useEffect(() => {
    return outbox.subscribe(() => {
      setApi((prev) => ({ ...prev, messages: outbox.getSnapshot() }));
    });
  }, [outbox]);

  return <OutboxContext.Provider value={api}>{children}</OutboxContext.Provider>;
}
