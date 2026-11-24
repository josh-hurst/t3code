import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  EventId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ThreadProgressService from "./ThreadProgressService.ts";

const startMs = Date.parse("2026-11-20T12:00:00.000Z");
const threadId = ThreadId.make("thread:progress:parent");
const subagentId = NodeId.make("node:progress:subagent");
const providerInstanceId = ProviderInstanceId.make("codex");

function subagentEvent(
  status: OrchestrationV2Subagent["status"],
  offsetMs: number,
): OrchestrationV2DomainEvent {
  const at = DateTime.makeUnsafe(startMs + offsetMs);
  return {
    id: EventId.make(`event:progress:${status}`),
    threadId,
    occurredAt: at,
    type: "subagent.updated",
    payload: {
      id: subagentId,
      threadId,
      runId: RunId.make("run:progress:1"),
      parentNodeId: NodeId.make("node:progress:root"),
      origin: "app_owned",
      createdBy: "agent",
      driver: ProviderDriverKind.make("codex"),
      providerInstanceId,
      providerThreadId: null,
      childThreadId: ThreadId.make("thread:progress:child"),
      nativeTaskRef: null,
      prompt: "Fix the failing auth tests",
      title: "Auth tests",
      model: null,
      status,
      result: null,
      startedAt: at,
      completedAt: null,
      updatedAt: at,
    },
  };
}

it.effect("records lines for a thread with a live subagent, then clears them when it ends", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(startMs);
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const dispatched = yield* Queue.unbounded<OrchestrationV2ServerCommand>();
    const layer = ThreadProgressService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
            getThreadShell: () =>
              Effect.succeed({
                deletedAt: null,
                archivedAt: null,
                lineage: {
                  parentThreadId: null,
                  relationshipToParent: null,
                  rootThreadId: threadId,
                },
                activityRunStatus: "waiting",
                status: "waiting",
              } as never),
            dispatch: (command) =>
              Queue.offer(dispatched, command).pipe(Effect.as({ sequence: 1, storedEvents: [] })),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              threadReplySummariesEnabled: true,
              threadReplySummaryModelSelection: { instanceId: providerInstanceId, model: "luna" },
            } as never),
          }),
          Layer.mock(TextGeneration.TextGeneration)({
            generateTranscriptionPostProcessing: () =>
              Effect.succeed({
                transcription:
                  "thread: Fixing auth tests\na1: Rerunning auth.test.ts; 2 of 5 fixed",
              }),
          }),
          Layer.succeed(
            SecureRandom.SecureRandom,
            SecureRandom.make((size) => new Uint8Array(size).fill(7)),
          ),
          NodeServices.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* Queue.offer(events, subagentEvent("running", 0));
      yield* TestClock.adjust("20 seconds");
      const recorded = yield* Queue.take(dispatched);
      assert.deepInclude(recorded, {
        type: "thread.progress.record",
        threadId,
        progress: {
          line: "Fixing auth tests",
          agents: [{ subagentId, line: "Rerunning auth.test.ts; 2 of 5 fixed" }],
        },
      });

      yield* Queue.offer(events, subagentEvent("completed", 25_000));
      const cleared = yield* Queue.take(dispatched);
      assert.deepInclude(cleared, { type: "thread.progress.record", threadId, progress: null });
    }).pipe(Effect.provide(layer));
  }),
);
