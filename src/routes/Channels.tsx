import type { DuoApiConfig } from "../api/client.js";
import { useChannels, useSetChannelMute } from "../api/queries.js";
import type { ChannelSummary } from "../api/types.js";
import { RouteError } from "../components/RouteError.js";
import { RouteLoading } from "../components/RouteLoading.js";

/**
 * A failed connection first — this is the screen the owner opens to find
 * out why it is quiet, so the answer must not sit below a healthy list.
 * `"failed"` is the daemon's general connection-health word, not any one
 * channel's; the sort is otherwise stable, so the daemon's own order holds.
 */
function failedFirst(channels: readonly ChannelSummary[]): ChannelSummary[] {
  return [...channels].sort((a, b) => Number(b.state === "failed") - Number(a.state === "failed"));
}

/**
 * The empty state is a configuration, not a gap (#47, narrowed by #57): a
 * duo with nothing bridged in is complete — it answers its owner, in the
 * app, and that is the whole product before any outside system joins. So
 * this reads as a statement of fact: no warning tone, no alert role, and
 * above all no call to action, because connecting a channel happens where
 * its credentials are, not here.
 */
function NoChannels() {
  return (
    <div
      className="rounded-[var(--r-md)] border border-dashed border-[var(--edge)] p-4 type-body text-[var(--muted)]"
      data-testid="channels-none"
    >
      Nothing is bridged in, so your duo answers only you right now. That is a normal, complete way to run a duo.
    </div>
  );
}

function ChannelRow({
  channel,
  pending,
  error,
  onSetMuted,
}: {
  channel: ChannelSummary;
  pending: boolean;
  error: Error | null;
  onSetMuted: (muted: boolean) => void;
}) {
  const failed = channel.state === "failed";
  return (
    <li className="shape-entry flex flex-col gap-2 p-4" data-testid="channel">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-baseline gap-2">
          {/* The adapter's own label, verbatim — the kind beside it is an
              identifier chip, an opaque string this client neither maps nor
              styles. No icon, no colour, nothing derived from either. */}
          <h2 className="type-heading" data-testid="channel-label">
            {channel.label}
          </h2>
          <span className="type-identifier text-[var(--faint)]" data-testid="channel-kind">
            {channel.kind}
          </span>
        </div>
        {/* The state as the daemon spelled it; failure adds words below,
            not only a colour. */}
        <span
          className={`rounded-[var(--r-sm)] border border-[var(--edge)] px-2 type-identifier ${failed ? "text-[var(--refused)]" : "text-[var(--muted)]"}`}
          data-testid="channel-state"
        >
          {channel.state}
        </span>
      </div>

      {failed && (
        <div className="flex flex-col gap-1" data-testid="channel-failure" role="alert">
          <p className="type-body text-[var(--refused)]">Connection failed</p>
          {/* The adapter's reason, never re-worded — it is the one thing
              that tells the owner what to go fix. */}
          {channel.reason !== undefined && <p className="type-provenance text-[var(--muted)]">{channel.reason}</p>}
        </div>
      )}

      <p className="type-provenance text-[var(--muted)]" data-testid="channel-last-activity">
        {channel.lastActivityAt ? `Last activity ${new Date(channel.lastActivityAt).toLocaleString()}` : "No activity yet"}
      </p>

      <div className="flex flex-wrap items-center gap-3">
        {/* The mute is the daemon's (#172): this row shows what GET
            /channels says and asks the policy route to change it — the
            state is never a flag this screen keeps. */}
        {channel.muted && (
          <span className="type-provenance text-[var(--muted)]" data-testid="channel-muted">
            Muted — no drafts from this channel.
          </span>
        )}
        <button
          aria-label={`${channel.muted ? "Unmute" : "Mute"} ${channel.label}`}
          className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--text)] disabled:opacity-40"
          disabled={pending}
          onClick={() => onSetMuted(!channel.muted)}
        >
          {channel.muted ? "Unmute" : "Mute"}
        </button>
      </div>

      {error && (
        <p className="type-provenance text-[var(--refused)]" data-testid="channel-mute-error" role="alert">
          {error.message}
        </p>
      )}
    </li>
  );
}

/** The bridged channels and their mute controls — the body of the Channels page, without its heading, so the duo's profile can host it. */
export function ChannelList({ api, channels }: { api: DuoApiConfig; channels: readonly ChannelSummary[] }) {
  const setMute = useSetChannelMute(api);
  return (
    <>
      {channels.length === 0 ? (
        <NoChannels />
      ) : (
        <ul className="flex flex-col gap-3">
          {failedFirst(channels).map((channel) => (
            <ChannelRow
              key={channel.kind}
              channel={channel}
              pending={setMute.isPending && setMute.variables?.channel === channel.kind}
              error={setMute.isError && setMute.variables?.channel === channel.kind ? setMute.error : null}
              onSetMuted={(muted) => setMute.mutate({ channel: channel.kind, muted })}
            />
          ))}
        </ul>
      )}
    </>
  );
}

function ChannelsScreen({ api, channels }: { api: DuoApiConfig; channels: readonly ChannelSummary[] }) {
  return (
    <div className="flex flex-col gap-6 p-6" data-testid="channels">
      <header className="flex flex-col gap-1">
        <h1 className="type-heading">Channels</h1>
        <p className="type-provenance text-[var(--muted)]">
          The outside systems bridged into your duo, and whether each is working.
        </p>
      </header>
      <ChannelList api={api} channels={channels} />
    </div>
  );
}

/**
 * The cache is a storage layer, not a promise (Knowledge's own note): a
 * payload that is not the daemon's list is not an answer, and the screen
 * reads it as still asking rather than crashing on it.
 */
export function isChannelList(value: unknown): value is ChannelSummary[] {
  return Array.isArray(value);
}

/**
 * The channels screen (#47) — what this duo is reachable through and
 * whether each is working, rendered from `GET /channels` and nothing this
 * client knows. It recognises no channel (#43): the kind and the label are
 * the core's strings, shown as sent, so a channel the client has never
 * seen — or one added to the core tomorrow — renders like any other.
 * Read and mute only: connecting or authorising a channel happens where
 * its credentials are.
 */
export function Channels({ api }: { api: DuoApiConfig }) {
  const channels = useChannels(api);
  if (channels.isLoading) {
    return <RouteLoading variant="rows" />;
  }
  if (channels.error) {
    return <RouteError api={api} error={channels.error} onRetry={() => void channels.refetch()} />;
  }
  if (isChannelList(channels.data)) {
    return <ChannelsScreen api={api} channels={channels.data} />;
  }
  return <RouteLoading variant="rows" />;
}
