import { useEffect, useRef, useState } from "react";
import { Mic, Pause, Play } from "lucide-react";
import type { SharedFile } from "../workspace/matrix.js";

const SPEEDS = [1, 1.5, 2] as const;

/** `0:07`, `1:03` — never bare seconds, which read as a count rather than a position. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * #294: a voice note — this client's one kind of `m.audio` share, so unlike
 * `SharedFileCard` it never needs to ask whether the file IS one (the
 * message's own `file.audio` already said so, at the render site below).
 * Playback is the member's own authenticated fetch (`loadMedia`, the same
 * door every share already loads its bytes through — a bare `<audio src>`
 * against the raw `mxc://` reference can carry no token), speed cycles
 * 1× → 1.5× → 2× → 1× on one button (never a menu for three choices), and
 * scrubbing is an ordinary range input against the element's own
 * `currentTime` — nothing here keeps a second copy of where playback is.
 * The transcript, when the browser produced one, renders beneath as plain
 * words: it is the one existing text a duo, search, or a notification
 * already knows how to read (`matrix.ts`'s own doc comment on
 * `SharedFile.transcript`), never a second, private copy only this card
 * shows.
 */
export function VoiceNoteCard({ file, loadMedia }: { file: SharedFile; loadMedia: (url: string) => Promise<Blob | null> }) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentMs, setCurrentMs] = useState(0);
  const [durationMs, setDurationMs] = useState(file.durationMs ?? 0);
  const [speedIndex, setSpeedIndex] = useState(0);

  useEffect(() => {
    if (file.url.length === 0) {
      return;
    }
    let cancelled = false;
    let objectUrl: string | null = null;
    void loadMedia(file.url).then((blob) => {
      if (cancelled) {
        return;
      }
      if (blob === null) {
        setFailed(true);
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      setSrc(objectUrl);
    });
    return () => {
      cancelled = true;
      if (objectUrl !== null) {
        URL.revokeObjectURL(objectUrl);
      }
    };
  }, [file.url, loadMedia]);

  const togglePlay = (): void => {
    const audio = audioRef.current;
    if (audio === null) {
      return;
    }
    if (audio.paused) {
      void audio.play();
    } else {
      audio.pause();
    }
  };

  const cycleSpeed = (): void => {
    const next = (speedIndex + 1) % SPEEDS.length;
    setSpeedIndex(next);
    if (audioRef.current !== null) {
      audioRef.current.playbackRate = SPEEDS[next]!;
    }
  };

  return (
    <div className="flex flex-col gap-2" data-testid="room-voice-note">
      <div className="flex items-center gap-2 rounded-[var(--r-sm)] border border-[var(--edge)] bg-[var(--surface-2)] px-3 py-2">
        <Mic aria-label="Voice note" className="size-4 shrink-0 text-[var(--muted)]" />
        <button
          aria-label={playing ? "Pause voice note" : "Play voice note"}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-[var(--accent)] text-[var(--bg)] disabled:opacity-40"
          data-testid="voice-note-play"
          disabled={src === null}
          onClick={togglePlay}
          type="button"
        >
          {playing ? <Pause aria-label="Pause voice note" className="size-4" /> : <Play aria-label="Play voice note" className="size-4" />}
        </button>
        <input
          aria-label="Scrub voice note"
          className="h-1 flex-1 accent-[var(--accent)]"
          data-testid="voice-note-scrub"
          disabled={src === null || durationMs === 0}
          max={durationMs}
          min={0}
          onChange={(e) => {
            const value = Number(e.target.value);
            setCurrentMs(value);
            if (audioRef.current !== null) {
              audioRef.current.currentTime = value / 1000;
            }
          }}
          type="range"
          value={currentMs}
        />
        <span className="type-provenance tabular-nums text-[var(--muted)]" data-testid="voice-note-time">
          {formatDuration(currentMs)} / {formatDuration(durationMs)}
        </span>
        <button
          aria-label="Change playback speed"
          className="inline-flex min-h-6 min-w-10 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] type-provenance text-[var(--muted)]"
          data-testid="voice-note-speed"
          disabled={src === null}
          onClick={cycleSpeed}
          type="button"
        >
          {SPEEDS[speedIndex]}×
        </button>
        {src !== null && (
          <audio
            ref={audioRef}
            onEnded={() => setPlaying(false)}
            onLoadedMetadata={(e) => {
              const seconds = e.currentTarget.duration;
              if (Number.isFinite(seconds)) {
                setDurationMs(seconds * 1000);
              }
            }}
            onPause={() => setPlaying(false)}
            onPlay={() => setPlaying(true)}
            onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
            preload="metadata"
            src={src}
          />
        )}
      </div>
      {failed && (
        <p className="type-provenance text-[var(--refused)]" data-testid="voice-note-error">
          Couldn&apos;t load this voice note — the workspace didn&apos;t serve it. Try again.
        </p>
      )}
      {/* #294 AC3: "a transcript shows under the note" — plain words, no
          quote-mark chrome, because this isn't a quotation of someone
          else's text, it's the same words as the audio, written. */}
      {file.transcript !== undefined && (
        <p className="type-body text-[var(--text)]" data-testid="voice-note-transcript">
          {file.transcript}
        </p>
      )}
    </div>
  );
}
