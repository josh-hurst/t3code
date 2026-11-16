import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  CommandId,
  EventId,
  MessageId,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type ScheduledTask,
  ScheduledTaskId,
  type ThreadCardOpenItem,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as OpenItemService from "./OpenItemService.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import * as ThreadFollowUpService from "./ThreadFollowUpService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const projectId = ProjectId.make("project:open-items");
const ROOT = "/repo/acme";
const WORKTREE = "/repo/acme-worktree";
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.1-codex",
} as const;

const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in open item tests"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const SHIP = { kind: "ship", text: "Publish 2.4.0 to the store" } as const;
const COMMIT = { kind: "commit", text: "Commit the changelog" } as const;

function makeHarness() {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerOrchestrator = ProviderReplayHarness.layerWithRegistry(
    { name: "open-items" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  );
  const layerServerSettings = ServerSettings.layerTest({});
  const layerThreadManagement = ThreadManagement.layer.pipe(
    Layer.provide(layerOrchestrator),
    Layer.provide(layerServerSettings),
    Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  );
  const ranNow: Array<ScheduledTaskId> = [];
  const tasks: Array<ScheduledTask> = [];
  const cleanCheckouts = new Set<string>();
  const layerOpenItems = OpenItemService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreadManagement,
        ThreadEntryStore.layer.pipe(Layer.provide(layerDatabase)),
        ThreadFollowUpService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              layerThreadManagement,
              layerServerSettings,
              ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
            ),
          ),
        ),
        Layer.mock(ScheduledTaskService.ScheduledTaskService)({
          list: () => Effect.succeed({ tasks }),
          runNow: ({ id }) =>
            Effect.sync(() => {
              ranNow.push(id);
              return { task: tasks.find((task) => task.id === id)!, threadId: null };
            }),
        }),
        Layer.mock(ProjectService.ProjectService)({
          getById: () => Effect.succeedSome({ id: projectId, workspaceRoot: ROOT } as Project),
        }),
        Layer.mock(VcsStatusBroadcaster.VcsStatusBroadcaster)({
          refreshLocalStatus: (cwd) =>
            Effect.succeed({
              isRepo: true,
              hasPrimaryRemote: true,
              isDefaultRef: true,
              refName: "main",
              hasWorkingTreeChanges: !cleanCheckouts.has(cwd),
              workingTree: { files: [], insertions: 0, deletions: 0 },
            }),
        }),
        NodeCrypto.layer,
        layerDatabase,
      ),
    ),
  );
  return {
    layer: Layer.mergeAll(
      layerOrchestrator,
      layerThreadManagement,
      layerOpenItems,
      ThreadEntryStore.layer.pipe(Layer.provide(layerDatabase)),
    ),
    ranNow,
    tasks,
    cleanCheckouts,
  };
}

const createThread = Effect.fn("test.createThread")(function* (
  name: string,
  worktreePath: string | null = null,
) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(`thread:open-items:${name}`);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`command:open-items:${name}:create`),
    threadId,
    projectId,
    title: `Thread ${name}`,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

/** A completed run whose card lists `open`, filed under one entry, as the card call writes it. */
const recordCard = Effect.fn("test.recordCard")(function* (
  threadId: ThreadId,
  name: string,
  open: ReadonlyArray<ThreadCardOpenItem>,
  ordinal = 1,
  newEntry?: string,
) {
  const eventSink = yield* EventSink.EventSinkV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const now = yield* DateTime.now;
  const runId = RunId.make(`run:open-items:${name}`);
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`${runId}:created`),
        type: "run.created",
        threadId,
        runId,
        occurredAt: now,
        payload: {
          id: runId,
          threadId,
          ordinal,
          providerInstanceId: modelSelection.instanceId,
          modelSelection,
          providerThreadId: null,
          userMessageId: MessageId.make(`${runId}:user`),
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
    ],
  });
  yield* threads.dispatch({
    type: "thread.card.record",
    commandId: CommandId.make(`command:open-items:${name}:card`),
    threadId,
    runId,
    messageId: MessageId.make(`${runId}:reply`),
    repliedAt: DateTime.formatIso(now),
    line: "Built the release",
    topics: [],
    open,
    run: {
      ordinal,
      userMessageId: MessageId.make(`${runId}:user`),
      startedAt: DateTime.formatIso(now),
      startedBy: "owner",
      ownerText: "Build the release",
      goAhead: false,
      ownerSpokeMidRun: false,
    },
    filing:
      ordinal === 1 || newEntry !== undefined
        ? [{ ref: "new", title: newEntry ?? "Release", outcome: "Built" }]
        : [],
  });
  return runId;
});

const readThread = (threadId: ThreadId) =>
  ThreadManagement.ThreadManagementService.use((threads) =>
    threads.getThreadRecords(threadId, []).pipe(Effect.map((records) => records.thread)),
  );

const openKinds = (threadId: ThreadId) =>
  readThread(threadId).pipe(Effect.map((thread) => thread.card?.open.map((item) => item.kind)));

const entryOpenKinds = (threadId: ThreadId) =>
  ThreadEntryStore.ThreadEntryStore.use((store) => store.getThreadContents(threadId)).pipe(
    Effect.map((contents) =>
      contents.entries.map(
        (entry) => `${entry.id} ${entry.status} ${entry.open.map((item) => item.kind).join(",")}`,
      ),
    ),
  );

const openItems = OpenItemService.OpenItemService;

describe("OpenItemService", () => {
  it.effect("a publish clears ship items on settled threads too and Undo puts them back", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* openItems;
        const active = yield* createThread("active");
        yield* recordCard(active, "active", [SHIP, COMMIT]);
        const settled = yield* createThread("settled");
        yield* recordCard(settled, "settled", [{ kind: "ship", text: "Publish the web build" }]);
        yield* threads.dispatch({
          type: "thread.settle",
          commandId: CommandId.make("command:open-items:settle"),
          threadId: settled,
        });
        const settledBefore = yield* readThread(settled);
        yield* TestClock.adjust("1 hour");

        const published = yield* service.markPublished({ projectIds: [projectId] });
        assert.strictEqual(published.cleared, 2);
        assert.deepEqual(yield* openKinds(active), ["commit"]);
        assert.deepEqual(yield* openKinds(settled), []);
        assert.deepEqual(yield* entryOpenKinds(settled), [`${settled}:e1 active `]);
        const settledAfter = yield* readThread(settled);
        assert.isNotNull(settledAfter.settledAt);
        assert.deepEqual(settledAfter.updatedAt, settledBefore.updatedAt);
        const now = DateTime.formatIso(yield* DateTime.now);
        assert.deepEqual((yield* service.counts()).projects, [
          {
            projectId,
            counts: { ask: 0, verify: 0, commit: 1, ship: 0, followup: 0 },
            lastPublishedAt: now,
          },
        ]);

        // A second publish has nothing left to clear.
        const again = yield* service.markPublished({ projectIds: [projectId] });
        assert.deepEqual([again.cleared, again.followUpsStarted], [0, 0]);

        assert.deepEqual(yield* service.undoPublished(published.markerId), { restored: 2 });
        assert.sameMembers((yield* openKinds(active))!, ["commit", "ship"]);
        assert.deepEqual(yield* openKinds(settled), ["ship"]);
        assert.deepEqual(yield* entryOpenKinds(settled), [`${settled}:e1 active ship`]);
        assert.isNotNull((yield* readThread(settled)).settledAt);
        // Undo is one-shot.
        assert.deepEqual(yield* service.undoPublished(published.markerId), { restored: 0 });
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("Undo follows a regrouped run and leaves a card written since alone", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* openItems;
        const regrouped = yield* createThread("regrouped");
        const release = yield* recordCard(regrouped, "regrouped", []);
        const changelog = yield* recordCard(regrouped, "regrouped-2", [SHIP], 2, "Changelog");
        const recarded = yield* createThread("recarded");
        yield* recordCard(recarded, "recarded", [SHIP]);
        yield* TestClock.adjust("1 minute");
        const published = yield* service.markPublished({ projectIds: [projectId] });
        assert.strictEqual(published.cleared, 2);

        // The regroup puts both runs in one topic: the item's entry is retired into the first.
        yield* threads.dispatch({
          type: "thread.contents.regroup.record",
          commandId: CommandId.make("command:open-items:regroup"),
          threadId: regrouped,
          kind: "idle",
          topics: [{ title: "Release 2.4", outcome: "Built", runIds: [release, changelog] }],
        });
        yield* TestClock.adjust("1 minute");
        yield* recordCard(recarded, "recarded-2", [], 2);

        assert.deepEqual(yield* service.undoPublished(published.markerId), { restored: 1 });
        assert.deepEqual(yield* openKinds(regrouped), ["ship"]);
        assert.deepEqual(yield* entryOpenKinds(regrouped), [
          `${regrouped}:e1 active ship`,
          `${regrouped}:e2 retired `,
        ]);
        assert.deepEqual(yield* openKinds(recarded), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a publish releases after-publish re-checks and runs a standing check once", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const threads = yield* ThreadManagement.ThreadManagementService;
        const service = yield* openItems;
        const watched = yield* createThread("watched");
        yield* threads.dispatch({
          type: "thread.follow-up.set",
          commandId: CommandId.make("command:open-items:follow-up"),
          threadId: watched,
          question: "Did the crash rate go up after the publish?",
          reason: "Crash rate",
          afterPublishMinutes: 60,
          armedBy: "user",
        });
        const standing = yield* createThread("standing");
        yield* threads.dispatch({
          type: "thread.standing-check.set",
          commandId: CommandId.make("command:open-items:standing"),
          threadId: standing,
          enabled: true,
        });
        const taskId = ScheduledTaskId.make("task:open-items:standing");
        harness.tasks.push(
          { id: taskId, enabled: true, threadId: standing, projectId } as ScheduledTask,
          {
            id: ScheduledTaskId.make("task:open-items:plain"),
            enabled: true,
            threadId: watched,
            projectId,
          } as ScheduledTask,
        );

        const published = yield* service.markPublished({ projectIds: [projectId] });
        assert.strictEqual(published.followUpsStarted, 1);
        const due = DateTime.formatIso(DateTime.add(yield* DateTime.now, { minutes: 60 }));
        assert.strictEqual((yield* threads.getThreadShell(watched))?.followUp?.dueAt, due);
        assert.deepEqual(harness.ranNow, [taskId]);

        // A second click is not a second paid run.
        yield* TestClock.adjust("1 minute");
        assert.strictEqual(
          (yield* service.markPublished({ projectIds: [projectId] })).followUpsStarted,
          0,
        );
        assert.deepEqual(harness.ranNow, [taskId]);
        yield* TestClock.adjust("10 minutes");
        yield* service.markPublished({ projectIds: [projectId] });
        assert.deepEqual(harness.ranNow, [taskId, taskId]);
      }).pipe(Effect.provide(harness.layer));
    }),
  );

  it.effect("a clean checkout clears commit items only for threads working in it", () =>
    Effect.gen(function* () {
      const harness = makeHarness();
      yield* Effect.gen(function* () {
        const service = yield* openItems;
        const root = yield* createThread("root");
        yield* recordCard(root, "root", [COMMIT, SHIP]);
        const worktree = yield* createThread("worktree", WORKTREE);
        yield* recordCard(worktree, "worktree", [COMMIT]);

        assert.strictEqual(yield* service.resolveForCheckout(ROOT), 1);
        assert.deepEqual(yield* openKinds(root), ["ship"]);
        assert.deepEqual(yield* openKinds(worktree), ["commit"]);

        // Opening Still open re-reads each checkout that owes a commit.
        assert.strictEqual(yield* service.refresh([projectId]), 0);
        harness.cleanCheckouts.add(WORKTREE);
        assert.strictEqual(yield* service.refresh([projectId]), 1);
        assert.deepEqual(yield* openKinds(worktree), []);
      }).pipe(Effect.provide(harness.layer));
    }),
  );
});
