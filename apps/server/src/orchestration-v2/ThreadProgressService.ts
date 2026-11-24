import {
  CommandId,
  isListedThreadLineage,
  type OrchestrationV2DomainEvent,
  type ThreadId,
  type ThreadProgressAgent,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  buildThreadProgressPrompt,
  parseThreadProgress,
} from "../textGeneration/ThreadProgress.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  applyDomainEventToThreadProgress,
  beginGeneration,
  buildPromptSnapshotForThread,
  createThreadProgressState,
  dropTrackedThread,
  dueThreadIds,
  finishGeneration,
  hasLiveSubagent,
  liveSubagentIds,
  nextDueAtMs,
  recordGenerationResult,
} from "./ThreadProgressState.ts";

const make = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;

  const state = createThreadProgressState();
  const fibers = yield* FiberSet.make<void, never>();
  const wakeQueue = yield* Queue.sliding<void>(1);

  const wake = () => Queue.offer(wakeQueue, undefined).pipe(Effect.asVoid);

  const clearProgress = Effect.fn("ThreadProgressService.clearProgress")(function* (
    threadId: ThreadId,
  ) {
    const uuid = yield* random.uuidV4();
    yield* orchestrator
      .dispatch({
        type: "thread.progress.record",
        commandId: CommandId.make(`server:thread-progress-clear:${threadId}:${uuid}`),
        threadId,
        progress: null,
      })
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Thread progress clear failed", { threadId, cause }),
        ),
      );
  });

  const generateForThread = Effect.fn("ThreadProgressService.generate")(function* (
    threadId: ThreadId,
  ) {
    const settings = yield* serverSettings.getSettings;
    if (settings.threadReplySummariesEnabled !== true) return;

    const shell = yield* orchestrator.getThreadShell(threadId);
    if (
      shell === null ||
      shell.deletedAt !== null ||
      shell.archivedAt !== null ||
      !isListedThreadLineage(shell.lineage)
    ) {
      dropTrackedThread(state, threadId);
      return;
    }

    const snapshot = buildPromptSnapshotForThread(state, threadId, shell);
    if (snapshot === null) return;

    // Providers run in a working directory; progress generation must not read a checkout or its memory.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-progress-" });
    const generated = yield* textGeneration.generateTranscriptionPostProcessing({
      cwd,
      prompt: buildThreadProgressPrompt(snapshot.promptInput),
      modelSelection: settings.threadReplySummaryModelSelection,
    });

    const parsed = parseThreadProgress(generated.transcription, snapshot.refToSubagentId.keys());
    if (parsed === null) return;
    if (!hasLiveSubagent(state, threadId)) return;

    const liveIds = liveSubagentIds(state, threadId);
    const agents: Array<ThreadProgressAgent> = [];
    for (const entry of parsed.agents) {
      const subagentId = snapshot.refToSubagentId.get(entry.ref);
      if (subagentId === undefined || !liveIds.has(subagentId)) continue;
      agents.push({ subagentId, line: entry.line });
    }

    const uuid = yield* random.uuidV4();
    yield* orchestrator.dispatch({
      type: "thread.progress.record",
      commandId: CommandId.make(`server:thread-progress:${threadId}:${uuid}`),
      threadId,
      progress: {
        line: parsed.line,
        agents,
      },
    });
    recordGenerationResult(state, threadId, parsed.line, agents);
    // The last subagent can end while the record commits; nothing later would clear that line.
    if (!hasLiveSubagent(state, threadId)) yield* clearProgress(threadId);
  }, Effect.scoped);

  const runGeneration = Effect.fn("ThreadProgressService.runGeneration")(function* (
    threadId: ThreadId,
  ) {
    yield* generateForThread(threadId).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning("Thread progress generation failed", { threadId, cause }),
      ),
      Effect.ensuring(
        Clock.currentTimeMillis.pipe(
          Effect.tap((nowMs) =>
            Effect.sync(() => {
              finishGeneration(state, threadId, nowMs);
            }),
          ),
          Effect.andThen(wake()),
        ),
      ),
    );
  });

  const dispatchDue = Effect.fn("ThreadProgressService.dispatchDue")(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    const due = dueThreadIds(state, nowMs);
    for (const threadId of due) {
      if (!beginGeneration(state, threadId)) continue;
      yield* FiberSet.run(fibers, runGeneration(threadId));
    }
  });

  // Runs for every domain event including streaming deltas; most return immediately without I/O.
  const onDomainEvent = Effect.fnUntraced(function* (event: OrchestrationV2DomainEvent) {
    const result = applyDomainEventToThreadProgress(
      state,
      event,
      DateTime.toEpochMillis(event.occurredAt),
    );
    if (result.clearThreadId !== undefined) {
      yield* FiberSet.run(fibers, clearProgress(result.clearThreadId));
    }
    if (result.wakeup) {
      yield* wake();
    }
  });

  const schedulerLoop = Effect.forever(
    Effect.gen(function* () {
      yield* dispatchDue();
      const nextAt = nextDueAtMs(state);
      if (nextAt === null) {
        yield* Queue.take(wakeQueue);
        return;
      }
      const nowMs = yield* Clock.currentTimeMillis;
      const waitMs = Math.max(0, nextAt - nowMs);
      if (waitMs === 0) return;
      yield* Effect.raceFirst(
        Effect.sleep(Duration.millis(waitMs)),
        Queue.take(wakeQueue).pipe(Effect.asVoid),
      );
    }),
  );

  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, onDomainEvent).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Thread progress event stream failed", { cause }),
      ),
    ),
  );
  yield* forkParked(schedulerLoop);
});

export const layer = Layer.effectDiscard(make);
