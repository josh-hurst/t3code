import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type { HttpClientError } from "effect/http";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import type { PlatformError } from "effect/PlatformError";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import {
  makeHuggingFaceModelStore,
  type HuggingFaceFileDownloadProgress,
  type PinnedHuggingFaceFile,
} from "../modelStore.ts";
import type { SpeechModel } from "./model.ts";

type ModelFile = Pick<SpeechModel, "id" | "filename" | "revision" | "size" | "sha256">;

class SpeechModelDownloadError extends Schema.TaggedError<SpeechModelDownloadError>()(
  "SpeechModelDownloadError",
  {
    modelId: Schema.String,
    reason: Schema.Literals(["status", "range", "size", "verification"]),
    status: Schema.optional(Schema.Number),
  },
) {
  override get message(): string {
    return `Speech model download failed: ${this.reason}${this.status === undefined ? "" : ` ${this.status}`}.`;
  }
}

export class SpeechModelStore extends Context.Service<
  SpeechModelStore,
  {
    /** Cheap size check for status polls; never hashes the file. */
    readonly isReady: (model: ModelFile) => Effect.Effect<boolean>;
    /** The installed file once its SHA-256 has been verified, hashing it on first use. */
    readonly installedPath: (model: ModelFile) => Effect.Effect<string | undefined>;
    /** Links a copy the Hugging Face cache or Handy already holds; fetches only without one. */
    readonly download: (
      model: ModelFile,
      progress?: HuggingFaceFileDownloadProgress,
    ) => Effect.Effect<
      string,
      SpeechModelDownloadError | PlatformError | HttpClientError.HttpClientError
    >;
    /**
     * Installs catalog files already on this machine as symlinks, never copies.
     * `source` is a file or a folder to search; returns the ids it installed.
     */
    readonly link: (
      models: ReadonlyArray<ModelFile>,
      source: string,
    ) => Effect.Effect<ReadonlyArray<string>, PlatformError>;
    /** The outside file a linked model points at. */
    readonly linkedFrom: (model: ModelFile) => Effect.Effect<string | undefined>;
    /** Removes T3 Code's file or link; a linked file itself is left in place. */
    readonly remove: (model: ModelFile) => Effect.Effect<void, PlatformError>;
  }
>()("t3/speech/SpeechModelStore") {}

const handyCopies = (
  model: PinnedHuggingFaceFile,
  {
    home,
    platform,
    path,
  }: { readonly home: string; readonly platform: string; readonly path: Path.Path },
) => {
  const appDataDirectories =
    platform === "darwin"
      ? [path.join(home, "Library", "Application Support")]
      : platform === "win32"
        ? [path.join(home, "AppData", "Roaming")]
        : [path.join(home, ".local", "share"), path.join(home, ".config")];
  return appDataDirectories.map((appData) =>
    path.join(appData, "com.pais.handy", "models", model.filename),
  );
};

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const store = yield* makeHuggingFaceModelStore({
    directory: path.join(config.stateDir, "speech", "models"),
    spanPrefix: "SpeechModelStore",
    extraKnownCopies: handyCopies,
  });

  return SpeechModelStore.of({
    ...store,
    download: Effect.fn("SpeechModelStore.download")((model, progress) =>
      store.download(model, progress).pipe(
        Effect.catchTags({
          HuggingFaceFileDownloadError: (error) =>
            Effect.fail(
              new SpeechModelDownloadError({
                modelId: error.modelId,
                reason: error.reason,
                ...(error.status === undefined ? {} : { status: error.status }),
              }),
            ),
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(SpeechModelStore, make);
