import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  type ThreadEntry,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadEntryId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { threadCardGenerationEffect } from "./ThreadCard.ts";
import * as ThreadCardService from "./ThreadCardService.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadRegroupService from "./ThreadRegroupService.ts";
import { userFacingDispatchErrorMessage } from "./UserFacingErrors.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:thread-regroup");
const threadId = ThreadId.make("thread:regroup");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in thread regroup tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const runId = (n: number) => RunId.make(`run:regroup:${n}`);
const unreachable = new TextGenerationError({
  operation: "generateTranscriptionPostProcessing",
  detail: "The summary model is unreachable.",
});
const TWO_TOPICS = [
  "Rate limiter | Added and deployed | done | 1 2 3 4 5 6",
  "Search index | Rebuilt nightly | open | 7 8 9 10 11 12",
].join("\n");
const CARD = [
  "line: Raised the limit to 20 a minute",
  "topics: rate limiter",
  "entry: e1 | Raised to 20",
].join("\n");

type Reply = (
  call: number,
) => Effect.Effect<{ readonly transcription: string }, TextGenerationError>;

function makeHarness(options: { readonly enabled?: boolean } = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-regroup" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({
    threadReplySummariesEnabled: options.enabled ?? true,
  });
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const replies: { regroup: Reply } = {
    regroup: () => Effect.succeed({ transcription: TWO_TOPICS }),
  };
  const regroupPrompts: Array<string> = [];
  const generate = vi.fn<
    TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
  >((input) => {
    if (!input.prompt.startsWith("Group the runs")) return Effect.succeed({ transcription: CARD });
    regroupPrompts.push(input.prompt);
    return replies.regroup(regroupPrompts.length);
  });
  const layerDependencies = Layer.mergeAll(
    layerThreadManagement,
    ThreadEntryStore.layer.pipe(Layer.provide(layerDatabase)),
    Layer.mock(TextGeneration.TextGeneration)({ generateTranscriptionPostProcessing: generate }),
    layerServerSettings,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-regroup-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    NodeServices.layer,
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerThreadManagement,
      ThreadRegroupService.layer.pipe(Layer.provide(layerDependencies)),
      ThreadCardService.layer.pipe(Layer.provide(layerDependencies)),
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      ThreadEntryStore.layer.pipe(Layer.provide(layerDatabase)),
      layerDatabase,
    ),
    replies,
    regroupPrompts,
  };
}

const createThread = Effect.fn("test.createThread")(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make("command:regroup:create"),
    threadId,
    projectId,
    title: "Rate limiter and search",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
});

/** A completed run with its message and reply, as a provider turn leaves it. */
const recordRun = Effect.fn("test.recordRun")(function* (n: number) {
  const eventSink = yield* EventSink.EventSinkV2;
  yield* TestClock.adjust("1 minute");
  const now = yield* DateTime.now;
  const id = runId(n);
  const message = (role: "user" | "assistant", text: string) => ({
    id: EventId.make(`${id}:${role}`),
    type: "message.updated" as const,
    threadId,
    runId: id,
    occurredAt: now,
    payload: {
      id: MessageId.make(`${id}:${role}`),
      threadId,
      runId: id,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming: false,
      createdBy: role === "user" ? ("user" as const) : ("agent" as const),
      creationSource: "web" as const,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`${id}:created`),
        type: "run.created",
        threadId,
        runId: id,
        occurredAt: now,
        payload: {
          id,
          threadId,
          ordinal: n,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`${id}:user`),
          rootNodeId: null,
          activeAttemptId: null,
          status: "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      message("user", `Step ${n} of the rate limiter and search work`),
      message("assistant", `Finished step ${n}.`),
    ],
  });
  return { id, now };
});

/** Files runs from…count as the card call would, under one entry; runs after `owner` are reports. */
const fileRuns = Effect.fn("test.fileRuns")(function* (count: number, owner = count, from = 1) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  for (let n = from; n <= count; n++) {
    const { id, now } = yield* recordRun(n);
    yield* threads.dispatch({
      type: "thread.card.record",
      commandId: CommandId.make(`command:regroup:card:${n}`),
      threadId,
      runId: id,
      messageId: MessageId.make(`${id}:assistant`),
      repliedAt: DateTime.formatIso(now),
      line: `Finished step ${n}`,
      topics: ["rate limiter"],
      open: [],
      run: {
        ordinal: n,
        userMessageId: MessageId.make(`${id}:user`),
        startedAt: DateTime.formatIso(now),
        startedBy: n <= owner ? "owner" : "report",
        ownerText: n <= owner ? `Step ${n}` : null,
        goAhead: false,
        ownerSpokeMidRun: false,
      },
      filing: n === 1 ? [{ ref: "new", title: "Rate limiter", outcome: "Started" }] : [],
    });
  }
});

const regroupEffects = Effect.fn("test.regroupEffects")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly id: string; readonly payload: string; readonly status: string }>`
    SELECT effect_id AS id, payload_json AS payload, status
    FROM orchestration_v2_effect_outbox
    WHERE effect_type = 'thread-contents.regroup'
    ORDER BY rowid
  `;
});

const readContents = ThreadEntryStore.ThreadEntryStore.use((store) =>
  store.getThreadContents(threadId),
);

const requestRegroup = (name: string) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.dispatch({
      type: "thread.contents.regroup.request",
      commandId: CommandId.make(`command:regroup:request:${name}`),
      threadId,
      kind: "idle",
    }),
  );

const execute = (kind: "mark" | "idle" | "manual") =>
  ThreadRegroupService.ThreadRegroupService.use((regroups) =>
    regroups.execute({ threadId, kind, effectId: `effect:test:${kind}` }),
  );

describe("ThreadRegroupService", () => {
  it.effect(
    "a thread's tenth message and an idle request each enqueue one regroup; a failing model leaves the entries and the next card files",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          yield* createThread();
          yield* fileRuns(9);
          assert.lengthOf(yield* regroupEffects(), 0);
          yield* fileRuns(12, 12, 10);
          const [mark] = yield* regroupEffects();
          assert.strictEqual(mark?.id, `effect:thread-contents.regroup:${threadId}:${runId(10)}`);
          assert.include(mark?.payload, '"kind":"mark"');

          yield* requestRegroup("first");
          yield* requestRegroup("again");
          assert.lengthOf(yield* regroupEffects(), 2);
          const filed = yield* readContents;
          assert.deepEqual(
            [filed.state?.lastRunOrdinal, filed.state?.regroupRequestedThrough],
            [12, 12],
          );
          assert.lengthOf(filed.entries, 1);

          const next = yield* recordRun(13);
          yield* outbox.enqueue([
            threadCardGenerationEffect({
              commandId: CommandId.make("command:regroup:run-13"),
              threadId,
              runId: next.id,
            }),
          ]);
          harness.replies.regroup = () => Effect.fail(unreachable);
          const ran: Array<string> = [];
          for (;;) {
            const claimed = yield* outbox.claimNext({ workerId: "test" });
            if (Option.isNone(claimed)) break;
            const effect = claimed.value;
            const request = effect.request;
            ran.push(request.type);
            if (request.type === "thread-contents.regroup") {
              yield* ThreadRegroupService.ThreadRegroupService.use((regroups) =>
                regroups.execute({ threadId, kind: request.kind, effectId: effect.id }),
              );
              assert.deepEqual((yield* readContents).entries, filed.entries);
            } else if (request.type === "thread-card.generate") {
              yield* ThreadCardService.ThreadCardService.use((cards) =>
                cards.execute({ threadId, runId: next.id }),
              );
            }
            yield* outbox.succeed({ effectId: effect.id, workerId: "test" });
          }

          // The regroups ran first and gave up after one call each; the card behind them filed.
          assert.deepEqual(ran, [
            "thread-contents.regroup",
            "thread-contents.regroup",
            "thread-card.generate",
          ]);
          assert.lengthOf(harness.regroupPrompts, 2);
          assert.deepEqual(
            (yield* regroupEffects()).map((effect) => effect.status),
            ["succeeded", "succeeded"],
          );
          const after = yield* readContents;
          assert.isTrue(after.entries[0]!.runs.some((link) => link.runId === next.id));
          assert.deepEqual([after.state?.regroupedAt, after.state?.lastRunOrdinal], [null, 13]);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "an idle regroup of a settled thread combines three samples, keeps the first entry's id and leaves the thread settled",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          yield* createThread();
          yield* fileRuns(12);
          yield* threads.dispatch({
            type: "thread.settle",
            commandId: CommandId.make("command:regroup:settle"),
            threadId,
          });
          const before = (yield* threads.getThreadRecords(threadId, [])).thread;
          yield* execute("idle");
          const after = (yield* threads.getThreadRecords(threadId, [])).thread;
          assert.isNotNull(after.settledAt);
          assert.deepEqual(after.updatedAt, before.updatedAt);
          assert.lengthOf(harness.regroupPrompts, 3);
          assert.include(harness.regroupPrompts[0], "r12 | Step 12 | Finished step 12\n</outline>");
          const contents = yield* readContents;
          assert.deepEqual(
            contents.entries.map((entry) => [entry.id, entry.title, entry.runs.length]),
            [
              [ThreadEntryId.make(`${threadId}:e1`), "Rate limiter", 6],
              [ThreadEntryId.make(`${threadId}:e2`), "Search index", 6],
            ],
          );
          assert.deepEqual(
            [contents.state?.regroupedThrough, contents.state?.runsSinceRegroup],
            [12, 0],
          );

          // By hand, an archived thread can still be regrouped.
          yield* threads.dispatch({
            type: "thread.archive",
            commandId: CommandId.make("command:regroup:archive"),
            threadId,
          });
          yield* threads.dispatch({
            type: "thread.contents.regroup.request",
            commandId: CommandId.make("command:regroup:manual"),
            threadId,
            kind: "manual",
          });
          // The tenth message's mark, then this request.
          const [, manual] = yield* regroupEffects();
          assert.strictEqual(
            manual?.id,
            `effect:thread-contents.regroup:${threadId}:command:regroup:manual`,
          );
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect(
    "hand edits apply, undo while nothing changed, refuse undo after a filing, and survive a regroup",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const regroupAs = (effectId: string) =>
            ThreadRegroupService.ThreadRegroupService.use((regroups) =>
              regroups.execute({ threadId, kind: "idle", effectId }),
            );
          const e = (seq: number) => ThreadEntryId.make(`${threadId}:e${seq}`);
          const shape = (entries: ReadonlyArray<ThreadEntry>) =>
            entries.map((entry) => [
              entry.id,
              entry.status,
              entry.title,
              entry.runs
                .map(
                  (link) =>
                    `${link.runId.slice(link.runId.lastIndexOf(":") + 1)}${link.source === "owner" ? "o" : ""}`,
                )
                .join(" "),
            ]);
          let step = 0;
          const edit = (
            command:
              | {
                  readonly type: "thread.entry.rename";
                  readonly entryId: ThreadEntryId;
                  readonly title: string;
                }
              | {
                  readonly type: "thread.entry.merge";
                  readonly sourceEntryId: ThreadEntryId;
                  readonly targetEntryId: ThreadEntryId;
                }
              | {
                  readonly type: "thread.entry.move-run";
                  readonly runId: RunId;
                  readonly target: { readonly entryId: ThreadEntryId };
                }
              | {
                  readonly type: "thread.entries.restore";
                  readonly entries: ReadonlyArray<ThreadEntry>;
                  readonly expectRevision: number;
                },
          ) =>
            threads.dispatch({
              ...command,
              commandId: CommandId.make(`command:regroup:edit:${++step}`),
              threadId,
            });
          /** Undo as a client sends it: the entries it held before, of those that changed. */
          const undoTo = Effect.fn("test.undoTo")(function* (
            before: ReadonlyArray<ThreadEntry>,
            editRevision: number,
          ) {
            const now = yield* readContents;
            return yield* edit({
              type: "thread.entries.restore",
              entries: before.filter(
                (old) =>
                  JSON.stringify(now.entries.find((entry) => entry.id === old.id)) !==
                  JSON.stringify(old),
              ),
              expectRevision: editRevision,
            });
          });

          yield* createThread();
          yield* fileRuns(12);
          yield* regroupAs("effect:test:split");
          const updatedAt = () =>
            threads
              .getThreadRecords(threadId, [])
              .pipe(Effect.map(({ thread }) => thread.updatedAt));
          const beforeEdits = yield* updatedAt();

          yield* edit({ type: "thread.entry.rename", entryId: e(2), title: "Search" });
          const renamed = yield* readContents;
          const beforeMove = renamed.entries;
          yield* edit({
            type: "thread.entry.move-run",
            runId: runId(6),
            target: { entryId: e(2) },
          });
          const moved = yield* readContents;
          assert.strictEqual(moved.state?.revision, renamed.state!.revision + 1);
          assert.deepEqual(shape(moved.entries), [
            [e(1), "active", "Rate limiter", "1 2 3 4 5"],
            [e(2), "active", "Search", "6o 7 8 9 10 11 12"],
          ]);
          yield* undoTo(beforeMove, moved.state!.revision);
          assert.deepEqual((yield* readContents).entries, beforeMove);
          assert.deepEqual(yield* updatedAt(), beforeEdits);

          yield* edit({
            type: "thread.entry.move-run",
            runId: runId(6),
            target: { entryId: e(2) },
          });
          const movedAgain = yield* readContents;
          // A card filed in between moves the revision on, so the move can no longer be undone.
          yield* fileRuns(13, 13, 13);
          const filed = yield* readContents;
          const refusal = yield* undoTo(beforeMove, movedAgain.state!.revision).pipe(Effect.flip);
          assert.strictEqual(
            userFacingDispatchErrorMessage(refusal),
            "These topics changed since, so this can no longer be undone.",
          );
          assert.deepEqual(yield* readContents, filed);
          assert.notDeepEqual(filed.state, movedAgain.state);

          // The model puts run 6 back with the rate limiter; the owner's move and title stand.
          yield* regroupAs("effect:test:after-edits");
          assert.deepEqual(shape((yield* readContents).entries), [
            [e(1), "active", "Rate limiter", "1 2 3 4 5"],
            [e(2), "active", "Search", "6o 7 8 9 10 11 12 13"],
          ]);

          const beforeMerge = (yield* readContents).entries;
          const beforeMergeAt = yield* updatedAt();
          yield* edit({ type: "thread.entry.merge", sourceEntryId: e(1), targetEntryId: e(2) });
          assert.deepEqual(shape((yield* readContents).entries), [
            [e(1), "retired", "Rate limiter", ""],
            [e(2), "active", "Search", "1o 2o 3o 4o 5o 6o 7o 8o 9o 10o 11o 12o 13o"],
          ]);
          yield* undoTo(beforeMerge, (yield* readContents).state!.revision);
          assert.deepEqual((yield* readContents).entries, beforeMerge);
          assert.deepEqual(yield* updatedAt(), beforeMergeAt);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect.each([
    { name: "two samples are combined when the second fails", fail: [2], calls: 3, split: true },
    { name: "a failing first call stops the regroup", fail: [1, 2, 3], calls: 1, split: false },
    { name: "a thread of nine owner messages is not regrouped", owner: 9, calls: 0, split: false },
    { name: "nothing is regrouped with summaries off", enabled: false, calls: 0, split: false },
  ])("$name", ({ fail = [], owner, enabled, calls, split }) =>
    Effect.gen(function* () {
      const harness = makeHarness(enabled === undefined ? {} : { enabled });
      harness.replies.regroup = (call) =>
        fail.includes(call)
          ? Effect.fail(unreachable)
          : Effect.succeed({ transcription: TWO_TOPICS });
      yield* Effect.gen(function* () {
        yield* createThread();
        yield* fileRuns(12, owner);
        yield* execute("idle");
        assert.lengthOf(harness.regroupPrompts, calls);
        assert.lengthOf((yield* readContents).entries, split ? 2 : 1);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
