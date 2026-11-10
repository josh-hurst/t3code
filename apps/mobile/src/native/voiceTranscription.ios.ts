import * as Schema from "effect/Schema";
import AppleTranscription from "@react-native-ai/apple/src/NativeAppleTranscription";
import { requireOptionalNativeModule } from "expo";
import type { RecorderState, RecordingStatus } from "expo-audio";
import { File } from "expo-file-system";
import type { NativeVoiceRecorder } from "../features/voice-input/lazyVoiceRecorder";
import { Settings } from "react-native";

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

/** The user's ordered Language & Region list, then the app locale; the app ships in English only. */
function getPreferredLocales(): string[] {
  const languages: unknown = Settings.get("AppleLanguages");
  const preferred = Array.isArray(languages)
    ? languages.filter(
        (language): language is string => typeof language === "string" && language.length > 0,
      )
    : [];
  return [...new Set([...preferred, Intl.DateTimeFormat().resolvedOptions().locale])];
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
  const locales = getPreferredLocales();
  // Availability is a device and OS check; which languages have a model only `prepare` knows.
  if (!AppleTranscription.isAvailable(locales[0]!)) return null;
  return { prepare: (options) => prepareVoiceTranscription(locales, isLive(), options) };
}

async function prepareVoiceTranscription(
  locales: readonly string[],
  isLive: boolean,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!AppleTranscription.isAvailable(locales[0]!)) {
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: "Voice transcription requires a supported device with iOS 26 or later.",
    });
  }

  let locale = locales[0]!;
  const model = prepareLocales(locales, signal).then((supported) => {
    locale = supported;
  });
  // Recorder setup can fail before either consumer observes the model.
  void model.catch(() => {});

  async function ready(signal: AbortSignal) {
    throwIfVoiceTranscriptionAborted(signal);
    const cancelled = Promise.withResolvers<void>();
    const cancel = () => cancelled.resolve();
    signal.addEventListener("abort", cancel, { once: true });
    try {
      await Promise.race([model, cancelled.promise]);
      throwIfVoiceTranscriptionAborted(signal);
      return locale;
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }
  const startLive = isLive && hasLiveVoiceRecorder ? live?.startLive?.bind(live) : undefined;
  return {
    get locale() {
      return locale;
    },
    start: async (uri, options) => {
      const supportedLocale = await ready(options.signal);
      return startLive ? transcribeLive(startLive, uri, supportedLocale, options) : null;
    },
    transcribe: async (uri, options) =>
      transcribeVoiceRecording(uri, await ready(options.signal), options),
  };
}

async function prepareLocales(locales: readonly string[], signal: AbortSignal): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  let unsupported: VoiceTranscriptionError | undefined;
  for (const locale of locales) {
    try {
      return await prepareLocale(locale, signal);
    } catch (error) {
      if (!isVoiceTranscriptionError(error) || error.code !== "unsupported-locale") throw error;
      unsupported = error;
    }
  }
  throw unsupported!;
}

async function prepareLocale(locale: string, signal: AbortSignal): Promise<string> {
  try {
    const supportedLocale = await AppleTranscription.prepare(locale);
    throwIfVoiceTranscriptionAborted(signal);
    return supportedLocale;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    if (getNativeErrorCode(error) === "AppleTranscriptionUnsupportedLocale") {
      throw new VoiceTranscriptionError({
        code: "unsupported-locale",
        message: "Voice transcription does not support any of your languages.",
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
