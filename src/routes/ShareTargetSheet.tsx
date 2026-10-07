import { useEffect, useState } from "react";
import type { DuoApiConfig } from "../api/client.js";
import { Mark } from "../components/Mark.js";
import { RouteLoading } from "../components/RouteLoading.js";
import { writeComposerBuffer } from "../composerBuffer.js";
import { roomTitle, soleDuoLabel } from "../shell/roomTitle.js";
import { readPendingShare, stashShareForRoom, type PendingShare } from "../shareTarget.js";
import { roomHref } from "../workspace/links.js";
import type { RoomSummary, WorkspaceConnection } from "../workspace/matrix.js";

/** The text a conversation or Your duo actually receives: the shared text and link together, exactly as the share named them — never re-worded. */
function sharedTextOf(share: PendingShare): string {
  return [share.text, share.url].filter((part) => part.trim() !== "").join("\n");
}

/** Rebuilds the real `File`s `stage()` (the composer's own door, `src/routes/Room.tsx`) takes — the worker kept the bytes as a bare `Blob`, so the name and type it captured alongside ride back on here. */
function filesOf(share: PendingShare): readonly File[] {
  return share.files.map((file) => new File([file.blob], file.name, { type: file.type }));
}

/**
 * #324: the picker a share lands on — `public/manifest.json`'s own
 * `share_target.action`, caught by `public/sw.js` and handed here
 * (`src/shareTarget.ts`). AC2: the shared content "lands in a picker to
 * choose a conversation or Your duo"; AC3: a file goes through the normal
 * upload path, which means this hands the raw files to the room it picked
 * (`stashShareForRoom`) rather than uploading anything itself — the upload
 * is `RoomComposer`'s own door (#66), the same one Attach already uses, and
 * this never duplicates it. A pick into Your duo carries text only
 * (`composerBuffer.ts`'s door, read fresh by `Composer.tsx` on its next
 * mount): the duo's own composer has no file door for this to ride.
 */
export function ShareTargetSheet({ api, connection }: { api: DuoApiConfig | null; connection: WorkspaceConnection | null }) {
  const [share, setShare] = useState<PendingShare | null | "loading">("loading");
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<readonly RoomSummary[]>([]);

  useEffect(() => {
    let cancelled = false;
    void readPendingShare().then((found) => {
      if (!cancelled) {
        setShare(found);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!connection) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    connection
      .findRooms(query.trim())
      .then((found) => {
        if (!cancelled) {
          setMatches(found);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setMatches([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [connection, query]);

  if (share === "loading") {
    return (
      <div className="p-6">
        <h1 className="type-heading">Share into Duo</h1>
        <RouteLoading slowNote={null} variant="rows" />
      </div>
    );
  }

  if (share === null) {
    return (
      <div className="flex flex-col gap-3 p-6">
        <h1 className="type-heading">Share into Duo</h1>
        <p className="type-body text-[var(--muted)]" data-testid="share-target-empty">
          Nothing to share — share it into Duo again from wherever it came from.
        </p>
        <a className="inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" data-testid="share-target-cancel" href="#chats">
          Back to Chats
        </a>
      </div>
    );
  }

  const text = sharedTextOf(share);
  const hasFiles = share.files.length > 0;

  const pickDuo = (): void => {
    writeComposerBuffer(text);
    window.location.hash = "#duo";
  };

  const pickRoom = (roomId: string): void => {
    stashShareForRoom(roomId, { text, files: filesOf(share) });
    window.location.hash = roomHref(roomId);
  };

  return (
    <div className="flex h-full flex-col gap-3 p-6" data-testid="share-target-sheet">
      <h1 className="type-heading">Share into Duo</h1>
      <div className="rounded-[var(--r-md)] border border-[var(--edge)] bg-[var(--surface)] p-3" data-testid="share-target-preview">
        {share.title !== "" && <p className="type-body text-[var(--text)]">{share.title}</p>}
        {text !== "" && <p className="line-clamp-3 type-provenance text-[var(--muted)]">{text}</p>}
        {hasFiles && (
          <p className="type-provenance text-[var(--muted)]" data-testid="share-target-file-count">
            {share.files.length} {share.files.length === 1 ? "file" : "files"}
          </p>
        )}
      </div>
      <p className="type-provenance text-[var(--muted)]">Choose where this goes.</p>
      {api && !hasFiles && (
        <button
          className="press flex min-h-11 items-center gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-left type-body text-[var(--text)]"
          data-testid="share-target-duo"
          onClick={pickDuo}
          type="button"
        >
          <Mark />
          Your duo
        </button>
      )}
      {connection ? (
        <>
          <input
            aria-label="Search conversations"
            className="min-h-11 w-full rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface)] px-3 type-body"
            data-testid="share-target-search"
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search conversations"
            type="text"
            value={query}
          />
          {matches.length === 0 ? (
            <p className="type-body text-[var(--muted)]" data-testid="share-target-none">
              No conversations found.
            </p>
          ) : (
            <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto">
              {matches.map((room) => (
                <li key={room.roomId}>
                  <button
                    className="press flex min-h-11 w-full items-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-left type-body text-[var(--text)]"
                    data-testid="share-target-room"
                    onClick={() => pickRoom(room.roomId)}
                    type="button"
                  >
                    {soleDuoLabel(room) ?? roomTitle(room)}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </>
      ) : (
        !api && (
          <p className="type-body text-[var(--muted)]" data-testid="share-target-no-destination">
            Sign in to a workspace, or pair your duo, to share into it.
          </p>
        )
      )}
      <a className="inline-flex min-h-11 items-center self-start rounded-[var(--r-sm)] border border-[var(--edge)] px-3 type-body" data-testid="share-target-cancel" href="#chats">
        Cancel
      </a>
    </div>
  );
}
