import {
  CommandId,
  idleCompactionOf,
  isListedThreadLineage,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { buildThreadCardPrompt, parseThreadCard } from "../textGeneration/ThreadCard.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class ThreadCardService extends Context.Service<
  ThreadCardService,
  {
    /** Writes the card for a completed run. Never fails: the previous card stays until the next run. */
    readonly execute: (input: {
      readonly threadId: ThreadId;
      readonly runId: RunId;
    }) => Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ThreadCardService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* ServerConfig.ServerConfig;
  // Cards replaced the per-row reply summaries, whose cache file nothing reads any more.
  yield* fileSystem.remove(path.join(stateDir, "reply-summaries.json")).pipe(Effect.ignore);

  const generate = Effect.fn("ThreadCardService.generate")(function* (input: {
    readonly threadId: ThreadId;
    readonly runId: RunId;
  }) {
    const settings = yield* serverSettings.getSettings;
    if (settings.threadReplySummariesEnabled !== true) return;

    const records = yield* threads.getThreadRecords(input.threadId, ["messages", "runs"], {
      messageRunIds: [input.runId],
      runIds: [input.runId],
    });
    const thread = records.thread;
    if (
      thread.deletedAt !== null ||
      thread.archivedAt !== null ||
      !isListedThreadLineage(thread.lineage) ||
      // The effect is at-least-once; a replay must not pay for a second generation.
      thread.card?.runId === input.runId
    ) {
      return;
    }
    const run = records.runs.find((candidate) => candidate.id === input.runId);
    if (run?.status !== "completed") return;

    // The shell's latest message can already be the user's next one, so the reply is read by run.
    const reply = records.messages
      .filter((message) => message.role === "assistant" && message.runId === input.runId)
      .at(-1);
    if (reply === undefined || reply.streaming || reply.text.trim() === "") return;

    const userMessage =
      records.messages.find((message) => message.id === run.userMessageId) ??
      (yield* threads.getThreadRecords(input.threadId, ["messages"], {
        messageIds: [run.userMessageId],
      })).messages[0];
    if (
      userMessage !== undefined &&
      (isNativeMaintenanceCommand(userMessage) || idleCompactionOf(userMessage) !== undefined)
    ) {
      return;
    }

    const now = yield* DateTime.now;
    // Providers run in a working directory; a card must not read a checkout or its memory.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-card-" });
    const generated = yield* textGeneration.generateTranscriptionPostProcessing({
      cwd,
      prompt: buildThreadCardPrompt({
        reply: reply.text,
        // A wake is not the user speaking, so it cannot answer an open question.
        userMessage: userMessage?.notification === undefined ? (userMessage?.text ?? null) : null,
        previous: thread.card ?? null,
        now: DateTime.formatIsoOffset(
          DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() }),
        ),
      }),
      modelSelection: settings.threadReplySummaryModelSelection,
    });
    const card = parseThreadCard(generated.transcription, DateTime.toEpochMillis(now));
    if (card === null) return;

    yield* threads.dispatch({
      type: "thread.card.record",
      commandId: CommandId.make(`command:thread-card:${input.runId}`),
      threadId: input.threadId,
      runId: input.runId,
      messageId: reply.id,
      repliedAt: DateTime.formatIso(reply.updatedAt),
      ...card,
    });
  }, Effect.scoped);

  const execute: ThreadCardService["Service"]["execute"] = Effect.fn("ThreadCardService.execute")(
    function (input) {
      return generate(input).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logWarning("Thread card generation failed", { ...input, cause }),
        ),
      );
    },
  );

  return ThreadCardService.of({ execute });
});

export const layer = Layer.effect(ThreadCardService, make);
