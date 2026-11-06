import * as Schema from "effect/Schema";
import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { requireOptionalNativeModule } from "expo";
import type { RecorderState, RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";
import type { NativeVoiceRecorder } from "../features/voice-input/lazyVoiceRecorder";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
  type VoiceTranscriptPreview,
} from "@t3tools/client-runtime/voice-input";

const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);

type LiveTranscriptionModule = {
  readonly LiveVoiceRecorder?: new () => NativeVoiceRecorder<RecordingStatus, RecorderState>;
  startLive?(id: number, uri: string, locale: string): Promise<string>;
  cancel?(id: number): Promise<void>;
  addListener?(
    event: "liveTranscriptPreview",
    listener: (event: { id: number } & VoiceTranscriptPreview) => void,
  ): { remove(): void };
};

const live = requireOptionalNativeModule<LiveTranscriptionModule>("T3VoiceTranscription");
let nextOperationId = 0;

/** False when this build predates live dictation; the recorder then records to a file. */
export const hasLiveVoiceRecorder = Boolean(live?.LiveVoiceRecorder && live.startLive);

export function createLiveVoiceRecorder() {
  return hasLiveVoiceRecorder && live?.LiveVoiceRecorder ? new live.LiveVoiceRecorder() : null;
}

function getDeviceLocale(): string {
  return Intl.DateTimeFormat().resolvedOptions().locale;
}

function wrapError(
  code: "preparation-failed" | "transcription-failed",
  message: string,
  cause: unknown,
): VoiceTranscriptionError {
  if (isVoiceTranscriptionError(cause)) {
    return cause;
  }

  return new VoiceTranscriptionError({ code, message, cause });
}

function getNativeErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

export async function getLocalVoiceTranscriber(
  isLive: () => boolean,
): Promise<VoiceTranscriber | null> {
  const locale = getDeviceLocale();
  if (!AppleTranscription.isAvailable(locale)) return null;
  return { prepare: (options) => prepareVoiceTranscription(locale, isLive(), options) };
}

async function prepareVoiceTranscription(
  locale: string,
  isLive: boolean,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!AppleTranscription.isAvailable(locale)) {
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: "Voice transcription requires a supported device with iOS 26 or later.",
    });
  }

  try {
    const supportedLocale = await AppleTranscription.prepare(locale);
    throwIfVoiceTranscriptionAborted(signal);
    const startLive = live?.startLive?.bind(live);
    return {
      locale: supportedLocale,
      ...(isLive && hasLiveVoiceRecorder && startLive
        ? { start: (uri, options) => transcribeLive(startLive, uri, supportedLocale, options) }
        : {}),
      transcribe: (uri, options) => transcribeVoiceRecording(uri, supportedLocale, options),
    };
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (getNativeErrorCode(error) === "AppleTranscriptionUnsupportedLocale") {
      throw new VoiceTranscriptionError({
        code: "unsupported-locale",
        message: "Voice transcription does not support this device language.",
        cause: error,
      });
    }

    throw wrapError(
      "preparation-failed",
      "Voice transcription could not prepare this language.",
      error,
    );
  }
}

async function transcribeLive(
  startLive: NonNullable<LiveTranscriptionModule["startLive"]>,
  uri: string,
  locale: string,
  {
    signal,
    onPreview,
  }: VoiceTranscriptionOptions & { readonly onPreview?: (preview: VoiceTranscriptPreview) => void },
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  const id = ++nextOperationId;
  const subscription = live?.addListener?.("liveTranscriptPreview", (event) => {
    if (event.id === id) onPreview?.({ committed: event.committed, tentative: event.tentative });
  });
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = live?.cancel?.(id).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const text = await startLive(id, uri, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return text.trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", "Voice transcription failed.", error);
  } finally {
    subscription?.remove();
    signal.removeEventListener("abort", abort);
    await cancellation;
  }
}

async function transcribeVoiceRecording(
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const audio = await new File(uri).arrayBuffer();
    throwIfVoiceTranscriptionAborted(signal);
    const result = await AppleTranscription.transcribe(audio, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return result.segments
      .map((segment) => segment.text)
      .join(" ")
      .trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", "Voice transcription failed.", error);
  }
}
