import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { createBrowserPcmCapture } from "./browserPcmCapture";
import { requestMicrophone } from "./requestMicrophone";

it("records from the chosen microphone, cancels an unanswered prompt, and stops a late stream", async () => {
  let grantPermission!: (media: MediaStream) => void;
  const permission = new Promise<MediaStream>((resolve) => {
    grantPermission = resolve;
  });
  using microphone = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockReturnValue(permission);
  const capture = createBrowserPcmCapture(
    {
      getMicrophoneId: async () => "blue-yeti",
      onLevel: vi.fn(),
      onDurationLimit: vi.fn(),
      onError: vi.fn(),
    },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  const abort = new AbortController();
  await capture.transcriber.prepare({ signal: abort.signal });
  const rejected = vi.fn();
  const preparing = capture.recorder.prepareToRecordAsync(abort.signal).catch(rejected);
  await vi.waitFor(() =>
    expect(microphone).toHaveBeenCalledExactlyOnceWith({
      audio: { deviceId: { exact: "blue-yeti" } },
    }),
  );
  abort.abort();
  const stop = vi.fn();
  try {
    await vi.waitFor(() => expect(rejected).toHaveBeenCalledWith(abort.signal.reason));
  } finally {
    grantPermission({ getTracks: () => [{ stop }] } as unknown as MediaStream);
    await preparing;
  }
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
});

it("falls back to the system default when the saved microphone is gone, and reports other failures", async () => {
  const media = {} as MediaStream;
  using microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockRejectedValueOnce(new DOMException("gone", "OverconstrainedError"))
    .mockResolvedValueOnce(media);
  await expect(requestMicrophone("blue-yeti")).resolves.toBe(media);
  expect(microphone).toHaveBeenLastCalledWith({ audio: true });

  const denied = new DOMException("denied", "NotAllowedError");
  microphone.mockRejectedValueOnce(denied);
  await expect(requestMicrophone("blue-yeti")).rejects.toBe(denied);
  expect(microphone).toHaveBeenCalledTimes(3);
});

it("waits for desktop call muting before recording and releases it on stop or cancellation", async () => {
  await userEvent.click(document.body);
  const source = new AudioContext();
  using _microphone = vi
    .spyOn(navigator.mediaDevices, "getUserMedia")
    .mockImplementation(async () => source.createMediaStreamDestination().stream);
  let allowRecording!: () => void;
  const ready = new Promise<void>((resolve) => {
    allowRecording = resolve;
  });
  const setRecording = vi.fn(async (active: boolean) => {
    if (active) {
      await ready;
    }
  });
  const capture = createBrowserPcmCapture(
    {
      getMicrophoneId: () => "",
      setDictationRecording: setRecording,
      onLevel: () => {},
      onDurationLimit: () => {},
      onError: () => {},
    },
    async () => ({ locale: "en", transcribe: async () => "" }),
  );
  try {
    const cancelled = new AbortController();
    await capture.transcriber.prepare({ signal: cancelled.signal });
    const preparing = capture.recorder.prepareToRecordAsync(cancelled.signal);
    await Promise.race([
      preparing,
      vi.waitFor(() => expect(setRecording).toHaveBeenCalledWith(true)),
    ]);
    cancelled.abort();
    expect(setRecording.mock.calls).toEqual([[true], [false]]);
    allowRecording();
    await expect(preparing).rejects.toBe(cancelled.signal.reason);

    const recording = new AbortController();
    await capture.transcriber.prepare({ signal: recording.signal });
    await capture.recorder.prepareToRecordAsync(recording.signal);
    capture.recorder.record({ forDuration: 60 });
    await capture.recorder.stop();
    recording.abort();
    expect(setRecording.mock.calls).toEqual([[true], [false], [true], [false]]);
  } finally {
    allowRecording();
    capture.cancelRecording();
    if (capture.recorder.uri) capture.deleteRecording(capture.recorder.uri);
    await source.close();
  }
});
