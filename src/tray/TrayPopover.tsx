import { QueryClient, QueryClientProvider, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useApiConfig } from "../api/config.js";
import { usePendingDrafts, usePendingT4, useRecordOutcome } from "../api/queries.js";
import type { DraftRecord } from "../api/types.js";
import { hairlineState, type HairlineState } from "../components/ConfidenceHairline.js";
import { toDraftPipelineResult } from "../components/DraftCard.js";
import { DuoLine } from "../components/DuoLine.js";
import { Mark } from "../components/Mark.js";
import { MutationError } from "../components/MutationError.js";
import { Timestamp } from "../components/Timestamp.js";
import { announceDraftsChanged, hideTray, openInApp } from "../shell/native.js";
import { askerLine } from "../shell/bridged.js";
import { canSendOutside, draftHref } from "../shell/waiting.js";
import { SyncStatusProvider, useSyncStatus } from "../sync.js";
import { conversationOf } from "../workspace/drafts.js";
import { localpartOf } from "../workspace/identity.js";

/** What the state line says, in the vocabulary's words. */
const STATE_WORDS: Readonly<Record<HairlineState, string>> = {
  confident: "Draft ready",
  hedged: "Draft · hedging",
  escalated: "Passed to you",
  refused: "Refused",
};

/** Who asked, as a person would read it: a workspace member by name, a bridged asker with their platform. */
function whoAsked(draft: DraftRecord): string {
  const provenance = draft.provenance;
  if (provenance?.origin === "channel" && conversationOf(provenance) !== null) {
    return localpartOf(provenance.askerRef);
  }
  return askerLine(draft) ?? "Someone";
}

/**
 * One waiting draft in the menu-bar tray. A confident draft shows what would
 * be sent and can be sent from here — the same decision, the same record, as
 * the draft tray's Send. Anything else says what state it is in and opens the
 * app at its chat: a hedged draft wants its reasoning read, a passed-on
 * question and a refusal have nothing to send.
 */
function TrayRow({ api, draft, reachable }: { api: DuoApiConfig; draft: DraftRecord; reachable: boolean }) {
  const send = useRecordOutcome(api);
  const state = hairlineState(toDraftPipelineResult(draft));
  const sendable = canSendOutside(draft);
  return (
    <li className="flex flex-col gap-2 border-b border-[var(--edge)] px-3 py-3" data-testid="tray-row">
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate type-body" data-testid="tray-asker">
          {whoAsked(draft)}
        </span>
        <span className="shrink-0 type-provenance text-[var(--faint)]">
          <Timestamp iso={draft.createdAt} />
        </span>
      </div>
      <p className="line-clamp-2 type-provenance text-[var(--muted)]" data-testid="tray-question">
        {draft.question}
      </p>
      {sendable && (
        <DuoLine attributionTestId="tray-draft-attribution" compact label="Your duo" state={state} testId="tray-draft">
          <p className="line-clamp-3 type-body" data-testid="tray-draft-text">
            {draft.draftText}
          </p>
        </DuoLine>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="type-provenance text-[var(--muted)]" data-testid="tray-state">
          {send.isSuccess ? "Sent" : STATE_WORDS[state]}
        </span>
        <span className="flex items-center gap-2">
          <button
            className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance"
            data-testid="tray-open"
            onClick={() => void openInApp(draftHref(draft))}
            type="button"
          >
            Open
          </button>
          {sendable && (
            <button
              className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] bg-[var(--accent)] px-3 type-provenance text-[var(--bg)] disabled:opacity-40"
              data-testid="tray-send"
              disabled={send.isPending || send.isSuccess || !reachable}
              onClick={() =>
                send.mutate(
                  { draftId: draft.id, outcome: "sent" },
                  // The other window's lists and counts, without waiting for their next look.
                  { onSuccess: () => void announceDraftsChanged() },
                )
              }
              type="button"
            >
              Send
            </button>
          )}
        </span>
      </div>
      <MutationError error={send.error} />
    </li>
  );
}

/** The popover itself: what waits, oldest first, and the one thing that may be done without opening the app. */
export function TrayPopover({ api }: { api: DuoApiConfig | null }) {
  const queryClient = useQueryClient();
  const { reachable } = useSyncStatus();
  const drafts = usePendingDrafts(api);
  const confirmations = usePendingT4(api);

  // Shown and hidden over and over without being remounted, so look again whenever it is looked at, and now and then while it is.
  useEffect(() => {
    const refresh = (): void => void queryClient.invalidateQueries();
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 20_000);
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        void hideTray();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("focus", refresh);
      window.removeEventListener("keydown", onKey);
      clearInterval(timer);
    };
  }, [queryClient]);

  const waiting = [...(Array.isArray(drafts.data) ? drafts.data : [])].filter((draft) => draft.outcome === null).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const staged = Array.isArray(confirmations.data) ? confirmations.data.length : 0;
  const count = waiting.length + staged;

  return (
    <main className="flex h-screen flex-col bg-[var(--bg)] text-[var(--text)]" data-testid="tray-popover">
      <header className="flex items-center justify-between gap-2 border-b border-[var(--edge)] px-3 py-2">
        <h1 className="flex items-center gap-2 type-heading">
          <Mark />
          <span>Waiting on you</span>
          {count > 0 && (
            <span className="type-identifier text-[var(--accent)]" data-testid="tray-count">
              {count}
            </span>
          )}
        </h1>
        <button
          className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance"
          data-testid="tray-open-app"
          onClick={() => void openInApp("#waiting")}
          type="button"
        >
          Open Duo
        </button>
      </header>
      {api && !reachable && (
        <p className="border-b border-[var(--edge)] px-3 py-2 type-provenance text-[var(--escalate)]" data-testid="tray-offline" role="status">
          Can’t reach your duo — sending is off until it answers.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {!api ? (
          <p className="p-4 type-body text-[var(--muted)]" data-testid="tray-unpaired">
            This device isn’t paired with a duo yet. Open Duo to set it up.
          </p>
        ) : count === 0 ? (
          <p className="p-4 type-body text-[var(--muted)]" data-testid="tray-empty">
            Nothing waiting on you.
          </p>
        ) : (
          <ul>
            {waiting.map((draft) => (
              <TrayRow api={api} draft={draft} key={draft.id} reachable={reachable} />
            ))}
            {staged > 0 && (
              <li className="flex items-center justify-between gap-2 px-3 py-3" data-testid="tray-confirmations">
                <span className="type-body">{staged === 1 ? "An action needs your yes" : `${staged} actions need your yes`}</span>
                {/* Never decided outside the app: an action that changes something outside wants the whole picture (AR-17). */}
                <button
                  className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-provenance"
                  data-testid="tray-open-confirmations"
                  onClick={() => void openInApp("#confirmations")}
                  type="button"
                >
                  Open
                </button>
              </li>
            )}
          </ul>
        )}
      </div>
    </main>
  );
}

/** The whole tray window: its own cache (the app's persisted one is the app's), the same sync health rule, this device's pairing. */
const trayClient = new QueryClient({ defaultOptions: { queries: { retry: 1 } } });

export function TrayApp() {
  const [api] = useApiConfig();
  return (
    <QueryClientProvider client={trayClient}>
      <SyncStatusProvider>
        <TrayPopover api={api} />
      </SyncStatusProvider>
    </QueryClientProvider>
  );
}
