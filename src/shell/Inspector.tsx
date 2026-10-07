import { useEffect, useRef, useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { DuoApiConfig } from "../api/client.js";
import type { DraftRecord } from "../api/types.js";
import { hairlineState, type HairlineState } from "../components/ConfidenceHairline.js";
import { toDraftPipelineResult } from "../components/DraftCard.js";
import { Mark } from "../components/Mark.js";
import { OffTheRecordControl } from "../components/OffTheRecordControl.js";
import { PinnedMessagesList } from "../components/PinnedMessages.js";
import { ProvenanceLine } from "../components/ProvenanceLine.js";
import { SourceRemoveButton } from "../components/SourceRemoveButton.js";
import { Timestamp } from "../components/Timestamp.js";
import { duoUserIdFor, localpartOf } from "../workspace/identity.js";
import type { RoomMemberRef, RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";
import { roomHref } from "../workspace/links.js";
import { avatarRefusalOf, stageFile } from "../workspace/sharing.js";
import { groupRoomMembers, roomTitle, soleDuoLabel } from "./roomTitle.js";
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
 *
 * duo#272: `api`, when given, puts an inline Remove beside each rule and
 * evidence row (`SourceRemoveButton` — attachments get none, they name no
 * persisted thing to act on). Optional and defaulted to nothing so every
 * existing read-only mount of this panel keeps rendering exactly as it did.
 */
export function WhyPanel({ draft, api }: { draft: DraftRecord; api?: DuoApiConfig }) {
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
                <li className="flex items-center justify-between gap-2" key={rule.id}>
                  <a className="underline" data-testid="why-rule" href="#duo/profile/rules">
                    {rule.label}
                  </a>
                  {api && <SourceRemoveButton api={api} source={rule} />}
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
                  <li className="flex items-center justify-between gap-2" key={`${source.kind}:${source.id}`}>
                    <details className="min-w-0 flex-1">
                      <summary className="cursor-pointer truncate type-identifier text-[var(--faint)]" title={source.label}>
                        {source.label}
                      </summary>
                      <p className="mt-1 break-words type-identifier text-[var(--muted)]" data-testid="why-source-full">
                        {source.label}
                      </p>
                    </details>
                    {api && <SourceRemoveButton api={api} source={source} />}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Field>
        {/* digital-duo #279 (issue #262): only when the daemon actually
            tuned this draft's wording for its one recipient — never shown
            from `recipientAdaptation` alone, in case a future draft ever
            carries one without the flag. */}
        {draft.adaptedForRecipient && draft.recipientAdaptation && (
          <Field label="Tuned for" testId="why-recipient-adaptation">
            Tuned for how you write to {draft.recipientAdaptation.recipientName ?? "this person"}.
          </Field>
        )}
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

/**
 * One editable fact of a group conversation (#223): its name or its topic.
 * Read-only when this member's power level doesn't clear the room's own
 * gate for that field (`RoomSummary.canEdit`, read client-side so this never
 * has to guess from a failed call) — the value still shows, per AC3, just
 * with no way to change it. Editing is its own small form so saving the
 * name never touches the topic and a refusal from one never blocks the
 * other.
 */
function EditableField({
  label,
  testId,
  value,
  placeholder,
  canEdit,
  onSave,
}: {
  label: string;
  testId: string;
  value: string | null;
  placeholder: string;
  canEdit: boolean;
  onSave: (next: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The homeserver's own value always wins once editing isn't in the way —
  // another device's change (or this one landing) replaces the draft.
  useEffect(() => {
    if (!editing) {
      setDraft(value ?? "");
    }
  }, [value, editing]);

  if (!canEdit) {
    return (
      <Field label={label} testId={testId}>
        {value ?? placeholder}
      </Field>
    );
  }

  if (!editing) {
    return (
      <div className="flex flex-col gap-1" data-testid={testId}>
        <dt className="type-identifier uppercase text-[var(--faint)]">{label}</dt>
        <dd className="flex items-center justify-between gap-2 type-body text-[var(--muted)]">
          <span className="min-w-0 truncate" data-testid={`${testId}-value`}>
            {value ?? placeholder}
          </span>
          <button
            className="inline-flex min-h-9 shrink-0 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance"
            data-testid={`${testId}-edit`}
            onClick={() => setEditing(true)}
            type="button"
          >
            Edit
          </button>
        </dd>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <dt className="type-identifier uppercase text-[var(--faint)]">
        <label htmlFor={`${testId}-input`}>{label}</label>
      </dt>
      <dd className="flex flex-col gap-2">
        <form
          className="flex items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            setBusy(true);
            setError(null);
            onSave(draft.trim())
              .then(() => setEditing(false))
              .catch(() => setError("The workspace didn't take that — try again."))
              .finally(() => setBusy(false));
          }}
        >
          <input
            className="min-w-0 flex-1 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-2 py-1 type-body"
            data-testid={`${testId}-input`}
            id={`${testId}-input`}
            onChange={(event) => setDraft(event.target.value)}
            value={draft}
          />
          <button
            className="inline-flex min-h-9 shrink-0 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance disabled:opacity-60"
            data-testid={`${testId}-save`}
            disabled={busy}
            type="submit"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          <button
            className="inline-flex min-h-9 shrink-0 items-center rounded-[var(--r-sm)] px-2 type-provenance text-[var(--muted)]"
            data-testid={`${testId}-cancel`}
            onClick={() => {
              setEditing(false);
              setError(null);
            }}
            type="button"
          >
            Cancel
          </button>
        </form>
        {error && (
          <p className="type-body text-[var(--refused)]" data-testid={`${testId}-error`}>
            {error}
          </p>
        )}
      </dd>
    </div>
  );
}

/**
 * A group conversation's picture (#223): the current image, fetched through
 * the member's own authenticated media door (#66's `loadMedia` — the same
 * one a shared image renders through, since an `<img src="mxc://…">` could
 * never load), or an honest placeholder when it has none. A read-only
 * member sees this and nothing else; a member with `canEdit.avatar` also
 * sees a picker, gated by the identical size and type rules a shared image
 * runs against (`avatarRefusalOf`) before the bytes ever reach `uploadFile`.
 */
function PictureField({
  avatarUrl,
  canEdit,
  connection,
  onSave,
}: {
  avatarUrl: string | null;
  canEdit: boolean;
  connection: WorkspaceConnection;
  onSave: (mxcUrl: string) => Promise<void>;
}) {
  const [thumbnail, setThumbnail] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (avatarUrl === null) {
      setThumbnail(null);
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void connection.loadMedia(avatarUrl).then((blob) => {
      if (cancelled || blob === null) {
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setThumbnail(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [avatarUrl, connection]);

  const pick = async (file: File): Promise<void> => {
    const staged = await stageFile(file);
    const refusal = avatarRefusalOf(staged);
    if (refusal !== null) {
      setError(refusal);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const uploaded = await connection.uploadFile(staged);
      await onSave(uploaded.url);
    } catch {
      setError("The workspace didn't take that picture — try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="room-settings-picture">
      <p className="type-identifier uppercase text-[var(--faint)]">Picture</p>
      <div className="flex items-center gap-3">
        {thumbnail !== null ? (
          <img
            alt=""
            className="size-14 rounded-[var(--r-md)] border border-[var(--edge)] object-cover"
            data-testid="room-picture-image"
            src={thumbnail}
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex size-14 items-center justify-center rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface-2)] type-identifier text-[var(--faint)]"
            data-testid="room-picture-placeholder"
          >
            None
          </div>
        )}
        {canEdit && (
          <>
            <input
              accept="image/*"
              className="hidden"
              data-testid="room-picture-input"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = "";
                if (file) {
                  void pick(file);
                }
              }}
              ref={inputRef}
              type="file"
            />
            <button
              className="inline-flex min-h-9 items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-provenance disabled:opacity-60"
              data-testid="room-picture-pick"
              disabled={busy}
              onClick={() => inputRef.current?.click()}
              type="button"
            >
              {busy ? "Uploading…" : "Change picture"}
            </button>
          </>
        )}
      </div>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="room-picture-error">
          {error}
        </p>
      )}
    </div>
  );
}

/**
 * #223: a group conversation's name, topic and picture — editable inline by
 * whoever's power level the room grants it, read-only for everyone else
 * (AC3). A direct conversation never renders this (RoomInfo gates it out):
 * a DM has no name of its own to give, and Matrix's own convention leaves
 * these three state events to rooms, not 1:1s. Saving any one field is its
 * own call; the homeserver's next answer — synced back through #63's
 * projection — is what every device (this one's sidebar and header
 * included, once their own `rooms` read is invalidated) reads afterwards.
 * Nothing here renders a local guess of the new value.
 */
function GroupSettings({ room, connection }: { room: RoomSummary; connection: WorkspaceConnection }) {
  const queryClient = useQueryClient();
  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["workspace", "rooms"] });
  };
  return (
    <dl className="flex flex-col gap-4 border-t border-[var(--edge)] pt-4" data-testid="room-settings">
      <EditableField
        canEdit={room.canEdit.name}
        label="Name"
        onSave={async (next) => {
          await connection.setRoomName(room.roomId, next);
          refresh();
        }}
        placeholder="No name"
        testId="room-settings-name"
        value={room.name}
      />
      <EditableField
        canEdit={room.canEdit.topic}
        label="Topic"
        onSave={async (next) => {
          await connection.setRoomTopic(room.roomId, next);
          refresh();
        }}
        placeholder="No topic"
        testId="room-settings-topic"
        value={room.topic}
      />
      <PictureField
        avatarUrl={room.avatarUrl}
        canEdit={room.canEdit.avatar}
        connection={connection}
        onSave={async (mxcUrl) => {
          await connection.setRoomAvatar(room.roomId, mxcUrl);
          refresh();
        }}
      />
    </dl>
  );
}

/**
 * A person's own row (#247): one row per PERSON, never a duo listed beside
 * them as if it were a second member. When their duo also rides in the
 * room, a quiet badge says so and "Ask their duo" opens straight into it —
 * one click, no detour through a second row that could be mistaken for a
 * colleague.
 */
function MemberRow({ member, duoHere, connection }: { member: RoomMemberRef; duoHere: boolean; connection: WorkspaceConnection | null }) {
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const name = member.name ?? localpartOf(member.userId);
  const theirDuoId = duoHere ? duoUserIdFor(member.userId) : null;

  const askTheirDuo = (): void => {
    if (!connection || !theirDuoId || starting) {
      return;
    }
    setStarting(true);
    setError(null);
    connection
      .startDirect(theirDuoId)
      .then((roomId) => {
        window.location.hash = roomHref(roomId);
      })
      .catch(() => setError("The workspace didn't take that — try again."))
      .finally(() => setStarting(false));
  };

  return (
    <li className="flex flex-col gap-1">
      <div className="flex items-center justify-between gap-2">
        <span>{name}</span>
        {theirDuoId && (
          <span className="flex items-center gap-2" data-testid="room-info-member-duo-badge">
            <span
              aria-label={`${name}'s duo is also here`}
              className="inline-flex items-center gap-1 rounded-full border border-[var(--edge)] px-2 type-provenance text-[var(--faint)]"
            >
              <Mark /> duo here
            </span>
            {connection && (
              <button
                className="underline type-provenance text-[var(--muted)] disabled:opacity-40"
                data-testid="room-info-ask-their-duo"
                disabled={starting}
                onClick={askTheirDuo}
                type="button"
              >
                {starting ? "Opening…" : "Ask their duo"}
              </button>
            )}
          </span>
        )}
      </div>
      {error && (
        <p className="type-body text-[var(--refused)]" data-testid="room-info-ask-their-duo-error">
          {error}
        </p>
      )}
    </li>
  );
}

/** A conversation with nothing waiting in it: who is in it, what your duo does here, and (a group's) its own name, topic and picture (#223). */
export function RoomInfo({ room, connection = null, api = null }: { room: RoomSummary; connection?: WorkspaceConnection | null; api?: DuoApiConfig | null }) {
  const queryClient = useQueryClient();
  const sole = soleDuoLabel(room);
  const title = sole ?? roomTitle(room);
  // #247: one row per person, a duo attached to its owner's row when the
  // owner is here, and grouped separately — quietly, never equal footing —
  // when it isn't (the owner DMed a duo directly, or left since).
  const { people, duos } = sole ? { people: [], duos: [] } : groupRoomMembers(room, connection?.userId ?? null);
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
          {room.pinnedEventIds && room.pinnedEventIds.length > 0 && (
            <div className="flex flex-col gap-2" data-testid="room-info-pinned">
              <p className="type-identifier uppercase text-[var(--faint)]">Pinned messages</p>
              <PinnedMessagesList
                canUnpin={room.canEdit.pins}
                onJump={(eventId) => {
                  window.location.hash = roomHref(room.roomId, eventId);
                }}
                onUnpin={(eventId) => {
                  if (connection) {
                    void connection.unpin(room.roomId, eventId).then(() => {
                      void queryClient.invalidateQueries({ queryKey: ["workspace", "rooms"] });
                    });
                  }
                }}
                pinnedEventIds={room.pinnedEventIds}
              />
            </div>
          )}
          {people.length > 0 && (
            <div className="flex flex-col gap-1">
              <p className="type-identifier uppercase text-[var(--faint)]">In this conversation</p>
              <ul className="flex flex-col gap-2 type-body text-[var(--muted)]" data-testid="room-info-members">
                {people.map(({ member, duoHere }) => (
                  <MemberRow connection={connection} duoHere={duoHere} key={member.userId} member={member} />
                ))}
              </ul>
            </div>
          )}
          {duos.length > 0 && (
            <div className="flex flex-col gap-1 opacity-80" data-testid="room-info-duos-group">
              <p className="type-identifier uppercase text-[var(--faint)]">Duos</p>
              <ul className="flex flex-col gap-1 type-body text-[var(--faint)]" data-testid="room-info-duos">
                {duos.map(({ member, label }) => (
                  <li key={member.userId}>{label}</li>
                ))}
              </ul>
            </div>
          )}
          {room.kind !== "direct" && connection && <GroupSettings connection={connection} room={room} />}
          {api && (
            <div className="flex flex-col gap-2 border-t border-[var(--edge)] pt-4" data-testid="room-settings-off-the-record">
              <p className="type-identifier uppercase text-[var(--faint)]">Learning</p>
              <OffTheRecordControl api={api} roomId={room.roomId} />
            </div>
          )}
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
export function InspectorBody({
  target,
  connection = null,
  api = null,
}: {
  target: InspectorTarget;
  connection?: WorkspaceConnection | null;
  /** duo#274: the room settings section's "don't learn from this" toggle needs the daemon; `null` with no paired duo renders the rest of Info exactly as before. */
  api?: DuoApiConfig | null;
}) {
  return target.kind === "room" ? <RoomInfo api={api} connection={connection} room={target.room} /> : <DuoInfo />;
}
