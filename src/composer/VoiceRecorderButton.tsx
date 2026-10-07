import { useRef, useState } from "react";
import { Mic, Square, X } from "lucide-react";
import { VOICE_NOTE_LIMIT_MS } from "../workspace/sharing.js";

/**
 * #294: the Web Speech API's live transcript — `SpeechRecognition` (Chrome;
 * `webkitSpeechRecognition` everywhere it still ships that way), the
 * client-side path #294's own issue calls out as the safer, buildable one
 * tonight: no daemon involvement, no new inference-provider work (checked —
 * digital-duo has no speech-to-text capability anywhere today, and building
 * one is its own large, risky story this isn't). A browser without either
 * constructor simply never gets a transcript — recording still works, the
 * note still sends, there is just nothing under it (#294 AC3 is "a
 * transcript shows under the note", not "every browser produces one").
 */
interface SpeechRecognitionLike extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  start(): void;
  stop(): void;
  onresult: ((event: { results: ArrayLike<ArrayLike<{ transcript: string }>> }) => void) | null;
  onerror: (() => void) | null;
}
type SpeechRecognitionCtor = new () => SpeechRecognitionLike;

function speechRecognitionCtor(): SpeechRecognitionCtor | null {
  const w = window as unknown as { SpeechRecognition?: SpeechRecognitionCtor; webkitSpeechRecognition?: SpeechRecognitionCtor };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

/** "0:07" while recording — the same honest mm:ss `VoiceNoteCard` shows for playback, read live off `Date.now() - startedAt`. */
function formatElapsed(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}`;
}

/**
 * #294: records a voice note — hold-to-record's gesture is phone work
 * (`duo#294`'s own "Phone first" split names it so); this is the issue's
 * other half, "Web/Mac: click to record" — click starts, click stops (there
 * is no hold to lock out of, so "lock" has nothing to do on this platform),
 * and Cancel discards without staging anything. Recording auto-stops at
 * `VOICE_NOTE_LIMIT_MS` the same way a held gesture would hit its own cap.
 * The finished clip reaches the caller as a blob plus what this component
 * already knows about it (duration, transcript) — staging it is the
 * composer's own job (`stageRecordedAudio`), the same `stage()` door #66
 * built for a picked file, so a voice note rides the identical preview,
 * refusal and send path every other attachment already does.
 */
export function VoiceRecorderButton({
  disabled = false,
  onRecorded,
}: {
  disabled?: boolean;
  onRecorded: (blob: Blob, durationMs: number, transcript: string | null) => void;
}) {
  const [recording, setRecording] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startedAtRef = useRef(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const limitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const recognitionRef = useRef<SpeechRecognitionLike | null>(null);
  const transcriptRef = useRef("");
  const cancelledRef = useRef(false);

  const cleanup = (): void => {
    if (tickRef.current !== null) {
      clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (limitTimerRef.current !== null) {
      clearTimeout(limitTimerRef.current);
      limitTimerRef.current = null;
    }
    recognitionRef.current?.stop();
    recognitionRef.current = null;
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
  };

  const start = async (): Promise<void> => {
    setError(null);
    if (typeof MediaRecorder === "undefined" || !navigator.mediaDevices?.getUserMedia) {
      setError("This browser can't record audio.");
      return;
    }
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      setError("The microphone wasn't allowed — check this browser's permission for it.");
      return;
    }
    streamRef.current = stream;
    cancelledRef.current = false;
    chunksRef.current = [];
    transcriptRef.current = "";
    const recorder = new MediaRecorder(stream);
    recorder.ondataavailable = (e) => {
      if (e.data.size > 0) {
        chunksRef.current.push(e.data);
      }
    };
    recorder.onstop = () => {
      cleanup();
      setRecording(false);
      if (cancelledRef.current) {
        return;
      }
      const blob = new Blob(chunksRef.current, { type: recorder.mimeType || "audio/webm" });
      const durationMs = Date.now() - startedAtRef.current;
      const transcript = transcriptRef.current.trim();
      onRecorded(blob, durationMs, transcript.length > 0 ? transcript : null);
    };
    recorderRef.current = recorder;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    recorder.start();
    setRecording(true);
    tickRef.current = setInterval(() => setElapsedMs(Date.now() - startedAtRef.current), 200);
    limitTimerRef.current = setTimeout(() => recorderRef.current?.stop(), VOICE_NOTE_LIMIT_MS);

    const Recognition = speechRecognitionCtor();
    if (Recognition !== null) {
      const recognition = new Recognition();
      recognition.continuous = true;
      recognition.interimResults = false;
      recognition.onresult = (event) => {
        let combined = "";
        for (let i = 0; i < event.results.length; i += 1) {
          combined += `${event.results[i]?.[0]?.transcript ?? ""} `;
        }
        transcriptRef.current = combined.trim();
      };
      recognition.onerror = () => undefined; // best-effort: a recognition failure never breaks recording itself
      recognitionRef.current = recognition;
      try {
        recognition.start();
      } catch {
        recognitionRef.current = null;
      }
    }
  };

  const stop = (): void => {
    recorderRef.current?.stop();
  };

  const cancel = (): void => {
    cancelledRef.current = true;
    recorderRef.current?.stop();
  };

  if (recording) {
    return (
      <div className="flex items-center gap-1 rounded-[var(--r-sm)] border border-[var(--edge)] px-2" data-testid="voice-recorder-active">
        <span aria-hidden="true" className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--refused)]" />
        <span className="type-provenance tabular-nums text-[var(--muted)]" data-testid="voice-recorder-elapsed">
          {formatElapsed(elapsedMs)}
        </span>
        <button
          aria-label="Stop recording and attach"
          className="inline-flex min-h-9 min-w-9 items-center justify-center text-[var(--text)]"
          data-testid="voice-recorder-stop"
          onClick={stop}
          type="button"
        >
          <Square aria-label="Stop recording and attach" className="size-4" />
        </button>
        <button
          aria-label="Cancel recording"
          className="inline-flex min-h-9 min-w-9 items-center justify-center text-[var(--muted)]"
          data-testid="voice-recorder-cancel"
          onClick={cancel}
          type="button"
        >
          <X aria-label="Cancel recording" className="size-4" />
        </button>
      </div>
    );
  }

  return (
    <>
      <button
        aria-label="Record a voice note"
        className="inline-flex min-h-11 items-center justify-center rounded-[var(--r-sm)] border border-[var(--edge)] px-3 text-[var(--muted)] disabled:opacity-40"
        data-testid="voice-recorder-start"
        disabled={disabled}
        onClick={() => void start()}
        type="button"
      >
        <Mic aria-label="Record a voice note" className="size-4" />
      </button>
      {error !== null && (
        <p className="type-provenance text-[var(--refused)]" data-testid="voice-recorder-error">
          {error}
        </p>
      )}
    </>
  );
}
