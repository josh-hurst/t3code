import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThreadLineage,
  type OrchestrationV2ServerCommand,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
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
import * as ThreadCardService from "./ThreadCardService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:thread-card");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in thread card tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const CARD = [
  "line: Fixed flaky login test; 2 retries removed",
  "topics: login test",
  "ask: Merge PR 412 now?",
  "verify: Check the redirect on a phone",
].join("\n");

function makeHarness(options: { readonly enabled?: boolean } = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "thread-card" },
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
  const generate = vi.fn<
    TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
  >(() => Effect.succeed({ transcription: CARD }));
  const layerCards = ThreadCardService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        Layer.mock(TextGeneration.TextGeneration)({
          generateTranscriptionPostProcessing: generate,
        }),
        layerServerSettings,
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-thread-card-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        NodeServices.layer,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerThreadManagement,
      layerCards,
      EffectOutbox.layer.pipe(Layer.provide(layerDatabase)),
      layerDatabase,
    ),
    generate,
  };
}

const createThread = Effect.fn("test.createThread")(function* (
  name: string,
  lineage?: OrchestrationV2AppThreadLineage,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(`thread:card:${name}`);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`command:card:${name}:create`),
    threadId,
    projectId,
    title: "Seed title",
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  if (lineage !== undefined) {
    const eventSink = yield* EventSink.EventSinkV2;
    const thread = (yield* threads.getThreadRecords(threadId, [])).thread;
    yield* eventSink.write({
      events: [
        {
          id: EventId.make(`event:card:${name}:lineage`),
          type: "thread.metadata-updated",
          threadId,
          occurredAt: yield* DateTime.now,
          payload: { ...thread, lineage },
        },
      ],
    });
  }
  return threadId;
});

/** Records a settled run with one exchange, as a provider turn would. */
const recordRun = Effect.fn("test.recordRun")(function* (input: {
  readonly threadId: ThreadId;
  readonly run: string;
  readonly ordinal?: number;
  readonly assistant?: string;
  readonly streaming?: boolean;
  readonly status?: "completed" | "interrupted";
}) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(input.run);
  const providerThreadId = ProviderThreadId.make(`${input.threadId}:provider`);
  const message = (
    role: "user" | "assistant",
    text: string,
    streaming = false,
    name: string = role,
  ) => ({
    id: EventId.make(`${runId}:${name}`),
    type: "message.updated" as const,
    threadId: input.threadId,
    runId,
    occurredAt: now,
    payload: {
      id: MessageId.make(`${runId}:${name}`),
      threadId: input.threadId,
      runId,
      nodeId: null,
      role,
      text,
      attachments: [],
      streaming,
      createdBy: role === "user" ? ("user" as const) : ("agent" as const),
      creationSource: "web" as const,
      createdAt: now,
      updatedAt: now,
    },
  });
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`${runId}:created`),
        type: "run.created",
        threadId: input.threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId: input.threadId,
          ordinal: input.ordinal ?? 1,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make(`${runId}:user`),
          rootNodeId: null,
          activeAttemptId: null,
          status: input.status ?? "completed",
          requestedAt: now,
          startedAt: now,
          completedAt: now,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      {
        id: EventId.make(`${runId}:provider-thread`),
        type: "provider-thread.updated",
        threadId: input.threadId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver: adapter.driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: null,
          appThreadId: input.threadId,
          ownerNodeId: null,
          nativeThreadRef: { driver: adapter.driver, nativeId: "native", strength: "strong" },
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: input.ordinal ?? 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      },
      message("user", "Fix the flaky login test"),
      // Sorts before the final reply, as an earlier message of a multi-message turn does.
      message("assistant", "Looking at the test first.", false, "a-first"),
      message("assistant", input.assistant ?? "Fixed it. Merge PR 412 now?", input.streaming),
    ],
  });
  return runId;
});

const sendMessage = Effect.fn("test.sendMessage")(function* (input: {
  readonly threadId: ThreadId;
  readonly name: string;
  readonly wake?: boolean;
}) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  yield* threads.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`command:card:${input.name}`),
    threadId: input.threadId,
    messageId: MessageId.make(`message:card:${input.name}`),
    text: input.wake ? "A background task finished." : "Yes, merge it.",
    attachments: [],
    modelSelection,
    dispatchMode: { type: input.wake ? "queue_after_active" : "defer_start" },
    ...(input.wake
      ? {
          createdBy: "agent" as const,
          creationSource: "server" as const,
          notification: {
            source: { kind: "delegated_task" as const, taskIds: [] },
            outcome: "completed" as const,
            summary: "Task finished",
          },
        }
      : { createdBy: "user" as const, creationSource: "web" as const }),
  });
});

const readThread = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.getThreadRecords(threadId, []).pipe(Effect.map((records) => records.thread)),
  );

const execute = (threadId: ThreadId, runId: RunId) =>
  ThreadCardService.ThreadCardService.use((cards) => cards.execute({ threadId, runId }));

const openKinds = (thread: {
  readonly card?: { readonly open: ReadonlyArray<{ readonly kind: string }> } | null | undefined;
}) => thread.card?.open.map((item) => item.kind);

describe("ThreadCardService", () => {
  it.effect("records the run's last reply as a card without counting as activity", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const sql = yield* SqlClient.SqlClient;
        const threadId = yield* createThread("record");
        const runId = yield* recordRun({ threadId, run: "run:card:record" });
        const updatedAtColumn = sql<{ readonly updated_at: string }>`
          SELECT updated_at FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}`;
        const before = yield* readThread(threadId);
        const columnBefore = yield* updatedAtColumn;
        yield* TestClock.adjust("1 hour");

        yield* execute(threadId, runId);
        yield* execute(threadId, runId);

        assert.equal(
          harness.generate.mock.calls.length,
          1,
          "a replayed effect must not regenerate",
        );
        const prompt = harness.generate.mock.calls[0]?.[0].prompt ?? "";
        assert.include(prompt, "<reply>\nFixed it. Merge PR 412 now?\n</reply>");
        assert.include(prompt, "<user_message>\nFix the flaky login test\n</user_message>");
        const after = yield* readThread(threadId);
        assert.deepEqual(after.card, {
          line: "Fixed flaky login test; 2 retries removed",
          topics: ["login test"],
          open: [
            { kind: "ask", text: "Merge PR 412 now?" },
            { kind: "verify", text: "Check the redirect on a phone" },
          ],
          messageId: MessageId.make("run:card:record:assistant"),
          at: "1970-01-01T01:00:00.000Z",
          runId,
          chapters: [
            {
              line: "Fixed flaky login test; 2 retries removed",
              messageId: MessageId.make("run:card:record:assistant"),
            },
          ],
        });
        assert.deepEqual(after.updatedAt, before.updatedAt);
        assert.deepEqual(yield* updatedAtColumn, columnBefore);
        const { chapters: _chapters, runId: _runId, ...summary } = after.card!;
        assert.deepEqual((yield* threads.getThreadShell(threadId))?.card, summary);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("generates nothing for a run or thread that has no card to give", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly enabled?: boolean;
        readonly lineage?: (parent: ThreadId) => OrchestrationV2AppThreadLineage;
        readonly run?: Partial<Parameters<typeof recordRun>[0]>;
      }> = [
        { name: "setting-off", enabled: false },
        {
          name: "subagent",
          lineage: (parent) => ({
            parentThreadId: parent,
            relationshipToParent: "subagent",
            rootThreadId: parent,
          }),
        },
        {
          name: "side-chat",
          lineage: (parent) => ({
            parentThreadId: parent,
            relationshipToParent: "fork",
            rootThreadId: parent,
            sideChat: true,
          }),
        },
        { name: "streaming", run: { streaming: true } },
        { name: "empty", run: { assistant: "  " } },
        { name: "stopped", run: { status: "interrupted" } },
      ];
      for (const testCase of cases) {
        const harness = makeHarness({ enabled: testCase.enabled ?? true });
        yield* Effect.gen(function* () {
          const parent = yield* createThread(`${testCase.name}:parent`);
          const threadId = yield* createThread(testCase.name, testCase.lineage?.(parent));
          const runId = yield* recordRun({
            threadId,
            run: `run:card:${testCase.name}`,
            ...testCase.run,
          });
          yield* execute(threadId, runId);
          assert.equal(harness.generate.mock.calls.length, 0, testCase.name);
          assert.isUndefined((yield* readThread(threadId)).card, testCase.name);
        }).pipe(Effect.provide(harness.layer));
      }
    }),
  );

  it.effect("succeeds and keeps the previous card when generation fails", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threadId = yield* createThread("failure");
        const first = yield* recordRun({ threadId, run: "run:card:failure:1" });
        yield* execute(threadId, first);
        const second = yield* recordRun({ threadId, run: "run:card:failure:2", ordinal: 2 });
        harness.generate.mockReturnValueOnce(
          Effect.fail(
            new TextGenerationError({
              operation: "generateTranscriptionPostProcessing",
              detail: "model unavailable",
            }),
          ),
        );
        yield* execute(threadId, second);
        assert.equal((yield* readThread(threadId)).card?.runId, first);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("only the user writing back clears a question; a wake leaves it open", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threadId = yield* createThread("asks");
        const first = yield* recordRun({ threadId, run: "run:card:asks:1" });
        yield* execute(threadId, first);
        yield* TestClock.adjust("1 minute");

        yield* sendMessage({ threadId, name: "asks:wake", wake: true });
        assert.deepEqual(openKinds(yield* readThread(threadId)), ["ask", "verify"]);

        // A card written after a wake started a newer run still carries its question.
        const second = yield* recordRun({ threadId, run: "run:card:asks:2", ordinal: 5 });
        yield* TestClock.adjust("1 minute");
        yield* sendMessage({ threadId, name: "asks:wake-2", wake: true });
        yield* execute(threadId, second);
        assert.deepEqual(openKinds(yield* readThread(threadId)), ["ask", "verify"]);

        yield* sendMessage({ threadId, name: "asks:answer" });
        assert.deepEqual(openKinds(yield* readThread(threadId)), ["verify"]);

        // The user answered before the model finished: the late card must not ask again.
        const third = yield* recordRun({ threadId, run: "run:card:asks:3", ordinal: 9 });
        yield* TestClock.adjust("1 minute");
        yield* sendMessage({ threadId, name: "asks:answer-2" });
        yield* execute(threadId, third);
        const thread = yield* readThread(threadId);
        assert.equal(thread.card?.runId, third);
        assert.deepEqual(openKinds(thread), ["verify"]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a card that names a new subject starts a retitle that is not activity either", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly secondTopics: string;
        /** Sent after the first card and before the run under test gets its own. */
        readonly before?: (threadId: ThreadId) => OrchestrationV2ServerCommand;
        readonly retitles: boolean;
      }> = [
        { name: "same-topics", secondTopics: "Login Test", retitles: false },
        { name: "gained-topic", secondTopics: "login test, billing", retitles: true },
        {
          name: "named-by-hand",
          secondTopics: "login test, billing",
          before: (threadId) => ({
            type: "thread.metadata.update",
            commandId: CommandId.make("command:card:named-by-hand:rename"),
            threadId,
            title: "My own title",
          }),
          retitles: false,
        },
      ];
      for (const testCase of cases) {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const outbox = yield* EffectOutbox.EffectOutboxV2;
          const threadId = yield* createThread(testCase.name);
          const first = yield* recordRun({ threadId, run: `run:card:${testCase.name}:1` });
          yield* execute(threadId, first);
          assert.isNotOk((yield* readThread(threadId)).titleRegeneration, "a first card alone");
          const runId = yield* recordRun({
            threadId,
            run: `run:card:${testCase.name}:2`,
            ordinal: 2,
          });
          harness.generate.mockReturnValueOnce(
            Effect.succeed({ transcription: `line: Done\ntopics: ${testCase.secondTopics}` }),
          );
          if (testCase.before !== undefined) yield* threads.dispatch(testCase.before(threadId));
          const before = yield* readThread(threadId);
          yield* TestClock.adjust("1 hour");

          yield* execute(threadId, runId);

          const requestId = CommandId.make(`command:thread-card:${runId}`);
          const armed = yield* readThread(threadId);
          assert.equal(armed.card?.runId, runId, testCase.name);
          assert.equal(armed.titleRegeneration?.requestId === requestId, testCase.retitles);
          assert.deepEqual(
            (yield* outbox.listByCommandId(requestId)).map((effect) => effect.request),
            testCase.retitles
              ? [{ type: "thread-title.generate", kind: { type: "regenerate" } }]
              : [],
            testCase.name,
          );
          if (!testCase.retitles) return;
          yield* threads.dispatch({
            type: "thread.title.regeneration.complete",
            commandId: CommandId.make(`command:card:${testCase.name}:title`),
            threadId,
            requestId,
            title: "Login test and billing",
            outcome: { status: "renamed" },
          });
          const retitled = yield* readThread(threadId);
          assert.equal(retitled.title, "Login test and billing");
          assert.deepEqual(retitled.updatedAt, before.updatedAt);
        }).pipe(Effect.provide(harness.layer));
      }
    }),
  );
});
