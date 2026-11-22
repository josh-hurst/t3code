import * as Schema from "effect/Schema";
import { requireOptionalNativeModule } from "expo";
import type { RecorderState, RecordingStatus } from "expo-audio";
import type { NativeVoiceRecorder } from "../features/voice-input/lazyVoiceRecorder";
import { msg } from "gt-react-native";
import { Settings } from "react-native";
import { m } from "../i18n/messages";

import {
  VoiceTranscriptionError,
  throwIfVoiceTranscriptionAborted,
  type PreparedVoiceTranscription,
  type VoiceTranscriber,
  type VoiceTranscriptionOptions,
  type VoiceTranscriptPreview,
} from "@t3tools/client-runtime/voice-input";

interface AppleSpeechModule {
  isAppleSpeechAvailable?: () => boolean;
  prepareAppleSpeech: (locale: string) => Promise<string | null>;
  transcribeWithAppleSpeech: (uri: string, locale: string) => Promise<string>;
  readonly LiveVoiceRecorder?: new () => NativeVoiceRecorder<RecordingStatus, RecorderState>;
  startLive?(id: number, uri: string, locale: string): Promise<string>;
  cancel?(id: number): Promise<void>;
  addListener?(
    event: "liveTranscriptPreview",
    listener: (event: { id: number } & VoiceTranscriptPreview) => void,
  ): { remove(): void };
}

const native = requireOptionalNativeModule<AppleSpeechModule>("T3VoiceTranscription");
const isVoiceTranscriptionError = Schema.is(VoiceTranscriptionError);
let nextOperationId = 0;

/** False when this build predates live dictation; the recorder then records to a file. */
export const hasLiveVoiceRecorder = Boolean(native?.LiveVoiceRecorder && native.startLive);

export function createLiveVoiceRecorder() {
  return hasLiveVoiceRecorder && native?.LiveVoiceRecorder ? new native.LiveVoiceRecorder() : null;
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

export async function getLocalVoiceTranscriber(
  isLive: () => boolean,
): Promise<VoiceTranscriber | null> {
  const locales = getPreferredLocales();
  // Availability is a device and OS check; which languages have a model only `prepare` knows.
  if (!native?.isAppleSpeechAvailable?.()) return null;
  return { prepare: (options) => prepareVoiceTranscription(native, locales, isLive(), options) };
}

async function prepareVoiceTranscription(
  native: AppleSpeechModule,
  locales: readonly string[],
  isLive: boolean,
  { signal }: VoiceTranscriptionOptions,
): Promise<PreparedVoiceTranscription> {
  throwIfVoiceTranscriptionAborted(signal);
  if (!native?.isAppleSpeechAvailable?.()) {
    throw new VoiceTranscriptionError({
      code: "unavailable",
      message: m(
        msg("Voice transcription requires a supported device with {platform} or later.", {
          platform: "iOS 26",
        }),
      ),
    });
  }

  let locale = locales[0]!;
  const model = prepareLocales(native, locales, signal).then((supported) => {
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
  const startLive = isLive && hasLiveVoiceRecorder ? native.startLive?.bind(native) : undefined;
  return {
    get locale() {
      return locale;
    },
    start: async (uri, options) => {
      const supportedLocale = await ready(options.signal);
      return startLive ? transcribeLive(native, startLive, uri, supportedLocale, options) : null;
    },
    transcribe: async (uri, options) =>
      transcribeVoiceRecording(native, uri, await ready(options.signal), options),
  };
}

async function prepareLocales(
  native: AppleSpeechModule,
  locales: readonly string[],
  signal: AbortSignal,
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  let unsupported: VoiceTranscriptionError | undefined;
  for (const locale of locales) {
    try {
      return await prepareLocale(native, locale, signal);
    } catch (error) {
      if (!isVoiceTranscriptionError(error) || error.code !== "unsupported-locale") throw error;
      unsupported = error;
    }
  }
  throw unsupported!;
}

async function prepareLocale(
  native: AppleSpeechModule,
  locale: string,
  signal: AbortSignal,
): Promise<string> {
  let supportedLocale: string | null;
  try {
    supportedLocale = await native.prepareAppleSpeech(locale);
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError(
      "preparation-failed",
      m(msg("Voice transcription could not prepare this language.")),
      error,
    );
  }
  throwIfVoiceTranscriptionAborted(signal);
  if (supportedLocale === null) {
    throw new VoiceTranscriptionError({
      code: "unsupported-locale",
      message: m(msg("Voice transcription does not support any of your languages.")),
    });
  }
  return supportedLocale;
}

async function transcribeLive(
  native: AppleSpeechModule,
  startLive: NonNullable<AppleSpeechModule["startLive"]>,
  uri: string,
  locale: string,
  {
    signal,
    onPreview,
  }: VoiceTranscriptionOptions & { readonly onPreview?: (preview: VoiceTranscriptPreview) => void },
): Promise<string> {
  throwIfVoiceTranscriptionAborted(signal);
  const id = ++nextOperationId;
  const subscription = native.addListener?.("liveTranscriptPreview", (event) => {
    if (event.id === id) onPreview?.({ committed: event.committed, tentative: event.tentative });
  });
  let cancellation: Promise<void> | undefined;
  const abort = () => {
    cancellation = native.cancel?.(id).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    const text = await startLive(id, uri, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return text.trim();
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", m(msg("Voice transcription failed.")), error);
  } finally {
    subscription?.remove();
    signal.removeEventListener("abort", abort);
    await cancellation;
  }
}

async function transcribeVoiceRecording(
  native: AppleSpeechModule,
  uri: string,
  locale: string,
  { signal }: VoiceTranscriptionOptions,
): Promise<string> {
  try {
    throwIfVoiceTranscriptionAborted(signal);
    const text = await native.transcribeWithAppleSpeech(uri, locale);
    throwIfVoiceTranscriptionAborted(signal);
    return text;
  } catch (error) {
    throwIfVoiceTranscriptionAborted(signal);
    throw wrapError("transcription-failed", m(msg("Voice transcription failed.")), error);
  }
}
