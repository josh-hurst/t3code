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
  threadCardOpenItemKey,
  ThreadEntryId,
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
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
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
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const layerRecordingDispatch = Layer.effect(
    ThreadManagement.ThreadManagementService,
    Effect.gen(function* () {
      const threads = yield* ThreadManagement.ThreadManagementService;
      return ThreadManagement.ThreadManagementService.of({
        ...threads,
        dispatch: (command) => {
          dispatched.push(command);
          return threads.dispatch(command);
        },
      });
    }),
  ).pipe(Layer.provide(layerThreadManagement));
  const generate = vi.fn<
    TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
  >(() => Effect.succeed({ transcription: CARD }));
  const layerCards = ThreadCardService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerRecordingDispatch,
        ThreadEntryStore.layer.pipe(Layer.provide(layerDatabase)),
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
      ThreadEntryStore.layer.pipe(Layer.provide(layerDatabase)),
      layerDatabase,
    ),
    generate,
    dispatched,
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
  readonly userText?: string;
  readonly report?: boolean;
  readonly midRun?: string;
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
      ...(role === "user" && name === "user" && input.report
        ? {
            notification: {
              source: { kind: "background_task" as const },
              outcome: "completed" as const,
              summary: "Task finished",
            },
          }
        : {}),
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
      message("user", input.userText ?? "Fix the flaky login test"),
      ...(input.midRun === undefined ? [] : [message("user", input.midRun, false, "mid")]),
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

const readContents = (threadId: ThreadId) =>
  ThreadEntryStore.ThreadEntryStore.use((store) => store.getThreadContents(threadId));

/** The active entries hold exactly the card's open items. */
const assertEntriesMatchCard = Effect.fn("test.assertEntriesMatchCard")(function* (
  threadId: ThreadId,
) {
  const thread = yield* readThread(threadId);
  const held = (yield* readContents(threadId)).entries
    .filter((entry) => entry.status === "active")
    .flatMap((entry) => entry.open.map(({ runId: _runId, ...item }) => item));
  assert.sameDeepMembers(held, [...(thread.card?.open ?? [])]);
});

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
          // The reply's own time, an hour before the card was written.
          askedAt: "1970-01-01T00:00:00.000Z",
          runId,
        });
        assert.deepEqual(after.updatedAt, before.updatedAt);
        assert.deepEqual(yield* updatedAtColumn, columnBefore);
        const { runId: _runId, ...summary } = after.card!;
        assert.deepEqual((yield* threads.getThreadShell(threadId))?.card, summary);

        // The same commit filed the run: a first run with no entry line is titled by its card.
        const contents = yield* readContents(threadId);
        assert.deepEqual(
          contents.entries.map((entry) => [entry.title, entry.outcome, entry.runs, entry.status]),
          [
            [
              "Fixed flaky login test; 2 retries removed",
              "Fixed flaky login test; 2 retries removed",
              [{ runId, source: "online" }],
              "active",
            ],
          ],
        );
        assert.deepEqual(contents.state, {
          revision: 1,
          nextEntrySeq: 2,
          ownerRuns: 1,
          lastRunOrdinal: 1,
          lastReplyAt: "1970-01-01T00:00:00.000Z",
          runsSinceRegroup: 1,
          regroupRequestedThrough: 0,
          regroupedThrough: 0,
          regroupedAt: null,
        });
        assert.deepEqual(
          (yield* ThreadEntryStore.ThreadEntryStore.use((store) => store.runLines(threadId))).map(
            (line) => [line.runId, line.line, line.ownerText, line.startedBy],
          ),
          [
            [
              runId,
              "Fixed flaky login test; 2 retries removed",
              "Fix the flaky login test",
              "owner",
            ],
          ],
        );
        yield* assertEntriesMatchCard(threadId);
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
        yield* assertEntriesMatchCard(threadId);

        // A card written after a wake started a newer run still carries its question.
        const second = yield* recordRun({ threadId, run: "run:card:asks:2", ordinal: 5 });
        yield* TestClock.adjust("1 minute");
        yield* sendMessage({ threadId, name: "asks:wake-2", wake: true });
        yield* execute(threadId, second);
        assert.deepEqual(openKinds(yield* readThread(threadId)), ["ask", "verify"]);

        yield* sendMessage({ threadId, name: "asks:answer" });
        assert.deepEqual(openKinds(yield* readThread(threadId)), ["verify"]);
        yield* assertEntriesMatchCard(threadId);

        // The user answered before the model finished: the late card must not ask again.
        const third = yield* recordRun({ threadId, run: "run:card:asks:3", ordinal: 9 });
        yield* TestClock.adjust("1 minute");
        yield* sendMessage({ threadId, name: "asks:answer-2" });
        yield* execute(threadId, third);
        const thread = yield* readThread(threadId);
        assert.equal(thread.card?.runId, third);
        assert.deepEqual(openKinds(thread), ["verify"]);
        yield* assertEntriesMatchCard(threadId);
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

  it.effect("files the run against the thread's contents and says who started it", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<{
        readonly name: string;
        readonly run: Partial<Parameters<typeof recordRun>[0]>;
        readonly userBlock: string;
        readonly expected: Record<string, unknown>;
      }> = [
        {
          name: "owner-mid-run",
          run: { midRun: "also look at the reset email" },
          userBlock:
            "Fix the flaky login test\n[The user added while the agent was working:] also look at the reset email",
          expected: {
            startedBy: "owner",
            ownerText: "Fix the flaky login test / also: also look at the reset email",
            goAhead: false,
            ownerSpokeMidRun: true,
          },
        },
        {
          name: "go-ahead",
          run: { userText: "yes do that" },
          userBlock: "yes do that",
          expected: {
            startedBy: "owner",
            ownerText: "yes do that",
            goAhead: true,
            ownerSpokeMidRun: false,
          },
        },
        {
          name: "report",
          run: { report: true },
          userBlock:
            "[No new message from the user started this run. A background task or subagent reported back.]",
          expected: {
            startedBy: "report",
            ownerText: null,
            goAhead: false,
            ownerSpokeMidRun: false,
          },
        },
      ];
      for (const testCase of cases) {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threadId = yield* createThread(`contents:${testCase.name}`);
          const insertEntry = (seq: number, title: string, run: string, startedAt: string) =>
            sql`
              INSERT INTO tide_thread_entries (
                entry_id, thread_id, title, title_source, outcome, open_json, open_count,
                runs_json, start_message_id, end_message_id, started_at, ended_at, status
              ) VALUES (
                ${`${threadId}:e${seq}`}, ${threadId}, ${title}, 'model', ${`${title} so far`},
                ${seq === 5 ? JSON.stringify([{ kind: "commit", text: "Not committed", runId: run }]) : "[]"},
                ${seq === 5 ? 1 : 0},
                ${JSON.stringify([{ runId: run, source: "online" }])}, 'message:a', 'message:b',
                ${startedAt}, ${startedAt}, 'active'
              )`;
          // Stored ids are not what the model sees: e5 is shown as e2.
          yield* insertEntry(1, "Login test", "run:seed:1", "2030-01-01T00:00:00.000Z");
          yield* insertEntry(5, "Reset email", "run:seed:2", "2030-01-02T00:00:00.000Z");
          yield* sql`
            INSERT INTO tide_thread_runs (
              run_id, thread_id, ordinal, user_message_id, reply_message_id, started_by,
              started_at, replied_at
            ) VALUES (
              'run:seed:2', ${threadId}, 2, 'message:a', 'message:b', 'owner',
              '2030-01-02T00:00:00.000Z', '2030-01-02T00:00:00.000Z'
            )`;
          const runId = yield* recordRun({
            threadId,
            run: `run:card:contents:${testCase.name}`,
            ordinal: 3,
            ...testCase.run,
          });
          harness.generate.mockReturnValueOnce(
            Effect.succeed({
              transcription: `${CARD}\nentry: e2 | Queued; not committed | open\nentry: new | Dark mode | Added | done\nentry: e9 | Unknown`,
            }),
          );
          yield* execute(threadId, runId);

          const prompt = harness.generate.mock.calls[0]?.[0].prompt ?? "";
          assert.equal(
            prompt.slice(prompt.indexOf("<contents>"), prompt.indexOf("</contents>") + 11),
            "<contents>\ne1 | Login test | Login test so far | done\ne2 | Reset email | Reset email so far | open\nThe previous run was filed under: e2\n</contents>",
          );
          assert.include(prompt, `<user_message>\n${testCase.userBlock}\n</user_message>`);
          const command = harness.dispatched.find(
            (candidate) => candidate.type === "thread.card.record",
          );
          assert(command?.type === "thread.card.record", testCase.name);
          assert.deepEqual(command.run, {
            ordinal: 3,
            userMessageId: MessageId.make(`${runId}:user`),
            startedAt: "1970-01-01T00:00:00.000Z",
            ...testCase.expected,
          } as typeof command.run);
          assert.deepEqual(command.filing, [
            { ref: `${threadId}:e5`, outcome: "Queued; not committed" },
            { ref: "new", title: "Dark mode", outcome: "Added" },
          ] as typeof command.filing);
          assert.equal((yield* readThread(threadId)).card?.runId, runId, testCase.name);
          const filed = (yield* readContents(threadId)).entries.filter((entry) =>
            entry.runs.some((link) => link.runId === runId),
          );
          assert.sameDeepMembers(
            filed.map((entry) => [entry.title, entry.outcome, entry.runs.at(-1)]),
            testCase.name !== "owner-mid-run"
              ? // A go-ahead keeps only the previous run's entry; a report never starts one.
                [["Reset email", "Queued; not committed", { runId, source: "online" }]]
              : [
                  ["Reset email", "Queued; not committed", { runId, source: "online" }],
                  ["Dark mode", "Added", { runId, source: "online", second: true }],
                ],
            testCase.name,
          );
          yield* assertEntriesMatchCard(threadId);
        }).pipe(Effect.provide(harness.layer));
      }
    }),
  );

  it.effect("resolves and restores open items on the card and its entries alike", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const threadId = yield* createThread("resolve");
        const runId = yield* recordRun({ threadId, run: "run:card:resolve" });
        yield* execute(threadId, runId);
        yield* threads.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("command:card:resolve:settle"),
          threadId,
        });
        const before = yield* readThread(threadId);
        yield* TestClock.adjust("1 hour");
        const resolve = (name: string, fields: { kinds?: ["verify"]; key?: string }) =>
          threads.dispatch({
            type: "thread.open-items.resolve",
            commandId: CommandId.make(`command:card:resolve:${name}`),
            threadId,
            ...fields,
          });

        yield* resolve("verify", { kinds: ["verify"] });
        assert.deepEqual(openKinds(yield* readThread(threadId)), ["ask"]);
        yield* assertEntriesMatchCard(threadId);
        // Resolving what is already gone is not an error.
        yield* resolve("again", { kinds: ["verify"] });
        yield* resolve("ask", {
          key: threadCardOpenItemKey({ kind: "ask", text: "merge PR 412 now" }),
        });
        assert.deepEqual(openKinds(yield* readThread(threadId)), []);
        yield* assertEntriesMatchCard(threadId);

        yield* threads.dispatch({
          type: "thread.open-items.restore",
          commandId: CommandId.make("command:card:resolve:restore"),
          threadId,
          items: [{ kind: "verify", text: "Check the redirect on a phone", runId }],
        });
        const restored = yield* readThread(threadId);
        assert.deepEqual(openKinds(restored), ["verify"]);
        yield* assertEntriesMatchCard(threadId);
        assert.deepEqual(restored.updatedAt, before.updatedAt);
        assert.isNotNull(restored.settledAt);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a rolled-back run leaves the contents and a deleted thread takes them along", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const eventSink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = yield* createThread("rollback");
        const rollBack = Effect.fn("test.rollBack")(function* (runId: RunId) {
          const [run] = (yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }))
            .runs;
          return {
            id: EventId.make(`${runId}:rolled-back`),
            type: "run.updated" as const,
            threadId,
            runId,
            occurredAt: yield* DateTime.now,
            payload: { ...run!, status: "rolled_back" as const },
          };
        });

        const first = yield* recordRun({ threadId, run: "run:card:rollback:1" });
        yield* execute(threadId, first);
        const second = yield* recordRun({ threadId, run: "run:card:rollback:2", ordinal: 2 });
        harness.generate.mockReturnValueOnce(
          Effect.succeed({
            transcription: `${CARD}\nentry: e1 | Still flaky | open\nentry: new | Billing export | Started | open`,
          }),
        );
        yield* execute(threadId, second);
        yield* eventSink.write({ events: [yield* rollBack(second)] });
        const afterRollback = yield* readContents(threadId);
        assert.deepEqual(
          afterRollback.entries.map((entry) => [entry.title, entry.runs.length, entry.status]),
          [
            ["Fixed flaky login test; 2 retries removed", 1, "active"],
            ["Billing export", 0, "retired"],
          ],
        );
        assert.equal(afterRollback.entries[0]!.endMessageId, MessageId.make(`${first}:assistant`));
        assert.deepEqual(
          afterRollback.previousRunEntryIds,
          afterRollback.entries.slice(0, 1).map((entry) => entry.id),
        );
        assert.equal(afterRollback.state?.ownerRuns, 1);
        assert.equal(afterRollback.state?.lastRunOrdinal, 1);
        yield* assertEntriesMatchCard(threadId);

        // Filed and rolled back in one commit: the cleanup reads the filing in the same transaction.
        const third = yield* recordRun({ threadId, run: "run:card:rollback:3", ordinal: 3 });
        const at = DateTime.formatIso(yield* DateTime.now);
        const entryId = ThreadEntryId.make(`${threadId}:e9`);
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${third}:filed`),
              type: "thread.entries-updated",
              threadId,
              occurredAt: yield* DateTime.now,
              payload: {
                entries: [
                  {
                    id: entryId,
                    threadId,
                    title: "Same commit",
                    titleSource: "model",
                    outcome: "Filed",
                    open: [],
                    runs: [{ runId: third, source: "online" }],
                    startMessageId: MessageId.make(`${third}:user`),
                    endMessageId: MessageId.make(`${third}:assistant`),
                    startedAt: at,
                    endedAt: at,
                    status: "active",
                  },
                ],
                runLines: [
                  {
                    runId: third,
                    threadId,
                    ordinal: 3,
                    userMessageId: MessageId.make(`${third}:user`),
                    replyMessageId: MessageId.make(`${third}:assistant`),
                    line: "Filed",
                    ownerText: null,
                    startedBy: "owner",
                    startedAt: at,
                    repliedAt: at,
                  },
                ],
                state: { ...afterRollback.state!, revision: 9, nextEntrySeq: 10 },
              },
            },
            yield* rollBack(third),
          ],
        });
        const sameCommit = yield* readContents(threadId);
        assert.equal(sameCommit.entries.find((entry) => entry.id === entryId)?.status, "retired");
        assert.deepEqual(
          (yield* ThreadEntryStore.ThreadEntryStore.use((store) => store.runLines(threadId))).map(
            (line) => line.runId,
          ),
          [first],
        );

        // A card that lands after its run was rolled back is still a card, but files nothing.
        yield* threads.dispatch({
          type: "thread.card.record",
          commandId: CommandId.make("command:card:rollback:late"),
          threadId,
          runId: second,
          messageId: MessageId.make(`${second}:assistant`),
          repliedAt: at,
          line: "Late card",
          topics: [],
          open: [],
          run: {
            ordinal: 2,
            userMessageId: MessageId.make(`${second}:user`),
            startedAt: at,
            startedBy: "owner",
            ownerText: null,
            goAhead: false,
            ownerSpokeMidRun: false,
          },
          filing: [],
        });
        assert.equal((yield* readThread(threadId)).card?.line, "Late card");
        assert.isFalse(
          (yield* readContents(threadId)).entries.some((entry) =>
            entry.runs.some((link) => link.runId === second),
          ),
        );

        yield* threads.dispatch({
          type: "thread.delete",
          commandId: CommandId.make("command:card:rollback:delete"),
          threadId,
        });
        for (const table of ["tide_thread_entries", "tide_thread_runs", "tide_thread_contents"]) {
          const [row] = yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM ${sql(table)} WHERE thread_id = ${threadId}`;
          assert.equal(row?.count, 0, table);
        }
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a contents row that cannot be read costs the filing, not the card or a rollback", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const eventSink = yield* EventSink.EventSinkV2;
        const sql = yield* SqlClient.SqlClient;
        const threadId = yield* createThread("broken");
        yield* sql`
          INSERT INTO tide_thread_entries (
            entry_id, thread_id, title, title_source, outcome, open_json, open_count, runs_json,
            start_message_id, end_message_id, started_at, ended_at, status
          ) VALUES (
            ${`${threadId}:e1`}, ${threadId}, 'Broken', 'model', '', '[]', 0, 'not json',
            'message:a', 'message:b', '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z', 'active'
          )`;
        const runId = yield* recordRun({ threadId, run: "run:card:broken" });
        yield* execute(threadId, runId);

        assert.equal((yield* readThread(threadId)).card?.runId, runId);
        const command = harness.dispatched.find(
          (candidate) => candidate.type === "thread.card.record",
        );
        assert(command?.type === "thread.card.record");
        assert.isUndefined(command.run);
        assert.isUndefined(command.filing);

        // A line for the run makes the rollback's cleanup read the broken row.
        yield* sql`
          INSERT INTO tide_thread_runs (
            run_id, thread_id, ordinal, user_message_id, reply_message_id, started_by,
            started_at, replied_at
          ) VALUES (
            ${runId}, ${threadId}, 1, 'message:a', 'message:b', 'owner',
            '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z'
          )`;
        const [run] = (yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }))
          .runs;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make(`${runId}:rolled-back`),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: yield* DateTime.now,
              payload: { ...run!, status: "rolled_back" },
            },
          ],
        });
        const [stored] = (yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [runId] }))
          .runs;
        assert.equal(stored?.status, "rolled_back");
        const [left] = yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM tide_thread_runs WHERE run_id = ${runId}`;
        assert.equal(left?.count, 0);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
