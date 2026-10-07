import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { VoiceRecorderButton } from "../src/composer/VoiceRecorderButton.js";

/**
 * duo#294: a fake `MediaRecorder` — just enough of the real API's shape
 * (`start`/`stop`, `ondataavailable`/`onstop`, `mimeType`) for this
 * component to drive, with `stop()` firing the one chunk and the `onstop`
 * callback the real element fires once the underlying encoder has flushed.
 */
class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: MediaStream) {
    FakeMediaRecorder.instances.push(this);
  }
  start(): void {}
  stop(): void {
    this.ondataavailable?.({ data: new Blob(["chunk"], { type: "audio/webm" }) });
    this.onstop?.();
  }
}

function fakeStream(): MediaStream {
  return { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
}

beforeEach(() => {
  FakeMediaRecorder.instances = [];
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(async () => fakeStream()) },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  cleanup();
});

describe("duo#294 — recording a voice note (web/Mac: click to record)", () => {
  it("click starts recording, click again stops it and hands back the clip", async () => {
    const onRecorded = vi.fn();
    render(<VoiceRecorderButton onRecorded={onRecorded} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("voice-recorder-start"));
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(await screen.findByTestId("voice-recorder-active")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("voice-recorder-stop"));

    expect(onRecorded).toHaveBeenCalledTimes(1);
    const [blob, durationMs, transcript] = onRecorded.mock.calls[0]!;
    expect(blob).toBeInstanceOf(Blob);
    expect(typeof durationMs).toBe("number");
    // No SpeechRecognition stubbed in this environment: a transcript is
    // honestly absent, never a guessed or empty-string stand-in for one.
    expect(transcript).toBeNull();
  });

  it("Cancel discards the recording — onRecorded never runs", async () => {
    const onRecorded = vi.fn();
    render(<VoiceRecorderButton onRecorded={onRecorded} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("voice-recorder-start"));
      await Promise.resolve();
      await Promise.resolve();
    });
    fireEvent.click(await screen.findByTestId("voice-recorder-cancel"));

    expect(onRecorded).not.toHaveBeenCalled();
    expect(screen.queryByTestId("voice-recorder-active")).not.toBeInTheDocument();
  });

  it("a denied microphone shows the reason inline — nothing staged, nothing thrown past the UI", async () => {
    Object.defineProperty(navigator, "mediaDevices", {
      configurable: true,
      value: { getUserMedia: vi.fn(async () => Promise.reject(new Error("Permission denied"))) },
    });
    const onRecorded = vi.fn();
    render(<VoiceRecorderButton onRecorded={onRecorded} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("voice-recorder-start"));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(await screen.findByTestId("voice-recorder-error")).toHaveTextContent(/microphone/i);
    expect(onRecorded).not.toHaveBeenCalled();
  });

  it("a browser with no MediaRecorder at all says so rather than trying anyway", async () => {
    vi.stubGlobal("MediaRecorder", undefined);
    const onRecorded = vi.fn();
    render(<VoiceRecorderButton onRecorded={onRecorded} />);

    await act(async () => {
      fireEvent.click(screen.getByTestId("voice-recorder-start"));
      await Promise.resolve();
    });

    expect(await screen.findByTestId("voice-recorder-error")).toHaveTextContent(/can't record/i);
    expect(onRecorded).not.toHaveBeenCalled();
  });
});
