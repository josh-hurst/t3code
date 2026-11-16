import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2DomainEvent,
  type ThreadFollowUp,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as LaterFollowUpWorker from "./LaterFollowUpWorker.ts";
import { planFollowUpSweep } from "./LaterFollowUpWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const nowMs = Date.parse("2026-11-16T12:00:00.000Z");
const at = (offsetMinutes: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs + offsetMinutes * 60_000));

const row = (input: {
  readonly id: string;
  readonly project?: string;
  readonly followUp: Partial<ThreadFollowUp>;
  readonly settled?: boolean;
  readonly runActive?: boolean;
}): ProjectionStore.ProjectionFollowUpRow => ({
  thread: {
    id: ThreadId.make(input.id),
    projectId: ProjectId.make(input.project ?? "project:a"),
    settledOverride: input.settled === true ? "settled" : null,
    followUp: {
      question: "Done?",
      reason: "Test",
      dueAt: at(-1),
      armedAt: at(-60),
      armedBy: "agent",
      quietCount: 0,
      ...input.followUp,
    },
  } as OrchestrationV2AppThread,
  runActive: input.runActive ?? false,
});

const ids = (rows: ReadonlyArray<ProjectionStore.ProjectionFollowUpRow>) =>
  rows.map((candidate) => candidate.thread.id);

describe("planFollowUpSweep", () => {
  it("sends the earliest due follow-up per project and waits for the next due time", () => {
    const plan = planFollowUpSweep(
      [
        row({ id: "later", followUp: { dueAt: at(-1) } }),
        row({ id: "earlier", followUp: { dueAt: at(-30) } }),
        row({ id: "other-project", project: "project:b", followUp: { dueAt: at(-5) } }),
        row({ id: "future", followUp: { dueAt: at(20) } }),
        row({ id: "publish", followUp: { dueAt: null } }),
      ],
      nowMs,
    );
    assert.deepEqual(ids(plan.send), ["earlier", "other-project"]);
    assert.deepEqual(ids(plan.clear), []);
    assert.equal(plan.wakeAt, Date.parse(at(20)));
  });

  it("holds a project while a sent re-check still runs, and clears a settled one", () => {
    const plan = planFollowUpSweep(
      [
        row({
          id: "running",
          followUp: { sentAt: at(-2), runId: RunId.make("run:running") },
          runActive: true,
        }),
        row({ id: "waiting", followUp: { dueAt: at(-1) } }),
        row({ id: "settled", project: "project:b", followUp: { dueAt: at(-1) }, settled: true }),
      ],
      nowMs,
    );
    assert.deepEqual(ids(plan.send), []);
    assert.deepEqual(ids(plan.clear), ["settled"]);
    assert.isNull(plan.wakeAt);
  });
});

it.effect("a due follow-up sends its marked question once, under a fixed id", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const sends = yield* Queue.unbounded<ThreadManagement.ThreadManagementSendInput>();
    const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand["type"]>>([]);
    const rows = yield* Ref.make<ReadonlyArray<ProjectionStore.ProjectionFollowUpRow>>([
      row({ id: "due", followUp: { quietCount: 1 } }),
    ]);
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const reads = yield* Queue.unbounded<number>();
    const layer = LaterFollowUpWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getFollowUps: () => Queue.offer(reads, 1).pipe(Effect.andThen(Ref.get(rows))),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            sendToThread: (input) =>
              Queue.offer(sends, input).pipe(
                // The send commits: the projection now shows it sent.
                Effect.andThen(
                  Ref.set(rows, [
                    row({ id: "due", followUp: { sentAt: at(0), runId: RunId.make("run:sent") } }),
                  ]),
                ),
                Effect.as({} as never),
              ),
            dispatch: (command) =>
              Ref.update(dispatched, (types) => [...types, command.type]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              ),
          }),
          Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.fromQueue(events) }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({ laterRecheckLimit: 3 } as never),
            streamChanges: Stream.never,
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const sent = yield* Queue.take(sends);
      assert.deepInclude(sent, {
        threadId: ThreadId.make("due"),
        commandId: CommandId.make(`later-follow-up:due:${Date.parse(at(-60))}`),
        messageId: MessageId.make(`later-follow-up:due:${Date.parse(at(-60))}`),
        mode: "queue",
        followUp: true,
        createdBy: "agent",
        creationSource: "server",
      });
      assert.include(sent.text, "Done?");
      yield* Queue.take(reads);
      // The sweep that sent re-reads on the next tick and finds it sent.
      yield* TestClock.adjust("5 seconds");
      yield* Queue.take(reads);
      assert.equal(yield* Queue.size(sends), 0);
      assert.deepEqual(yield* Ref.get(dispatched), []);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect.each([
  { name: "before it committed", committed: false, clears: ["thread.follow-up.clear"] },
  { name: "after it committed", committed: true, clears: [] },
] as const)(
  "a send that fails $name ends the follow-up only if it is still armed",
  ({ committed, clears }) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const due = row({ id: "due", followUp: {} });
      const sentRow = row({
        id: "due",
        followUp: { sentAt: at(0), runId: RunId.make("run:sent") },
      });
      const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand["type"]>>([]);
      const reads = yield* Queue.unbounded<number>();
      const layer = LaterFollowUpWorker.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Scheduler.layer,
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getFollowUps: () => Queue.offer(reads, 1).pipe(Effect.as([due])),
              getThread: () => Effect.succeed((committed ? sentRow : due).thread),
            }),
            Layer.mock(ThreadManagement.ThreadManagementService)({
              sendToThread: () => Effect.die("provider unavailable"),
              dispatch: (command) =>
                Ref.update(dispatched, (types) => [...types, command.type]).pipe(
                  Effect.as({ sequence: 1, storedEvents: [] }),
                ),
            }),
            Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
            Layer.mock(ServerSettings.ServerSettingsService)({
              getSettings: Effect.succeed({ laterRecheckLimit: 3 } as never),
              streamChanges: Stream.never,
            }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        // The first sweep fails its send; the one after it has finished handling that failure.
        yield* Queue.take(reads);
        yield* TestClock.adjust("5 seconds");
        yield* Queue.take(reads);
        assert.deepEqual((yield* Ref.get(dispatched)).slice(0, 1).map(String), [...clears]);
      }).pipe(Effect.provide(layer));
    }),
);
