import { assert, describe, it, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadEntryId,
  ThreadId,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as ContentsBackfillService from "./ContentsBackfillService.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ThreadRegroupService from "./ThreadRegroupService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:backfill");
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in backfill tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const runId = (thread: ThreadId, n: number) => RunId.make(`${thread}:run:${n}`);

/** `rN: Headline N` for every run the prompt lists. */
const headlinesFor = (prompt: string) =>
  [...prompt.matchAll(/^r(\d+)$/gm)]
    .map((match) => `r${match[1]}: Headline ${match[1]}`)
    .join("\n");

function makeHarness(options: { readonly enabled?: boolean } = {}) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "contents-backfill" },
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
  const replies = {
    headlines: (prompt: string) => Effect.succeed({ transcription: headlinesFor(prompt) }),
    regroup: (_prompt: string) => Effect.succeed({ transcription: "" }),
  };
  const prompts: Array<string> = [];
  const generate = vi.fn<
    TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"]
  >((input) => {
    prompts.push(input.prompt);
    return input.prompt.startsWith("Group the runs")
      ? replies.regroup(input.prompt)
      : replies.headlines(input.prompt);
  });
  const layerDependencies = Layer.mergeAll(
    layerThreadManagement,
    ThreadEntryStore.layer.pipe(Layer.provide(layerDatabase)),
    Layer.mock(TextGeneration.TextGeneration)({ generateTranscriptionPostProcessing: generate }),
    layerServerSettings,
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-contents-backfill-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    NodeServices.layer,
    SecureRandom.layerWebCrypto,
    layerDatabase,
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerThreadManagement,
      ContentsBackfillService.layer.pipe(
        Layer.provide(
          Layer.merge(
            layerDependencies,
            ThreadRegroupService.layer.pipe(Layer.provide(layerDependencies)),
          ),
        ),
      ),
      ThreadEntryStore.layer.pipe(Layer.provide(layerDatabase)),
    ),
    replies,
    prompts,
  };
}

const createThread = (threadId: ThreadId, title: string) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`command:backfill:create:${threadId}`),
      threadId,
      projectId,
      title,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    }),
  );

/** A completed run with the user's message and a reply, as a provider turn leaves it. */
const recordRun = Effect.fn("test.recordRun")(function* (
  threadId: ThreadId,
  n: number,
  text = `Step ${n}`,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  yield* TestClock.adjust("1 minute");
  const now = yield* DateTime.now;
  const id = runId(threadId, n);
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
      message("user", text),
      message("assistant", `Finished step ${n}.`),
    ],
  });
  return { id, now };
});

/** A run carded as it completed, filed under a new topic or under the thread's first one. */
const cardRun = Effect.fn("test.cardRun")(function* (
  threadId: ThreadId,
  n: number,
  card: { readonly newTitle?: string; readonly ask?: string },
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const { id, now } = yield* recordRun(threadId, n);
  yield* threads.dispatch({
    type: "thread.card.record",
    commandId: CommandId.make(`command:backfill:card:${id}`),
    threadId,
    runId: id,
    messageId: MessageId.make(`${id}:assistant`),
    repliedAt: DateTime.formatIso(now),
    line: `Card line ${n}`,
    topics: [],
    open: card.ask === undefined ? [] : [{ kind: "ask", text: card.ask }],
    run: {
      ordinal: n,
      userMessageId: MessageId.make(`${id}:user`),
      startedAt: DateTime.formatIso(now),
      startedBy: "owner",
      ownerText: `Step ${n}`,
      goAhead: false,
      ownerSpokeMidRun: false,
    },
    filing:
      card.newTitle === undefined
        ? [{ ref: ThreadEntryId.make(`${threadId}:e1`), outcome: `Card line ${n}` }]
        : [{ ref: "new", title: card.newTitle, outcome: `Card line ${n}` }],
  });
});

const backfillOf = ContentsBackfillService.ContentsBackfillService;

/** Starts the estimated job and waits for it to finish. */
const runBackfill = Effect.fn("test.runBackfill")(function* (estimateId: string) {
  const backfill = yield* backfillOf;
  const { jobId } = yield* backfill.start({ estimateId });
  const finished = yield* backfill.changes.pipe(
    Stream.filter((status) => status?.jobId === jobId && status.finishedAt !== null),
    Stream.runHead,
  );
  return Option.getOrThrow(finished)!;
});

const contentsOf = (threadId: ThreadId) =>
  ThreadEntryStore.ThreadEntryStore.use((store) =>
    Effect.all([store.getThreadContents(threadId), store.runLines(threadId)]),
  );

const threadOf = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.getThreadRecords(threadId, []).pipe(Effect.map(({ thread }) => thread)),
  );

describe("estimateBackfill", () => {
  const candidate = (completedRuns: number, missingRuns = completedRuns, hasEntries = false) => ({
    threadId: ThreadId.make(`thread:${completedRuns}:${missingRuns}`),
    completedRuns,
    missingRuns,
    hasEntries,
  });

  it("counts one headline per short thread in batches of twenty and every run of a long one", () => {
    const project = [
      ...Array.from({ length: 95 }, () => candidate(4)),
      ...Array.from({ length: 5 }, () => candidate(45)),
    ];
    const all = ContentsBackfillService.estimateBackfill({
      candidates: project,
      migrated: 0,
      only: undefined,
    });
    assert.deepEqual(
      [all.threads, all.runs, all.calls],
      [{ short: 95, long: 5, migrated: 0 }, 95 * 4 + 5 * 45, { headlines: 5 + 15, regroups: 5 }],
    );
    const long = ContentsBackfillService.estimateBackfill({
      candidates: project,
      migrated: 0,
      only: "long",
    });
    assert.deepEqual([long.threads.short, long.calls], [0, { headlines: 15, regroups: 5 }]);
    assert.isBelow(long.promptTokens, all.promptTokens);
  });

  it("asks nothing for a short thread that already has a topic", () => {
    const estimate = ContentsBackfillService.estimateBackfill({
      candidates: [candidate(3, 2, true), candidate(12, 4, true)],
      migrated: 2,
      only: undefined,
    });
    assert.deepEqual(
      [estimate.threads, estimate.runs, estimate.calls],
      [{ short: 1, long: 1, migrated: 2 }, 6, { headlines: 1, regroups: 1 }],
    );
  });
});

describe("ContentsBackfillService", () => {
  it.effect(
    "files short and long threads without touching cards, open items, titles or activity, keeps hand edits, and finds nothing the second time",
    () =>
      Effect.gen(function* () {
        const harness = makeHarness();
        yield* Effect.gen(function* () {
          const threads = yield* ThreadManagement.ThreadManagementService;
          const backfill = yield* backfillOf;
          const signup = ThreadId.make("thread:signup");
          const login = ThreadId.make("thread:login");
          const billing = ThreadId.make("thread:billing");
          const e = (thread: ThreadId, seq: number) => ThreadEntryId.make(`${thread}:e${seq}`);

          // Short, never carded.
          yield* createThread(signup, "Signup form");
          yield* recordRun(signup, 1);
          yield* recordRun(signup, 2);
          // A maintenance command gets no line, so it never counts as work left.
          yield* recordRun(signup, 3, "/compact");
          // Short, its last run carded with an open question.
          yield* createThread(login, "Login page");
          yield* recordRun(login, 1);
          yield* recordRun(login, 2);
          yield* cardRun(login, 3, { newTitle: "Login redirect", ask: "Deploy the fix now?" });
          // Long: runs 11 and 12 carded, then edited by hand.
          yield* createThread(billing, "Billing and onboarding");
          for (let n = 1; n <= 10; n++) yield* recordRun(billing, n);
          yield* cardRun(billing, 11, { newTitle: "Billing bug" });
          yield* cardRun(billing, 12, { ask: "Ship the invoice change?" });
          const edit = (n: number, command: Record<string, unknown>) =>
            threads.dispatch({
              ...command,
              commandId: CommandId.make(`command:backfill:edit:${n}`),
              threadId: billing,
            } as Parameters<typeof threads.dispatch>[0]);
          yield* edit(1, {
            type: "thread.entry.rename",
            entryId: e(billing, 1),
            title: "My billing",
          });
          yield* edit(2, {
            type: "thread.entry.move-run",
            runId: runId(billing, 12),
            target: { newTitle: "Invoice change" },
          });
          yield* TestClock.adjust("2 hours");
          // Too recent: its own card may still be on its way.
          yield* recordRun(billing, 13);

          const before = yield* Effect.forEach([signup, login, billing], threadOf);
          const [billingBefore] = yield* contentsOf(billing);
          const [loginBefore] = yield* contentsOf(login);

          harness.replies.regroup = () =>
            Effect.succeed({
              transcription: [
                "Billing bug | Invoices fixed | done | 1 2 3 4 5 11 12",
                "Onboarding | Redesigned | open | 6 7 8 9 10",
              ].join("\n"),
            });
          const estimate = yield* backfill.estimate({ projectId });
          assert.deepEqual(
            [estimate.threads, estimate.runs, estimate.calls],
            [{ short: 2, long: 1, migrated: 0 }, 2 + 2 + 10, { headlines: 2, regroups: 1 }],
          );
          const job = yield* runBackfill(estimate.estimateId);
          assert.deepEqual([job.done, job.total, job.calls, job.failed], [3, 3, 3, 0]);

          // The long thread's headlines, its regroup, then the one short thread with no topic.
          assert.lengthOf(harness.prompts, 3);
          assert.include(
            harness.prompts[0],
            "r10\nuser: Step 10\nreply: Finished step 10.\n</runs>",
          );
          assert.include(harness.prompts[1], "r12 | Step 12 | Card line 12\n</outline>");
          assert.include(harness.prompts[2], "r1\nuser: Step 2\nreply: Finished step 2.\n</runs>");

          const [signupContents, signupLines] = yield* contentsOf(signup);
          assert.deepEqual(
            signupContents.entries.map((entry) => [entry.title, entry.outcome, entry.runs.length]),
            [["Signup form", "Headline 1", 2]],
          );
          assert.deepEqual(
            signupLines.map((line) => line.line),
            [null, "Headline 1"],
          );

          const [loginContents, loginLines] = yield* contentsOf(login);
          assert.deepEqual(
            loginContents.entries.map((entry) => [entry.id, entry.title, entry.runs.length]),
            [[e(login, 1), "Login redirect", 3]],
          );
          assert.deepEqual(loginContents.entries[0]!.open, loginBefore.entries[0]!.open);
          assert.deepEqual(
            loginLines.map((line) => line.line),
            [null, null, "Card line 3"],
          );

          const [billingContents, billingLines] = yield* contentsOf(billing);
          const runsOf = (seq: number) =>
            billingContents.entries
              .find((entry) => entry.id === e(billing, seq))!
              .runs.map(
                (link) =>
                  `${link.runId.slice(link.runId.lastIndexOf(":") + 1)}${link.source === "owner" ? "o" : ""}`,
              )
              .join(" ");
          assert.deepEqual(
            billingContents.entries.map((entry) => [entry.id, entry.title, entry.titleSource]),
            [
              [e(billing, 1), "My billing", "owner"],
              [e(billing, 3), "Onboarding", "model"],
              [e(billing, 2), "Invoice change", "owner"],
            ],
          );
          assert.deepEqual(
            [runsOf(1), runsOf(2), runsOf(3)],
            ["1 2 3 4 5 11", "12o", "6 7 8 9 10"],
          );
          // The open item stays with the run that raised it, in the topic the owner made.
          assert.deepEqual(
            billingContents.entries.find((entry) => entry.id === e(billing, 2))!.open,
            billingBefore.entries.find((entry) => entry.id === e(billing, 2))!.open,
          );
          assert.deepEqual(
            billingLines.map((line) => line.line),
            [
              ...Array.from({ length: 10 }, (_, index) => `Headline ${index + 1}`),
              "Card line 11",
              "Card line 12",
            ],
          );
          assert.deepEqual(
            [billingContents.state?.ownerRuns, billingContents.state?.runsSinceRegroup],
            [12, 0],
          );

          const after = yield* Effect.forEach([signup, login, billing], threadOf);
          assert.deepEqual(
            after.map((thread) => [thread.title, thread.updatedAt, thread.card ?? null]),
            before.map((thread) => [thread.title, thread.updatedAt, thread.card ?? null]),
          );

          // A record read before the run was carded never rewrites the card's line.
          yield* threads.dispatch({
            type: "thread.contents.backfill.record",
            commandId: CommandId.make("command:backfill:stale"),
            threadId: login,
            runLines: [{ ...loginLines[2]!, line: null }],
          });
          assert.deepEqual(yield* contentsOf(login), [loginContents, loginLines]);

          const again = yield* backfill.estimate({ projectId });
          assert.deepEqual([again.runs, again.calls], [0, { headlines: 0, regroups: 0 }]);
          const second = yield* runBackfill(again.estimateId);
          assert.deepEqual([second.total, second.calls], [0, 0]);
          assert.lengthOf(harness.prompts, 3);
        }).pipe(Effect.provide(harness.layer));
      }),
  );

  it.effect("a failed regroup leaves the long thread for the next start", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const backfill = yield* backfillOf;
        const billing = ThreadId.make("thread:billing");
        yield* createThread(billing, "Billing");
        for (let n = 1; n <= 10; n++) yield* recordRun(billing, n);
        yield* TestClock.adjust("2 hours");
        harness.replies.regroup = () => Effect.succeed({ transcription: "no topics here" });
        const job = yield* runBackfill((yield* backfill.estimate({ projectId })).estimateId);
        assert.deepEqual([job.done, job.calls, job.failed], [1, 2, 1]);
        const [contents, lines] = yield* contentsOf(billing);
        assert.deepEqual([contents.entries, lines], [[], []]);
        assert.strictEqual((yield* backfill.estimate({ projectId })).runs, 10);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("cancel stops the job during a call and records nothing", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const backfill = yield* backfillOf;
        const signup = ThreadId.make("thread:signup");
        yield* createThread(signup, "Signup form");
        yield* recordRun(signup, 1);
        yield* TestClock.adjust("2 hours");
        const called = yield* Deferred.make<void>();
        harness.replies.headlines = () =>
          Deferred.succeed(called, undefined).pipe(Effect.andThen(Effect.never));
        const { jobId } = yield* backfill.start({
          estimateId: (yield* backfill.estimate({ projectId })).estimateId,
        });
        yield* Deferred.await(called);
        yield* backfill.cancel;
        const status = yield* backfill.status;
        assert.strictEqual(status?.jobId, jobId);
        assert.isNotNull(status?.finishedAt);
        assert.strictEqual(status?.done, 0);
        assert.deepEqual(yield* contentsOf(signup), [
          { entries: [], state: null, previousRunEntryIds: [] },
          [],
        ]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("refuses an expired estimate and a start while summaries are off", () =>
    Effect.gen(function* () {
      const expired = makeHarness();
      yield* Effect.gen(function* () {
        const backfill = yield* backfillOf;
        const { estimateId } = yield* backfill.estimate({ projectId });
        yield* TestClock.adjust("16 minutes");
        const error = yield* backfill.start({ estimateId }).pipe(Effect.flip);
        assert.include(error.message, "expired");
      }).pipe(Effect.provide(expired.layer));
      const off = makeHarness({ enabled: false });
      yield* Effect.gen(function* () {
        const backfill = yield* backfillOf;
        const { estimateId } = yield* backfill.estimate({ projectId });
        const error = yield* backfill.start({ estimateId }).pipe(Effect.flip);
        assert.include(error.message, "reply summaries");
        assert.isNull(yield* backfill.status);
      }).pipe(Effect.provide(off.layer));
    }),
  );
});
