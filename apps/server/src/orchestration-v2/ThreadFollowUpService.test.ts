import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type OrchestrationV2AppThread,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadFollowUpService from "./ThreadFollowUpService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:later");
const nowMs = Date.parse("2026-11-16T12:00:00.000Z");

const harness = Effect.fn(function* (
  followUps: ReadonlyArray<ProjectionStore.ProjectionFollowUpRow> = [],
) {
  const dispatched = yield* Ref.make<ReadonlyArray<OrchestrationV2ServerCommand>>([]);
  const layer = ThreadFollowUpService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Ref.update(dispatched, (commands) => [...commands, command]).pipe(
              Effect.as({ sequence: 7, storedEvents: [] }),
            ),
          getThreadShell: () =>
            Effect.succeed({
              followUp: {
                reason: "Nightly test",
                dueAt: "2026-11-16T12:10:00.000Z",
                armedBy: "agent",
                quietCount: 2,
              },
            } as never),
        }),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({
          getFollowUps: () => Effect.succeed(followUps),
        }),
        ServerSettings.layerTest({ laterRecheckLimit: 2 }),
      ),
    ),
  );
  return { dispatched, layer };
});

const armInput = {
  commandId: CommandId.make("arm"),
  threadId,
  callerThreadId: threadId,
  question: "  Did the nightly test pass?  ",
  reason: "Nightly test",
};

it.effect("arms the caller's own thread as an agent with the configured limit", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const { dispatched, layer } = yield* harness();
    const result = yield* Effect.gen(function* () {
      const service = yield* ThreadFollowUpService.ThreadFollowUpService;
      return yield* service.arm({ ...armInput, inMinutes: 10 });
    }).pipe(Effect.provide(layer));
    assert.deepEqual(result, { checkAt: "2026-11-16T12:10:00.000Z", recheck: 2, limit: 2 });
    assert.deepEqual(yield* Ref.get(dispatched), [
      {
        type: "thread.follow-up.set",
        commandId: CommandId.make("arm"),
        threadId,
        question: "Did the nightly test pass?",
        reason: "Nightly test",
        dueAt: "2026-11-16T12:10:00.000Z",
        armedBy: "agent",
        limit: 2,
      },
    ]);
  }),
);

it.effect.each([
  {
    name: "another thread's agent",
    input: { callerThreadId: ThreadId.make("thread:other") },
    problem: "not-own-thread",
  },
  {
    name: "an environment-level caller",
    input: { callerThreadId: null },
    problem: "not-own-thread",
  },
  {
    name: "a blank question",
    input: { question: "   ", inMinutes: 30 },
    problem: "needs-question",
  },
  { name: "no time", input: {}, problem: "needs-one-time" },
  { name: "two times", input: { inMinutes: 30, afterPublish: true }, problem: "needs-one-time" },
  { name: "an unreadable time", input: { at: "tomorrow" }, problem: "invalid-time" },
] as const)("refuses $name before dispatching", ({ input, problem }) =>
  Effect.gen(function* () {
    const { dispatched, layer } = yield* harness();
    const error = yield* Effect.gen(function* () {
      const service = yield* ThreadFollowUpService.ThreadFollowUpService;
      return yield* service.arm({ ...armInput, ...input });
    }).pipe(Effect.provide(layer), Effect.flip);
    assert.equal(error._tag, "ThreadFollowUpRequestError");
    if (error._tag === "ThreadFollowUpRequestError") assert.equal(error.problem, problem);
    assert.deepEqual(yield* Ref.get(dispatched), []);
  }),
);

it.effect("releases only the waiting follow-ups of the published projects", () =>
  Effect.gen(function* () {
    const thread = (id: string, project: string, dueAt: string | null) =>
      ({
        thread: {
          id: ThreadId.make(id),
          projectId: ProjectId.make(project),
          followUp: {
            question: "Crash rate?",
            reason: "After publish",
            dueAt,
            afterPublishMinutes: 60,
            armedAt: "2026-11-16T09:00:00.000Z",
            armedBy: "agent",
            quietCount: 0,
          },
        } as OrchestrationV2AppThread,
        runActive: false,
      }) satisfies ProjectionStore.ProjectionFollowUpRow;
    const { dispatched, layer } = yield* harness([
      thread("waiting", "project:published", null),
      thread("timed", "project:published", "2026-11-17T09:00:00.000Z"),
      thread("elsewhere", "project:other", null),
    ]);
    const now = DateTime.makeUnsafe(nowMs);
    const released = yield* Effect.gen(function* () {
      const service = yield* ThreadFollowUpService.ThreadFollowUpService;
      return yield* service.releaseForProjects([ProjectId.make("project:published")], now);
    }).pipe(Effect.provide(layer));
    assert.equal(released, 1);
    assert.deepEqual(yield* Ref.get(dispatched), [
      {
        type: "thread.follow-up.release",
        commandId: CommandId.make(
          `later-release:waiting:${Date.parse("2026-11-16T09:00:00.000Z")}`,
        ),
        threadId: ThreadId.make("waiting"),
        dueAt: "2026-11-16T13:00:00.000Z",
      },
    ]);
  }),
);
