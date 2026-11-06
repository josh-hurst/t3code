import type { OrchestrationV2GetReplySummaryInput } from "@t3tools/contracts";
import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { buildReplySummaryPrompt, sanitizeReplySummary } from "../textGeneration/ReplySummary.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const REPLY_SUMMARY_CACHE_CAPACITY = 3_000;
export const REPLY_SUMMARY_CACHE_FILE_NAME = "reply-summaries.json";
const GENERATION_CONCURRENCY = 2;

const CacheFile = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.Literal(1),
    /** Least recently used first. */
    entries: Schema.Array(Schema.Tuple([Schema.String, Schema.String, Schema.String])),
  }),
);
const decodeCacheFile = Schema.decodeUnknownEffect(CacheFile);
const encodeCacheFile = Schema.encodeEffect(CacheFile);

type Key = readonly [threadId: string, messageId: string];
const keyString = ([threadId, messageId]: Key) => `${threadId}\n${messageId}`;

/**
 * Summaries by thread and message, evicting the least recently used past capacity. Null marks a
 * reply that has no summary this run (not a reply, or generation failed); only strings persist.
 */
export class ReplySummaryLru {
  private readonly entries = new Map<
    string,
    { readonly key: Key; readonly value: string | null }
  >();

  readonly capacity: number;

  constructor(capacity: number) {
    this.capacity = capacity;
  }

  get size() {
    return this.entries.size;
  }

  get(key: Key): string | null | undefined {
    const id = keyString(key);
    const entry = this.entries.get(id);
    if (entry === undefined) return undefined;
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.value;
  }

  set(key: Key, value: string | null) {
    const id = keyString(key);
    this.entries.delete(id);
    this.entries.set(id, { key, value });
    for (const oldest of this.entries.keys()) {
      if (this.entries.size <= this.capacity) break;
      this.entries.delete(oldest);
    }
  }

  persisted(): Array<readonly [string, string, string]> {
    return [...this.entries.values()].flatMap(({ key, value }) =>
      value === null ? [] : [[key[0], key[1], value] as const],
    );
  }
}

export class ThreadReplySummaries extends Context.Service<
  ThreadReplySummaries,
  {
    /** Cached or newly generated summary of an assistant message; null when there is none. */
    readonly summarize: (
      input: OrchestrationV2GetReplySummaryInput,
    ) => Effect.Effect<string | null>;
  }
>()("t3/orchestration-v2/ThreadReplySummaries") {}

export const make = Effect.fn("ThreadReplySummaries.make")(function* (
  capacity: number = REPLY_SUMMARY_CACHE_CAPACITY,
) {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const scope = yield* Effect.scope;
  const cachePath = path.join(config.stateDir, REPLY_SUMMARY_CACHE_FILE_NAME);

  const cache = new ReplySummaryLru(capacity);
  const stored = yield* fileSystem.readFileString(cachePath).pipe(
    Effect.flatMap(decodeCacheFile),
    Effect.orElseSucceed(() => null),
  );
  for (const [threadId, messageId, summary] of stored?.entries ?? []) {
    cache.set([threadId, messageId], summary);
  }

  const inFlight = new Map<string, Deferred.Deferred<string | null>>();
  const generationPermits = yield* Semaphore.make(GENERATION_CONCURRENCY);
  const writeLock = yield* Semaphore.make(1);

  const persist = writeLock.withPermit(
    Effect.suspend(() => encodeCacheFile({ version: 1, entries: cache.persisted() })).pipe(
      Effect.flatMap((contents) => writeFileStringAtomically({ filePath: cachePath, contents })),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.ignoreCause({ log: true }),
    ),
  );

  /** `cacheable: false` for a reply still streaming, which a later request can summarize. */
  const generate = Effect.fn("ThreadReplySummaries.generate")(function* (
    input: OrchestrationV2GetReplySummaryInput,
  ) {
    const records = yield* threads.getThreadRecords(input.threadId, ["messages"], {
      messageIds: [input.messageId],
    });
    const message = records.messages.find((candidate) => candidate.id === input.messageId);
    if (message?.streaming) return { summary: null, cacheable: false };
    if (message === undefined || message.role !== "assistant" || message.text.trim() === "") {
      return { summary: null, cacheable: true };
    }
    const settings = yield* serverSettings.getSettings;
    // Providers run in a working directory; a summary must not read a checkout or its memory.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-reply-summary-" });
    const generated = yield* generationPermits.withPermit(
      textGeneration.generateTranscriptionPostProcessing({
        cwd,
        prompt: buildReplySummaryPrompt(message.text),
        modelSelection: settings.threadReplySummaryModelSelection,
      }),
    );
    return { summary: sanitizeReplySummary(generated.transcription), cacheable: true };
  }, Effect.scoped);

  const run = (
    input: OrchestrationV2GetReplySummaryInput,
    deferred: Deferred.Deferred<string | null>,
  ) => {
    const id = keyString([input.threadId, input.messageId]);
    return generate(input).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Reply summary generation failed", {
              threadId: input.threadId,
              messageId: input.messageId,
              cause,
            }).pipe(Effect.as({ summary: null, cacheable: true })),
      ),
      Effect.flatMap(({ summary, cacheable }) =>
        Effect.gen(function* () {
          // Failures stay cached in memory so a reconnecting client cannot retry them in a loop.
          if (cacheable) cache.set([input.threadId, input.messageId], summary);
          if (summary !== null) yield* persist;
          yield* Deferred.succeed(deferred, summary);
        }),
      ),
      Effect.ensuring(
        Effect.sync(() => {
          if (inFlight.get(id) === deferred) inFlight.delete(id);
        }).pipe(Effect.andThen(Deferred.interrupt(deferred))),
      ),
    );
  };

  const summarize: ThreadReplySummaries["Service"]["summarize"] = Effect.fn(
    "ThreadReplySummaries.summarize",
  )(function* (input) {
    const settings = yield* serverSettings.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings?.threadReplySummariesEnabled !== true) return null;
    const key = [input.threadId, input.messageId] as const;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    let pending = inFlight.get(keyString(key));
    if (pending === undefined) {
      // Created synchronously so concurrent callers for the key always find it.
      const deferred = Deferred.makeUnsafe<string | null>();
      inFlight.set(keyString(key), deferred);
      pending = deferred;
      // Forked into the service scope so a caller that stops waiting does not cancel the run.
      yield* run(input, deferred).pipe(Effect.forkIn(scope));
    }
    return yield* Deferred.await(pending);
  });

  return ThreadReplySummaries.of({ summarize });
});

export const layer = Layer.effect(ThreadReplySummaries, make());
