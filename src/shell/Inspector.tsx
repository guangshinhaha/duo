import type { ReactNode } from "react";
import type { DuoApiConfig } from "../api/client.js";
import type { DraftRecord } from "../api/types.js";
import { hairlineState, type HairlineState } from "../components/ConfidenceHairline.js";
import { toDraftPipelineResult } from "../components/DraftCard.js";
import { Mark } from "../components/Mark.js";
import { ProvenanceLine } from "../components/ProvenanceLine.js";
import { Timestamp } from "../components/Timestamp.js";
import type { RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";
import { roomDuoLabels, roomTitle, soleDuoLabel } from "./roomTitle.js";
import { PROFILE_TABS, type ProfileTab, type Route } from "./routes.js";
import { useHeldRooms } from "./waiting.js";

/** A duo's own reading of an answer, in words — the trust reading (vocabulary.md), never a number. */
export function whyReading(state: HairlineState): string {
  switch (state) {
    case "confident":
      return "Your duo is sure of this answer.";
    case "hedged":
      return "Your duo is less sure of this answer. Treat it as a starting point.";
    case "escalated":
      return "Outside what your duo answers on its own. It passed the question to you.";
    case "refused":
      return "A boundary you set. The system is working as designed.";
  }
}

function Field({ label, testId, children }: { label: string; testId: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <dt className="type-identifier uppercase text-[var(--faint)]">{label}</dt>
      <dd className="type-body text-[var(--muted)]">{children}</dd>
    </div>
  );
}

/**
 * Why your duo drafted this (docs/design-language.md P2: "why costs zero
 * clicks"): how sure it is, in words; the standing order it applied, each one
 * opening in your Rules; what it drew on; and who is asking and where. Every
 * string is the daemon's own — the rule and evidence labels, the asker and
 * channel exactly as sent — and none of it is a number the wire did not
 * carry. The same panel is the desktop's inspector column and the phone's
 * sheet, so the two cannot disagree.
 */
export function WhyPanel({ draft }: { draft: DraftRecord }) {
  const state = hairlineState(toDraftPipelineResult(draft));
  const rules = draft.sources.filter((source) => source.kind === "rule");
  const drew = draft.sources.filter((source) => source.kind !== "rule");
  return (
    <div className="flex flex-col gap-4" data-testid="why-panel">
      <h2 className="type-heading">Why your duo wrote this</h2>
      <dl className="flex flex-col gap-4">
        <Field label="Trust reading" testId="why-reading">
          {whyReading(state)}
        </Field>
        <Field label="Standing order" testId="why-rules">
          {rules.length === 0 ? (
            "No standing order applied."
          ) : (
            <ul className="flex flex-col gap-1">
              {rules.map((rule) => (
                <li key={rule.id}>
                  <a className="underline" data-testid="why-rule" href="#duo/profile/rules">
                    {rule.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </Field>
        <Field label="Drew on" testId="why-sources">
          {drew.length === 0 ? (
            "Nothing it could cite."
          ) : (
            <>
              {drew.length} source{drew.length === 1 ? "" : "s"}
              <ul className="mt-1 flex flex-col gap-1">
                {drew.map((source) => (
                  // The evidence itself stays on the owner's machine; the daemon's label is what this can say, in full, on tap.
                  <li key={`${source.kind}:${source.id}`}>
                    <details>
                      <summary className="cursor-pointer truncate type-identifier text-[var(--faint)]" title={source.label}>
                        {source.label}
                      </summary>
                      <p className="mt-1 break-words type-identifier text-[var(--muted)]" data-testid="why-source-full">
                        {source.label}
                      </p>
                    </details>
                  </li>
                ))}
              </ul>
            </>
          )}
        </Field>
        <Field label="Who's asking" testId="why-asker">
          {draft.provenance?.origin === "channel" ? (
            <ProvenanceLine provenance={draft.provenance} />
          ) : draft.provenance?.origin === "owner" ? (
            "You asked this yourself."
          ) : (
            "Where this came from wasn't recorded."
          )}
        </Field>
        {draft.escalated && draft.escalationReason && (
          <Field label="In its own words" testId="why-reason">
            <span data-testid="escalation-reason">{draft.escalationReason}</span>
          </Field>
        )}
        <Field label="When" testId="why-when">
          <Timestamp iso={draft.createdAt} />
        </Field>
      </dl>
    </div>
  );
}

const KIND_WORDS: Record<RoomSummary["kind"], string> = { direct: "Person", group: "Group", channel: "Channel" };

/** A conversation with nothing waiting in it: who is in it, and what your duo does here. */
export function RoomInfo({ room }: { room: RoomSummary }) {
  const sole = soleDuoLabel(room);
  const title = sole ?? roomTitle(room);
  const duos = sole ? [] : roomDuoLabels(room);
  return (
    <div className="flex flex-col gap-4" data-testid="room-info">
      <h2 className="type-heading">{title}</h2>
      <p className="type-provenance text-[var(--muted)]">{sole ? "A colleague's duo" : KIND_WORDS[room.kind]}</p>
      {sole ? (
        <p className="type-body text-[var(--muted)]">Its answers are always labelled as its owner's duo's, and never as the owner.</p>
      ) : (
        <>
          <p className="type-body text-[var(--muted)]" data-testid="room-info-duo">
            Your duo drafts a reply when someone here asks you something. Nothing is sent without you.
          </p>
          {room.members.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="type-identifier uppercase text-[var(--faint)]">In this conversation</p>
              <ul className="flex flex-col gap-1 type-body text-[var(--muted)]" data-testid="room-info-members">
                {room.members.map((member) => (
                  <li key={member.userId}>{roomDuoLabels({ ...room, members: [member] })[0] ?? member.name ?? member.userId}</li>
                ))}
              </ul>
            </div>
          )}
          {duos.length > 0 && <p className="type-provenance text-[var(--muted)]">{duos.join(", ")} {duos.length === 1 ? "is" : "are"} here.</p>}
        </>
      )}
    </div>
  );
}

const TAB_LABEL: Record<ProfileTab, string> = { portrait: "Portrait", knows: "Knows", may: "May do", rules: "Rules", activity: "Activity" };

/** Your duo's own chat with nothing waiting: a way into its profile. */
export function DuoInfo() {
  return (
    <div className="flex flex-col gap-4" data-testid="duo-info">
      <span aria-hidden="true" className="inline-flex size-10 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)]">
        <Mark />
      </span>
      <h2 className="type-heading">Your duo</h2>
      <p className="type-body text-[var(--muted)]">Only you can see this chat. What it knows about you, and what it may do on its own, is in its profile.</p>
      <ul className="flex flex-col gap-1">
        {PROFILE_TABS.map((tab) => (
          <li key={tab}>
            <a className="inline-flex min-h-11 items-center underline" data-testid={`duo-info-${tab}`} href={tab === "portrait" ? "#duo/profile" : `#duo/profile/${tab}`}>
              {TAB_LABEL[tab]}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}

export type InspectorTarget = { kind: "room"; room: RoomSummary } | { kind: "duo" };

/**
 * What the Info panel is about, from where the owner is (#184): in a
 * conversation, the conversation — who is in it, its duos; in Your duo, a
 * way into its profile. A draft's why is no longer here: it opens beside the
 * draft, when asked (#185). Anywhere else there is nothing to show.
 */
export function useInspectorTarget(api: DuoApiConfig | null, connection: WorkspaceConnection | null, route: Route): InspectorTarget | null {
  const rooms = useHeldRooms(connection);
  if (typeof route === "object" && ("chat" in route || "thread" in route)) {
    const roomId = "chat" in route ? route.chat : route.thread.roomId;
    const room = rooms.find((candidate) => candidate.roomId === roomId);
    return room ? { kind: "room", room } : null;
  }
  if (route === "duo" && api) {
    return { kind: "duo" };
  }
  return null;
}

/** The Info panel's content for a target. */
export function InspectorBody({ target }: { target: InspectorTarget }) {
  return target.kind === "room" ? <RoomInfo room={target.room} /> : <DuoInfo />;
}
