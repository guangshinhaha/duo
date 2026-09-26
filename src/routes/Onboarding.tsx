import { useEffect, useRef, useState, type ReactNode } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { useQueryClient } from "@tanstack/react-query";
import {
  queryKeys,
  useDeriveJob,
  useEmbedJob,
  useImportClaude,
  useImportPaste,
  useKnowledge,
  useStartDerive,
  useStartEmbed,
} from "../api/queries.js";
import type { ClaudeImportSummary, DeriveJobStatus, DeriveStage, DuoKnowledge, EmbedJobStatus, PasteImportSummary } from "../api/types.js";
import { MeterBar } from "../components/MeterBar.js";
import { MutationError } from "../components/MutationError.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";
import type { WorkspaceConnection } from "../workspace/matrix.js";
import { isDuoKnowledgeShape } from "./Knowledge.js";
import { Review } from "./Review.js";

/**
 * How often the flow re-asks the daemon while something is in motion —
 * the embed job's counts and, after it, derivation's facts. Human-paced:
 * these run for minutes, and a faster poll would only spend the wire.
 */
const POLL_MS = 1500;

/** Every rule the daemon has, whatever its review status — the count that says derivation has produced something. */
function ruleTotal(knowledge: DuoKnowledge): number {
  return Object.values(knowledge.rules.byReviewStatus).reduce((sum, count) => sum + count, 0);
}

/**
 * A duo with nothing in it yet: no records, no import ever run, no rules.
 * Read entirely off the daemon's own facts (#175's `GET /knowledge`) — the
 * client keeps no "first run" flag of its own, so a duo built in a terminal
 * is never mistaken for an empty one, on any device.
 */
export function isEmptyDuo(knowledge: DuoKnowledge): boolean {
  return knowledge.records.total === 0 && knowledge.lastImport === null && ruleTotal(knowledge) === 0;
}

type StepState = "done" | "current" | "waiting";

const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? "" : "s"}`;

/** The import's outcome in the daemon's own counts (`PasteImportSummary`, verbatim) — never a success story for an import that wrote nothing. */
function importSentence(result: PasteImportSummary): string {
  if (!result.workRelevant) {
    return "Nothing was imported: your daemon judged this conversation not work-relevant.";
  }
  const held =
    result.discardedAboveCeiling > 0 ? ` ${result.discardedAboveCeiling} held back above the classification ceiling.` : "";
  return `Imported ${plural(result.written, "record")}. ${result.skipped} already present.${held}`;
}

/** A Claude export's outcome in the daemon's own counts — the conversations it read, the ones it judged work, what it wrote. */
function claudeImportSentence(result: ClaudeImportSummary): string {
  if (result.workRelevantConversationCount === 0) {
    return `Read ${plural(result.conversationCount, "conversation")}; none were judged work-relevant, so nothing was imported.`;
  }
  const held =
    result.discardedAboveCeiling > 0 ? ` ${result.discardedAboveCeiling} held back above the classification ceiling.` : "";
  return `Read ${plural(result.conversationCount, "conversation")}, ${result.workRelevantConversationCount} work-relevant. Imported ${plural(
    result.written,
    "record",
  )}. ${result.skipped} already present.${held}`;
}

function Step({
  id,
  state,
  title,
  children,
}: {
  id: "import" | "embed" | "derive";
  state: StepState;
  title: string;
  children: ReactNode;
}) {
  return (
    <li
      aria-current={state === "current" ? "step" : undefined}
      className="shape-container flex flex-col gap-3 p-4"
      data-state={state}
      data-testid={`onboarding-step-${id}`}
    >
      <h2 className="type-heading">
        {title}
        {state === "done" && <span className="ml-2 type-provenance text-[var(--muted)]">done</span>}
      </h2>
      {children}
    </li>
  );
}

function ImportStep({ api, state }: { api: DuoApiConfig; state: StepState }) {
  const [transcript, setTranscript] = useState("");
  const importPaste = useImportPaste(api);
  const pending = importPaste.isPending;

  return (
    <Step id="import" state={state} title="Import your history">
      <ClaudeExportUpload api={api} />
      <p className="type-provenance text-[var(--muted)]">Or paste a single conversation:</p>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (transcript.trim() && !pending) {
            importPaste.mutate(transcript);
          }
        }}
      >
        <label className="flex flex-col gap-1 type-body">
          Conversation export
          <textarea
            className="min-h-11 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] p-2"
            disabled={pending}
            onChange={(e) => setTranscript(e.target.value)}
            rows={8}
            value={transcript}
          />
        </label>
        <p className="type-provenance text-[var(--muted)]">
          Paste the conversation as text — each turn starts a line with &quot;Me:&quot; for your words or &quot;Claude:&quot; for the reply.
          Your daemon reads it exactly as <code>duo import paste</code> does.
        </p>
        <button
          className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
          disabled={pending || transcript.trim().length === 0}
          type="submit"
        >
          {pending ? "Importing…" : "Import"}
        </button>
      </form>
      {pending && (
        <p aria-busy="true" className="type-provenance text-[var(--muted)]" data-testid="import-progress" role="status">
          Importing — your daemon is reading it.
        </p>
      )}
      {importPaste.data && (
        <p className="type-body" data-testid="import-summary">
          {importSentence(importPaste.data)}
        </p>
      )}
      <MutationError error={importPaste.error} />
    </Step>
  );
}

/**
 * A Claude data export, uploaded whole: the file is read in the browser and
 * its text sent to `POST /corpus/import-claude`, which parses it exactly as
 * `duo import claude` does. Non-work conversations are dropped by the
 * daemon's own work-relevance gate, not here.
 */
function ClaudeExportUpload({ api }: { api: DuoApiConfig }) {
  const importClaude = useImportClaude(api);
  const [readError, setReadError] = useState<string | null>(null);
  const pending = importClaude.isPending;

  return (
    <div className="flex flex-col gap-2" data-testid="claude-export">
      <label className="flex flex-col gap-1 type-body">
        Claude export (conversations.json)
        <input
          accept=".json,application/json"
          className="min-h-11 type-provenance"
          data-testid="claude-export-file"
          disabled={pending}
          onChange={(e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (!file) {
              return;
            }
            setReadError(null);
            file
              .text()
              .then((text) => importClaude.mutate(text))
              .catch(() => setReadError("Couldn't read that file. Pick the conversations.json from your export."));
          }}
          type="file"
        />
      </label>
      <p className="type-provenance text-[var(--muted)]">
        Get it from claude.ai: Settings → Privacy → Export data. Unzip the download it sends you and pick <code>conversations.json</code>.
        Only work conversations are kept.
      </p>
      {pending && (
        <p aria-busy="true" className="type-provenance text-[var(--muted)]" data-testid="claude-import-progress" role="status">
          Importing — your daemon is reading the export.
        </p>
      )}
      {importClaude.data && (
        <p className="type-body" data-testid="claude-import-summary">
          {claudeImportSentence(importClaude.data)}
        </p>
      )}
      {readError && (
        <p className="type-provenance text-[var(--refused)]" role="status">
          {readError}
        </p>
      )}
      <MutationError error={importClaude.error} />
    </div>
  );
}

function EmbedStep({
  api,
  state,
  imported,
  status,
}: {
  api: DuoApiConfig;
  state: StepState;
  imported: boolean;
  status: EmbedJobStatus | undefined;
}) {
  const start = useStartEmbed(api);
  const running = status?.state === "running";

  let body: ReactNode;
  if (!imported) {
    body = <p className="type-body text-[var(--muted)]">Waits for records to embed.</p>;
  } else {
    const shown = status && status.state !== "idle" ? status : null;
    body = (
      <>
        <p className="type-body text-[var(--muted)]">
          Embedding is what lets your duo search what it knows. It takes minutes, not seconds — this page watches it.
        </p>
        {shown && (
          <div className="flex flex-col gap-2" data-testid="embed-progress" role="status">
            <div
              aria-label="Embedding progress"
              aria-valuemax={shown.total}
              aria-valuemin={0}
              aria-valuenow={shown.embedded}
              role="progressbar"
            >
              <MeterBar value={shown.total > 0 ? shown.embedded / shown.total : 0} />
            </div>
            <span className="type-provenance text-[var(--muted)]">
              {running && shown.total === 0 ? "Starting…" : `${shown.embedded} of ${shown.total} records embedded`}
            </span>
          </div>
        )}
        {/* The daemon's own words for why the job died, verbatim. */}
        {status?.state === "error" && status.error !== null && (
          <p className="type-provenance text-[var(--refused)]" data-testid="embed-error" role="status">
            {status.error}
          </p>
        )}
        {!running && (
          <button
            className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
            disabled={start.isPending}
            onClick={() => start.mutate()}
          >
            {status?.state === "done" ? "Embed again" : "Start embedding"}
          </button>
        )}
        <MutationError error={start.error} />
      </>
    );
  }
  return (
    <Step id="embed" state={state} title="Embed it">
      {body}
    </Step>
  );
}

const STAGE_ORDER: readonly DeriveStage[] = ["pairs", "topics", "rules", "voice"];

/** Each derive stage in words — what the daemon is doing, not a percentage. */
const STAGE_WORDS: Record<DeriveStage, string> = {
  pairs: "Finding the questions you were asked and how you answered",
  topics: "Grouping them into topics",
  rules: "Writing a rule per topic, citing your answers",
  voice: "Describing how you write",
};

function DeriveStep({
  api,
  knowledge,
  state,
  status,
}: {
  api: DuoApiConfig;
  knowledge: DuoKnowledge;
  state: StepState;
  status: DeriveJobStatus | undefined;
}) {
  const start = useStartDerive(api);
  const rules = ruleTotal(knowledge);
  const running = status?.state === "running";
  const currentIndex = status?.stage ? STAGE_ORDER.indexOf(status.stage) : -1;

  return (
    <Step id="derive" state={state} title="Build its rules and voice">
      {state === "waiting" ? (
        <p className="type-body text-[var(--muted)]">Waits for embedding.</p>
      ) : (
        <>
          {state === "current" && !running && (
            <p className="type-body text-[var(--muted)]">
              Your duo reads what you imported and drafts its rules and voice from your own answers. It takes a few minutes.
            </p>
          )}
          {status && status.state !== "idle" && (
            <ol className="flex flex-col gap-1" data-testid="derive-stages" role="status">
              {STAGE_ORDER.map((stage, index) => {
                const stageState =
                  status.state === "done" || index < currentIndex
                    ? "done"
                    : index === currentIndex
                      ? status.state === "error"
                        ? "failed"
                        : "running"
                      : "waiting";
                return (
                  <li
                    className={`type-provenance ${stageState === "waiting" ? "text-[var(--faint)]" : "text-[var(--muted)]"}`}
                    data-stage={stage}
                    data-state={stageState}
                    key={stage}
                  >
                    {STAGE_WORDS[stage]}
                    {stageState === "done" ? " — done" : stageState === "running" ? "…" : stageState === "failed" ? " — failed" : ""}
                  </li>
                );
              })}
            </ol>
          )}
          {/* The daemon's own words for why the job died, verbatim. */}
          {status?.state === "error" && status.error !== null && (
            <p className="type-provenance text-[var(--refused)]" data-testid="derive-error" role="status">
              {status.error}
            </p>
          )}
          {state !== "done" && !running && (
            <button
              className="inline-flex min-h-11 items-center justify-center self-start rounded-[var(--r-sm)] bg-[var(--accent)] px-3 text-[var(--bg)] disabled:opacity-40"
              data-testid="derive-start"
              disabled={start.isPending}
              onClick={() => start.mutate()}
            >
              {status?.state === "error" ? "Try again" : "Build my duo"}
            </button>
          )}
          <MutationError error={start.error} />
          {/* The daemon's own counts, as `GET /knowledge` reports them — read, never recomputed. */}
          <p className="type-provenance text-[var(--muted)]" data-testid="derive-progress">
            {plural(knowledge.corpus.totalQuestions, "question")} found · {plural(knowledge.corpus.topicBreakdown.length, "topic")} ·{" "}
            {plural(rules, "rule")} derived
          </p>
          {status?.state === "done" && rules === 0 && (
            <p className="type-body text-[var(--muted)]" data-testid="derive-no-rules">
              Finished, but no rules came out yet — usually too little history. Import more conversations, embed, and build again.
            </p>
          )}
          {state === "done" && (
            <a className="inline-flex min-h-11 items-center self-start underline" href="#mirror">
              Review your rules in the Mirror
            </a>
          )}
        </>
      )}
    </Step>
  );
}

/**
 * The first run, from the app (#49) — the Mirror onboarding `concept.md`
 * calls the trust-building moment, where the owner never writes a
 * personality, only approves a draft of it. Three steps in the order the
 * daemon does them: import, embed, derive — and it ends at the Mirror, at
 * the first derived rules, approve and reject in reach.
 *
 * Every step's state is read off the daemon, never remembered here:
 * records mean the import is done, the embed job's own status is the
 * embed's, rules mean derivation has produced something. So a refresh, a
 * second device, or a terminal run alongside all agree, and the flow
 * resumes where the daemon actually is.
 *
 * The surface adds no behaviour: import and embed are #176's routes, and
 * derivation is the daemon's derive job (`POST`/`GET /corpus/derive` —
 * pairs, topics, rules, voice, the same stages `duo derive` runs). Its
 * effect is still read off `GET /knowledge`: the first rule is the finish.
 */
export function Onboarding({ api, onFinish, pollMs = POLL_MS }: { api: DuoApiConfig; onFinish: () => void; pollMs?: number }) {
  const embed = useEmbedJob(api, pollMs);
  const derive = useDeriveJob(api, pollMs);
  const deriveStarted = derive.data?.state === "running" || derive.data?.state === "done" || derive.data?.state === "error";
  // The embed job is process-bound, so a daemon restart forgets it ran; a
  // derive job that has started at all proves embedding was already done.
  const embedDone = embed.data?.state === "done" || deriveStarted;
  // A finished derive job has moved what Knowledge counts — re-read it once
  // so the first rules land (and onboarding finishes) without waiting on a poll.
  const queryClient = useQueryClient();
  const deriveState = derive.data?.state;
  useEffect(() => {
    if (deriveState === "done") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.knowledge });
    }
  }, [deriveState, queryClient]);
  const knowledge = useKnowledge(api, {
    // Derivation is watched only once there is something to watch: after
    // embedding, until the first rule exists.
    refetchInterval: (query) => {
      const data = query.state.data;
      return embedDone && data && isDuoKnowledgeShape(data) && ruleTotal(data) === 0 ? pollMs : false;
    },
  });
  const data = knowledge.data && isDuoKnowledgeShape(knowledge.data) ? knowledge.data : null;

  // Onboarding ends when derivation produces the first rules *while the
  // owner is here* — a duo that already had rules when this opened is
  // pointed at the Mirror, never whisked there.
  const startedWithoutRules = useRef<boolean | null>(null);
  const finished = useRef(false);
  const rules = data ? ruleTotal(data) : null;
  useEffect(() => {
    if (rules === null) {
      return;
    }
    if (startedWithoutRules.current === null) {
      startedWithoutRules.current = rules === 0;
    }
    if (startedWithoutRules.current && rules > 0 && !finished.current) {
      finished.current = true;
      onFinish();
    }
  }, [rules, onFinish]);

  if (knowledge.isLoading) {
    return <RouteLoading variant="panels" />;
  }
  if (knowledge.error) {
    return <RouteError api={api} error={knowledge.error} onRetry={() => void knowledge.refetch()} />;
  }
  if (!data) {
    return <RouteLoading variant="panels" />;
  }

  // A later step done implies the earlier ones: rules exist only over
  // embedded records, whichever surface derived them.
  const deriveDone = rules !== null && rules > 0;
  const imported = data.records.total > 0;
  const importState: StepState = imported || deriveDone ? "done" : "current";
  const embedState: StepState = embedDone || deriveDone ? "done" : imported ? "current" : "waiting";
  const deriveStepState: StepState = deriveDone ? "done" : embedDone ? "current" : "waiting";

  return (
    <div className="flex flex-col gap-6 p-6" data-testid="onboarding">
      <header className="flex flex-col gap-1">
        <h1 className="type-heading">Build your duo</h1>
        <p className="type-provenance text-[var(--muted)]">
          Import your history, let it be embedded and derived, then approve or reject what your duo learned. You never write it — you approve a draft of it.
        </p>
      </header>
      <ol aria-label="Steps" className="flex max-w-xl flex-col gap-4">
        <ImportStep api={api} state={importState} />
        <EmbedStep api={api} imported={imported} state={embedState} status={embed.data} />
        <DeriveStep api={api} knowledge={data} state={deriveStepState} status={derive.data} />
      </ol>
    </div>
  );
}

/**
 * The default surface's door to onboarding (#49): Review, unless the
 * daemon says this duo is empty — then the address moves to `#onboarding`,
 * where the first run lives. A duo already built in a terminal is never
 * empty by the daemon's own facts, so it opens on Review exactly as
 * before. Review renders while the read is in flight and for any payload
 * that is not the daemon's documented shape: only a definite "empty" ever
 * redirects.
 */
export function ReviewOrFirstRun({ api, connection = null }: { api: DuoApiConfig; connection?: WorkspaceConnection | null }) {
  const knowledge = useKnowledge(api);
  const empty = !!knowledge.data && isDuoKnowledgeShape(knowledge.data) && isEmptyDuo(knowledge.data);
  useEffect(() => {
    if (empty) {
      window.location.hash = "#onboarding";
    }
  }, [empty]);
  return <Review api={api} connection={connection} />;
}
