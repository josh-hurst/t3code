import {
  EventId,
  MessageId,
  NodeId,
  PlanId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  applyDomainEventToThreadProgress,
  beginGeneration,
  buildPromptSnapshotForThread,
  createThreadProgressState,
  dueThreadIds,
  finishGeneration,
  nextDueAtMs,
  recordGenerationResult,
  THREAD_PROGRESS_INITIAL_DELAY_MS,
  THREAD_PROGRESS_REFRESH_INTERVAL_MS,
  THREAD_PROGRESS_RING_BUFFER_MAX,
  THREAD_PROGRESS_SIGNIFICANT_INTERVAL_MS,
} from "./ThreadProgressState.ts";

const parentId = ThreadId.make("thread-parent");
const parent2Id = ThreadId.make("thread-parent-2");
const parent3Id = ThreadId.make("thread-parent-3");
const child1Id = ThreadId.make("thread-child-1");
const child2Id = ThreadId.make("thread-child-2");
const sub1Id = NodeId.make("sub-1");
const sub2Id = NodeId.make("sub-2");
const sub3Id = NodeId.make("sub-3");
const run1Id = RunId.make("run-1");
const run2Id = RunId.make("run-2");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const T0 = DateTime.makeUnsafe("2026-11-20T00:00:00.000Z");

let eventCounter = 0;
function nextEventId() {
  eventCounter += 1;
  return EventId.make(`event-${eventCounter}`);
}

function subagentEvent(
  overrides: Partial<OrchestrationV2Subagent> & {
    readonly id: NodeId;
    readonly threadId: ThreadId;
    readonly status: OrchestrationV2Subagent["status"];
  },
): OrchestrationV2DomainEvent {
  return {
    id: nextEventId(),
    threadId: overrides.threadId,
    occurredAt: T0,
    type: "subagent.updated",
    payload: {
      runId: run1Id,
      parentNodeId: NodeId.make("root"),
      origin: "app_owned",
      createdBy: "agent",
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Check auth tests",
      title: "Auth worker",
      model: null,
      result: null,
      startedAt: T0,
      completedAt: null,
      updatedAt: T0,
      ...overrides,
    },
  };
}

function commandItemEvent(
  threadId: ThreadId,
  itemId: string,
  input: string,
  status: OrchestrationV2TurnItem["status"] = "running",
): OrchestrationV2DomainEvent {
  return {
    id: nextEventId(),
    threadId,
    occurredAt: T0,
    type: "turn-item.updated",
    payload: {
      id: TurnItemId.make(itemId),
      threadId,
      runId: run1Id,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status,
      title: null,
      startedAt: T0,
      completedAt: null,
      updatedAt: T0,
      type: "command_execution",
      input,
    },
  };
}

function todoItemEvent(
  threadId: ThreadId,
  steps: ReadonlyArray<{
    readonly text: string;
    readonly status: "pending" | "running" | "completed";
  }>,
): OrchestrationV2DomainEvent {
  return {
    id: nextEventId(),
    threadId,
    occurredAt: T0,
    type: "turn-item.updated",
    payload: {
      id: TurnItemId.make("todo-1"),
      threadId,
      runId: run1Id,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "running",
      title: null,
      startedAt: T0,
      completedAt: null,
      updatedAt: T0,
      type: "todo_list",
      planId: PlanId.make("plan-1"),
      steps: steps.map((step, index) => ({ id: `step-${index}`, ...step })),
    },
  };
}

function assistantMessageEvent(
  threadId: ThreadId,
  messageId: string,
  text: string,
): OrchestrationV2DomainEvent {
  return {
    id: nextEventId(),
    threadId,
    occurredAt: T0,
    type: "message.updated",
    payload: {
      id: MessageId.make(messageId),
      threadId,
      runId: run1Id,
      nodeId: null,
      role: "assistant",
      text,
      attachments: [],
      streaming: true,
      createdAt: T0,
      updatedAt: T0,
      createdBy: "agent",
      creationSource: "server",
    },
  };
}

describe("ThreadProgressState", () => {
  it("starts tracking on a live subagent, ignores non-live untracked subagents, and requests clear only if recorded", () => {
    const state = createThreadProgressState();

    // Terminal subagent on an untracked thread does nothing.
    expect(
      applyDomainEventToThreadProgress(
        state,
        subagentEvent({ id: sub1Id, threadId: parentId, status: "completed" }),
        0,
      ),
    ).toEqual({ wakeup: false });
    expect(state.threads.size).toBe(0);

    // Live subagent starts tracking; finishing before anything was recorded drops without clear.
    expect(
      applyDomainEventToThreadProgress(
        state,
        subagentEvent({
          id: sub1Id,
          threadId: parentId,
          status: "running",
          childThreadId: child1Id,
        }),
        1_000,
      ),
    ).toEqual({ wakeup: true });
    expect(state.threads.has(parentId)).toBe(true);
    expect(state.childToParent.has(child1Id)).toBe(true);

    expect(
      applyDomainEventToThreadProgress(
        state,
        subagentEvent({
          id: sub1Id,
          threadId: parentId,
          status: "completed",
          childThreadId: child1Id,
        }),
        5_000,
      ),
    ).toEqual({ wakeup: false });
    expect(state.threads.size).toBe(0);
    expect(state.childToParent.size).toBe(0);

    // When recorded, ending the last live subagent requests a clear.
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({ id: sub1Id, threadId: parentId, status: "running", childThreadId: child1Id }),
      10_000,
    );
    beginGeneration(state, parentId);
    recordGenerationResult(state, parentId, "Running tests", [
      { subagentId: sub1Id, line: "Running auth tests" },
    ]);
    finishGeneration(state, parentId, 30_000);

    expect(
      applyDomainEventToThreadProgress(
        state,
        subagentEvent({
          id: sub1Id,
          threadId: parentId,
          status: "completed",
          childThreadId: child1Id,
        }),
        40_000,
      ),
    ).toEqual({ clearThreadId: parentId, wakeup: false });
    expect(state.threads.size).toBe(0);
  });

  it("replaces ring buffer entries in place for the same item/message and caps at 12", () => {
    const state = createThreadProgressState();
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({ id: sub1Id, threadId: parentId, status: "running", childThreadId: child1Id }),
      0,
    );

    // Streaming updates to the same message replace in place, and the thread is already dirty,
    // so its due time does not move and the scheduler is left asleep.
    expect(
      applyDomainEventToThreadProgress(
        state,
        assistantMessageEvent(child1Id, "m1", "Checking"),
        100,
      ),
    ).toEqual({ wakeup: false });
    applyDomainEventToThreadProgress(
      state,
      assistantMessageEvent(child1Id, "m1", "Checking auth middleware"),
      200,
    );
    // The same reply as a turn item writes the entry its message wrote.
    applyDomainEventToThreadProgress(
      state,
      {
        ...commandItemEvent(child1Id, "item-m1", "unused"),
        payload: {
          ...commandItemEvent(child1Id, "item-m1", "unused").payload,
          type: "assistant_message",
          messageId: MessageId.make("m1"),
          text: "Checking auth middleware and its tests",
        },
      } as OrchestrationV2DomainEvent,
      250,
    );
    expect(state.threads.get(parentId)!.subagents.get(sub1Id)!.activity).toEqual([
      { key: "message:m1", line: "assistant: Checking auth middleware and its tests" },
    ]);

    // Updating the same command item replaces in place; 15 distinct items cap to 12.
    applyDomainEventToThreadProgress(
      state,
      commandItemEvent(child1Id, "cmd-0", "vp test", "running"),
      300,
    );
    applyDomainEventToThreadProgress(
      state,
      commandItemEvent(child1Id, "cmd-0", "vp test", "failed"),
      400,
    );
    for (let i = 1; i <= 14; i += 1) {
      applyDomainEventToThreadProgress(
        state,
        commandItemEvent(child1Id, `cmd-${i}`, `echo step-${i}`, "completed"),
        400 + i,
      );
    }

    const subagent = state.threads.get(parentId)!.subagents.get(sub1Id)!;
    expect(subagent.activity).toHaveLength(THREAD_PROGRESS_RING_BUFFER_MAX);
    expect(subagent.activity[0]!.key).toBe("item:cmd-3");
    expect(subagent.activity.at(-1)!.line).toBe("command_execution: echo step-14");
  });

  it("tracks todo counts, workflow snapshots, and remote-only subagents in prompt snapshots", () => {
    const state = createThreadProgressState();
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({
        id: sub1Id,
        threadId: parentId,
        status: "running",
        childThreadId: child1Id,
        title: "Test fixer",
      }),
      1_000,
    );
    applyDomainEventToThreadProgress(
      state,
      todoItemEvent(child1Id, [
        { text: "Reproduce flake", status: "completed" },
        { text: "Fix cookie race", status: "running" },
        { text: "Rerun suite", status: "pending" },
      ]),
      2_000,
    );
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({
        id: sub2Id,
        threadId: parentId,
        status: "running",
        title: "Remote runner",
        progress: "Building Docker image",
        remoteChild: {
          environmentId: "env-remote" as never,
          threadId: ThreadId.make("remote-thread"),
          label: "vps",
        },
      }),
      3_000,
    );
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({
        id: sub3Id,
        threadId: parentId,
        status: "running",
        title: "Release workflow",
        workflow: {
          name: "Release checks",
          phases: [
            { index: 0, title: "Lint" },
            { index: 1, title: "Test" },
          ],
          agents: [
            { index: 0, label: "linter", state: "completed", phaseIndex: 0 },
            { index: 1, label: "unit-tests", state: "running", phaseIndex: 1 },
          ],
        },
      }),
      4_000,
    );

    const snapshot = buildPromptSnapshotForThread(state, parentId, {
      activityRunStatus: null,
      status: "completed",
    })!;
    expect(snapshot.promptInput.mainAgent.status).toBe("waiting on subagents");
    expect(snapshot.promptInput.subagents.map((s) => s.task)).toEqual([
      "Release workflow",
      "Remote runner",
      "Test fixer",
    ]);
    expect(snapshot.promptInput.subagents[0]!.recentActivity).toContain("workflow: Release checks");
    expect(snapshot.promptInput.subagents[0]!.recentActivity).toContain(
      "members: 1 running, 1 done, 0 failed",
    );
    expect(snapshot.promptInput.subagents[0]!.recentActivity).toContain(
      "running members: unit-tests",
    );
    expect(snapshot.promptInput.subagents[0]!.recentActivity).toContain("phase 1 Lint: done (1/1)");
    expect(snapshot.promptInput.subagents[0]!.recentActivity).toContain(
      "phase 2 Test: running (0/1)",
    );
    expect(snapshot.promptInput.subagents[1]!.recentActivity).toEqual(["Building Docker image"]);
    expect(snapshot.promptInput.subagents[2]!.todo).toEqual({ done: 1, total: 3 });
  });

  it("enforces 20s initial delay, 60s normal refresh, 15s significant refresh, dirty gate, and 2-in-flight cap", () => {
    const state = createThreadProgressState();
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({ id: sub1Id, threadId: parentId, status: "running", childThreadId: child1Id }),
      0,
    );
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({ id: sub2Id, threadId: parentId, status: "running", childThreadId: child2Id }),
      1_000,
    );

    // Not due before 20 s.
    expect(dueThreadIds(state, THREAD_PROGRESS_INITIAL_DELAY_MS - 1)).toEqual([]);
    expect(nextDueAtMs(state)).toBe(THREAD_PROGRESS_INITIAL_DELAY_MS);
    expect(dueThreadIds(state, THREAD_PROGRESS_INITIAL_DELAY_MS)).toEqual([parentId]);

    // After generating, nothing is due without new activity (no heartbeat).
    expect(beginGeneration(state, parentId)).toBe(true);
    finishGeneration(state, parentId, 20_000);
    expect(dueThreadIds(state, 500_000)).toEqual([]);
    expect(nextDueAtMs(state)).toBeNull();

    // Ordinary activity waits 60 s from lastGeneratedAt.
    applyDomainEventToThreadProgress(
      state,
      commandItemEvent(child1Id, "cmd-1", "vp test", "running"),
      25_000,
    );
    expect(dueThreadIds(state, 20_000 + THREAD_PROGRESS_REFRESH_INTERVAL_MS - 1)).toEqual([]);
    expect(dueThreadIds(state, 20_000 + THREAD_PROGRESS_REFRESH_INTERVAL_MS)).toEqual([parentId]);

    // A subagent ending marks significant -> due 15 s after lastGeneratedAt.
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({
        id: sub2Id,
        threadId: parentId,
        status: "completed",
        childThreadId: child2Id,
      }),
      26_000,
    );
    expect(dueThreadIds(state, 20_000 + THREAD_PROGRESS_SIGNIFICANT_INTERVAL_MS - 1)).toEqual([]);
    expect(dueThreadIds(state, 20_000 + THREAD_PROGRESS_SIGNIFICANT_INTERVAL_MS)).toEqual([
      parentId,
    ]);

    // At most 2 generations in flight across all threads.
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({ id: NodeId.make("p2-sub"), threadId: parent2Id, status: "running" }),
      0,
    );
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({ id: NodeId.make("p3-sub"), threadId: parent3Id, status: "running" }),
      0,
    );
    const firstBatch = dueThreadIds(state, 40_000);
    expect(firstBatch).toHaveLength(2);
    for (const id of firstBatch) beginGeneration(state, id);
    expect(dueThreadIds(state, 100_000)).toEqual([]);
    expect(nextDueAtMs(state)).toBeNull();

    // Finishing one frees a slot for the 3rd thread.
    finishGeneration(state, firstBatch[0]!, 41_000);
    expect(dueThreadIds(state, 41_000)).toHaveLength(1);
  });

  it("marks dirty on a new run id and drops tracking on archive or delete", () => {
    const state = createThreadProgressState();
    applyDomainEventToThreadProgress(
      state,
      subagentEvent({ id: sub1Id, threadId: parentId, status: "running" }),
      0,
    );
    beginGeneration(state, parentId);
    finishGeneration(state, parentId, 20_000);
    expect(state.threads.get(parentId)!.dirty).toBe(false);

    applyDomainEventToThreadProgress(
      state,
      {
        id: nextEventId(),
        threadId: parentId,
        occurredAt: T0,
        type: "run.updated",
        payload: {
          id: run2Id,
          threadId: parentId,
          ordinal: 2,
          providerInstanceId,
          modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
          providerThreadId: null,
          userMessageId: MessageId.make("u2"),
          rootNodeId: NodeId.make("root-2"),
          activeAttemptId: null,
          status: "running",
          requestedAt: T0,
          startedAt: T0,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      },
      25_000,
    );
    expect(state.threads.get(parentId)!.dirty).toBe(true);
    // A line for the earlier run is hidden, so the next one comes on the short interval.
    expect(state.threads.get(parentId)!.significant).toBe(true);

    applyDomainEventToThreadProgress(
      state,
      {
        id: nextEventId(),
        threadId: parentId,
        occurredAt: T0,
        type: "thread.archived",
        payload: {} as never,
      },
      30_000,
    );
    expect(state.threads.has(parentId)).toBe(false);
  });
});
