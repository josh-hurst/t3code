import {
  CommandId,
  idleCompactionOf,
  isListedThreadLineage,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
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
import {
  buildThreadCardPrompt,
  parseThreadCard,
  type ThreadRunStarter,
} from "../textGeneration/ThreadCard.ts";
import { isNativeMaintenanceCommand } from "./CommandPolicy.ts";
import {
  contentsForPrompt,
  fileRun,
  isGoAhead,
  isOwnerMessage,
  runOwnerText,
  runStarter,
} from "./ThreadEntries.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import { followUpPromptQuestion } from "./ThreadFollowUp.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const MID_RUN_MESSAGES_MAX = 3;

/** The run's final reply, once it has finished streaming text. */
export function runReply(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  runId: RunId,
): OrchestrationV2ConversationMessage | undefined {
  const reply = messages
    .filter((message) => message.role === "assistant" && message.runId === runId)
    .at(-1);
  return reply === undefined || reply.streaming || reply.text.trim() === "" ? undefined : reply;
}

/**
 * Who started a run and the owner's words in it, as its run line keeps them; null for a run that
 * gets no card or line (a maintenance command or an idle compaction). `messages` must hold the
 * run's own messages.
 */
export function describeRun(input: {
  readonly run: Pick<OrchestrationV2Run, "id" | "userMessageId">;
  readonly userMessage: OrchestrationV2ConversationMessage | undefined;
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
}): {
  readonly startedBy: ThreadRunStarter;
  readonly midRun: ReadonlyArray<string>;
  readonly ownerText: string | null;
} | null {
  const { run, userMessage } = input;
  if (
    userMessage !== undefined &&
    (isNativeMaintenanceCommand(userMessage) || idleCompactionOf(userMessage) !== undefined)
  ) {
    return null;
  }
  const startedBy = runStarter(userMessage);
  const recheck = userMessage?.followUp === true ? followUpPromptQuestion(userMessage.text) : null;
  const startText = recheck === null ? (userMessage?.text ?? null) : `Re-check: ${recheck}`;
  // A steered message is stored under the run it steered.
  const midRun = input.messages
    .filter(
      (message) =>
        message.role === "user" &&
        message.runId === run.id &&
        message.id !== run.userMessageId &&
        isOwnerMessage(message) &&
        message.text.trim() !== "",
    )
    .slice(0, MID_RUN_MESSAGES_MAX)
    .map((message) => message.text);
  return { startedBy, midRun, ownerText: runOwnerText({ startedBy, startText, midRun }) };
}

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
  const entryStore = yield* ThreadEntryStore.ThreadEntryStore;
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
    const reply = runReply(records.messages, input.runId);
    if (reply === undefined) return;

    const userMessage =
      records.messages.find((message) => message.id === run.userMessageId) ??
      (yield* threads.getThreadRecords(input.threadId, ["messages"], {
        messageIds: [run.userMessageId],
      })).messages[0];
    const described = describeRun({ run, userMessage, messages: records.messages });
    if (described === null) return;
    const { startedBy, midRun } = described;
    // A broken contents row must not cost the card: the run is then carded without its filing.
    const stored = yield* entryStore.getThreadContents(input.threadId).pipe(
      Effect.catchTags({
        ThreadEntryStoreError: (cause) =>
          Effect.logWarning("Thread contents could not be read", { ...input, cause }).pipe(
            Effect.as(null),
          ),
      }),
    );
    const shown = contentsForPrompt(
      stored ?? { entries: [], state: null, previousRunEntryIds: [] },
    );

    const now = yield* DateTime.now;
    // Providers run in a working directory; a card must not read a checkout or its memory.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-card-" });
    const generated = yield* textGeneration.generateTranscriptionPostProcessing({
      cwd,
      prompt: buildThreadCardPrompt({
        reply: reply.text,
        // A wake or a re-check is not the user speaking, so it cannot answer an open question.
        userMessage:
          userMessage?.notification === undefined && userMessage?.followUp !== true
            ? (userMessage?.text ?? null)
            : null,
        previous: thread.card ?? null,
        contents: shown.contents,
        midRun,
        startedBy,
        now: DateTime.formatIsoOffset(
          DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() }),
        ),
      }),
      modelSelection: settings.threadReplySummaryModelSelection,
    });
    const card = parseThreadCard(generated.transcription, DateTime.toEpochMillis(now));
    if (card === null) return;

    const repliedAt = DateTime.formatIso(reply.updatedAt);
    const dropShip =
      card.open.some((item) => item.kind === "ship") &&
      (yield* entryStore
        .hasPublishCoveringRun({
          projectId: thread.projectId,
          threadId: input.threadId,
          runRequestedAt: DateTime.formatIso(run.requestedAt),
          repliedAt,
        })
        .pipe(
          Effect.catchTags({
            ThreadEntryStoreError: (cause) =>
              Effect.logWarning("Publish markers could not be read for thread card", {
                ...input,
                cause,
              }).pipe(Effect.as(false)),
          }),
        ));
    const open = dropShip ? card.open.filter((item) => item.kind !== "ship") : card.open;

    yield* threads.dispatch({
      type: "thread.card.record",
      commandId: CommandId.make(`command:thread-card:${input.runId}`),
      threadId: input.threadId,
      runId: input.runId,
      messageId: reply.id,
      repliedAt,
      line: card.line,
      topics: card.topics,
      open,
      ...(stored === null
        ? {}
        : {
            run: {
              ordinal: run.ordinal,
              userMessageId: run.userMessageId,
              startedAt: DateTime.formatIso(run.startedAt ?? run.requestedAt),
              startedBy,
              ownerText: described.ownerText,
              goAhead:
                startedBy === "owner" && midRun.length === 0 && isGoAhead(userMessage?.text ?? ""),
              ownerSpokeMidRun: midRun.length > 0,
            },
            filing: fileRun({ parsed: card.entries, refToId: shown.refToId }),
          }),
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
