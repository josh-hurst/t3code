import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import { makeHuggingFaceModelStore } from "../modelStore.ts";
import {
  BGE_SMALL_EN_V15_DIMENSIONS,
  BGE_SMALL_EN_V15_MODEL_ID,
  BGE_SMALL_EN_V15_ONNX,
  BGE_SMALL_EN_V15_QUERY_PREFIX,
  BGE_SMALL_EN_V15_VOCAB,
  isSemanticSearchPlatformSupported,
} from "./model.ts";
import { spawnNativeSemanticWorker, type NativeSemanticWorker } from "./worker.ts";

export class SemanticEmbedderError extends Schema.TaggedError<SemanticEmbedderError>()(
  "SemanticEmbedderError",
  {
    stage: Schema.Literals(["unsupported", "download", "worker", "embed"]),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Semantic embedding failed (${this.stage}).`;
  }
}

export class SemanticEmbedder extends Context.Service<
  SemanticEmbedder,
  {
    readonly modelId: string;
    readonly dimensions: number;
    readonly embedPassages: (
      texts: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<Float32Array>, SemanticEmbedderError>;
    readonly embedQuery: (query: string) => Effect.Effect<Float32Array, SemanticEmbedderError>;
    readonly shutdown: Effect.Effect<void>;
  }
>()("t3/semanticSearch/SemanticEmbedder") {}

const WORKER_IDLE_TIMEOUT = Duration.seconds(60);
// Back off after a download or native load failure so keystrokes do not retry in a loop.
const FAILURE_BACKOFF_MS = 5 * 60_000;

interface QueuedRequest {
  readonly priority: "high" | "low";
  readonly texts: ReadonlyArray<string>;
  readonly deferred: Deferred.Deferred<ReadonlyArray<Float32Array>, SemanticEmbedderError>;
}

const make = Effect.gen(function* () {
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const platform = yield* HostProcess.Platform;
  const arch = yield* HostProcess.Architecture;
  const libc = platform === "linux" ? yield* HostProcess.LinuxLibc : undefined;
  const scope = yield* Effect.scope;
  const supported = isSemanticSearchPlatformSupported(platform, arch, libc);

  const modelStore = yield* makeHuggingFaceModelStore({
    directory: path.join(config.stateDir, "semantic-search", "models"),
    spanPrefix: "SemanticModelStore",
  });

  let worker: NativeSemanticWorker | null = null;
  let idleFiber: Fiber.Fiber<void> | null = null;
  let unavailableUntilMs = 0;
  let draining = false;
  const queue: QueuedRequest[] = [];

  const cancelIdleTimer = Effect.gen(function* () {
    const fiber = idleFiber;
    idleFiber = null;
    if (fiber !== null) yield* Fiber.interrupt(fiber);
  });

  const disposeWorker = Effect.gen(function* () {
    yield* cancelIdleTimer;
    const current = worker;
    worker = null;
    if (current !== null) {
      yield* Effect.promise(() => current.dispose()).pipe(Effect.ignore);
    }
  });

  yield* Effect.addFinalizer(() => disposeWorker);

  const scheduleIdleShutdown = Effect.gen(function* () {
    yield* cancelIdleTimer;
    idleFiber = yield* Effect.sleep(WORKER_IDLE_TIMEOUT).pipe(
      Effect.andThen(disposeWorker),
      Effect.forkIn(scope),
    );
  });

  const ensureWorker = Effect.fn("SemanticEmbedder.ensureWorker")(function* () {
    if (!supported) {
      return yield* new SemanticEmbedderError({ stage: "unsupported" });
    }
    const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
    if (nowMs < unavailableUntilMs) {
      return yield* new SemanticEmbedderError({ stage: "worker" });
    }
    if (worker !== null) return worker;

    const paths = yield* Effect.all({
      modelPath: modelStore.download(BGE_SMALL_EN_V15_ONNX),
      vocabPath: modelStore.download(BGE_SMALL_EN_V15_VOCAB),
    }).pipe(
      Effect.mapError((cause) => {
        unavailableUntilMs = nowMs + FAILURE_BACKOFF_MS;
        return new SemanticEmbedderError({ stage: "download", cause });
      }),
    );

    const spawned = yield* Effect.tryPromise({
      try: (signal) =>
        spawnNativeSemanticWorker({
          modelPath: paths.modelPath,
          vocabPath: paths.vocabPath,
          dimensions: BGE_SMALL_EN_V15_DIMENSIONS,
          signal,
        }),
      catch: (cause) => {
        unavailableUntilMs = nowMs + FAILURE_BACKOFF_MS;
        return new SemanticEmbedderError({ stage: "worker", cause });
      },
    });
    worker = spawned;
    return spawned;
  });

  const runBatch = Effect.fn("SemanticEmbedder.runBatch")(function* (texts: ReadonlyArray<string>) {
    yield* cancelIdleTimer;
    const active = yield* ensureWorker();
    const result = yield* Effect.tryPromise({
      try: () => active.embed(texts),
      catch: (cause) => new SemanticEmbedderError({ stage: "embed", cause }),
    }).pipe(Effect.tapError(() => disposeWorker));
    return result.vectors;
  });

  const drainQueue: Effect.Effect<void> = Effect.gen(function* () {
    if (draining) return;
    draining = true;
    while (true) {
      while (queue.length > 0) {
        // Queries jump ahead of background backfill batches so interactive search never queues behind indexing.
        const highIndex = queue.findIndex((item) => item.priority === "high");
        const next = queue.splice(highIndex === -1 ? 0 : highIndex, 1)[0]!;
        const exit = yield* Effect.exit(runBatch(next.texts));
        yield* Deferred.done(next.deferred, exit);
      }
      if (worker !== null) yield* scheduleIdleShutdown;
      // Checked and cleared without yielding, so a request queued meanwhile is never stranded.
      if (queue.length === 0) {
        draining = false;
        return;
      }
    }
  });

  const enqueue = Effect.fn("SemanticEmbedder.enqueue")(function* (
    priority: "high" | "low",
    texts: ReadonlyArray<string>,
  ) {
    if (texts.length === 0) return [] as ReadonlyArray<Float32Array>;
    const deferred = yield* Deferred.make<ReadonlyArray<Float32Array>, SemanticEmbedderError>();
    queue.push({ priority, texts, deferred });
    if (!draining) {
      yield* Effect.forkIn(drainQueue, scope);
    }
    return yield* Deferred.await(deferred);
  });

  return SemanticEmbedder.of({
    modelId: BGE_SMALL_EN_V15_MODEL_ID,
    dimensions: BGE_SMALL_EN_V15_DIMENSIONS,
    embedPassages: Effect.fn("SemanticEmbedder.embedPassages")((texts) => enqueue("low", texts)),
    embedQuery: Effect.fn("SemanticEmbedder.embedQuery")(function* (query) {
      const vectors = yield* enqueue("high", [`${BGE_SMALL_EN_V15_QUERY_PREFIX}${query}`]);
      const first = vectors[0];
      if (first === undefined) {
        return yield* new SemanticEmbedderError({ stage: "embed" });
      }
      return first;
    }),
    shutdown: Effect.gen(function* () {
      unavailableUntilMs = 0;
      yield* disposeWorker;
    }).pipe(Effect.withSpan("SemanticEmbedder.shutdown")),
  });
});

export const layer = Layer.effect(SemanticEmbedder, make);
