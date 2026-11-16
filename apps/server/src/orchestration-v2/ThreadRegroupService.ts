import {
  CommandId,
  type ThreadContentsTopic,
  type ThreadId,
  type ThreadRunLine,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildThreadRegroupPrompt } from "../textGeneration/ThreadRegroup.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  buildOutline,
  combineSamples,
  parseTopics,
  type RegroupTopic,
  repairTopics,
  THREAD_REGROUP_MIN_OWNER_RUNS,
} from "./ThreadRegroup.ts";

const SAMPLES = { mark: 1, idle: 3, manual: 3 } as const;
// A stuck provider call must not hold the thread's cards, which wait behind this effect.
const REGROUP_TIMEOUT = "90 seconds";

interface RegroupInput {
  readonly threadId: ThreadId;
  readonly kind: "mark" | "idle" | "manual";
  /** The effect's id; the record's command id is derived from it. */
  readonly effectId: string;
}

export class ThreadRegroupService extends Context.Service<
  ThreadRegroupService,
  {
    /**
     * Regroups a thread's entries from its run lines. Never fails and never retries: a failed
     * regroup is dropped and the next trigger tries again.
     */
    readonly execute: (input: RegroupInput) => Effect.Effect<void>;
    /**
     * Topics for these run lines from up to `samples` calls, combined. An empty list when fewer
     * than two runs show in the outline; null when no call gave a usable answer. Never fails.
     */
    readonly topics: (input: {
      readonly threadId: ThreadId;
      readonly runLines: ReadonlyArray<ThreadRunLine>;
      readonly samples: number;
    }) => Effect.Effect<ReadonlyArray<ThreadContentsTopic> | null>;
  }
>()("t3/orchestration-v2/ThreadRegroupService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const entryStore = yield* ThreadEntryStore.ThreadEntryStore;
  const fileSystem = yield* FileSystem.FileSystem;

  const sampleTopics = Effect.fn("ThreadRegroupService.topics")(
    function* (input: {
      readonly threadId: ThreadId;
      readonly runLines: ReadonlyArray<ThreadRunLine>;
      readonly samples: number;
    }) {
      const settings = yield* serverSettings.getSettings;
      const outline = buildOutline(input.runLines);
      const runCount = outline.runIds.length;
      if (runCount < 2) return [];

      const prompt = buildThreadRegroupPrompt(outline.text);
      // Providers run in a working directory; a regroup reads only its outline.
      const cwd = yield* fileSystem
        .makeTempDirectoryScoped({ prefix: "t3-thread-regroup-" })
        .pipe(Effect.orDie);
      const samples: Array<ReadonlyArray<RegroupTopic>> = [];
      for (let sample = 0; sample < input.samples; sample++) {
        const generated = yield* textGeneration
          .generateTranscriptionPostProcessing({
            cwd,
            prompt,
            modelSelection: settings.threadReplySummaryModelSelection,
          })
          .pipe(Effect.result);
        if (generated._tag === "Failure") {
          yield* Effect.logWarning("Thread regroup sample failed", {
            threadId: input.threadId,
            sample,
            cause: generated.failure,
          });
          // A first call that fails means the model is unreachable; the others would fail too.
          if (sample === 0) break;
          continue;
        }
        const topics = parseTopics(generated.success.transcription, runCount);
        if (topics !== null) samples.push(repairTopics(topics, runCount).topics);
      }
      if (samples.length === 0) return null;
      return combineSamples(samples, runCount).map((topic): ThreadContentsTopic => ({
        title: topic.title,
        outcome: topic.outcome,
        runIds: topic.runs.map((run) => outline.runIds[run - 1]!),
      }));
    },
    Effect.scoped,
    (effect) =>
      effect.pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Thread regroup failed", { cause }).pipe(Effect.as(null)),
        ),
      ),
  );

  const regroup = Effect.fn("ThreadRegroupService.regroup")(function* (input: RegroupInput) {
    const settings = yield* serverSettings.getSettings;
    if (settings.threadReplySummariesEnabled !== true) return;
    const { thread } = yield* threads.getThreadRecords(input.threadId, []);
    if (thread.deletedAt !== null) return;
    const contents = yield* entryStore.getThreadContents(input.threadId);
    if (contents.state === null) return;
    if (input.kind !== "manual" && contents.state.ownerRuns < THREAD_REGROUP_MIN_OWNER_RUNS) return;
    const topics = yield* sampleTopics({
      threadId: input.threadId,
      runLines: yield* entryStore.runLines(input.threadId),
      samples: SAMPLES[input.kind],
    });
    if (topics === null) {
      yield* Effect.logWarning("Thread regroup produced no usable sample", {
        threadId: input.threadId,
        kind: input.kind,
      });
      return;
    }
    if (topics.length === 0) return;

    yield* threads.dispatch({
      type: "thread.contents.regroup.record",
      commandId: CommandId.make(`command:contents-regroup:${input.effectId}`),
      threadId: input.threadId,
      kind: input.kind,
      topics,
    });
  });

  const execute: ThreadRegroupService["Service"]["execute"] = Effect.fn(
    "ThreadRegroupService.execute",
  )(function (input) {
    return regroup(input).pipe(
      Effect.timeout(REGROUP_TIMEOUT),
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread regroup failed", { ...input, cause }),
      ),
    );
  });

  return ThreadRegroupService.of({ execute, topics: sampleTopics });
});

export const layer = Layer.effect(ThreadRegroupService, make);
