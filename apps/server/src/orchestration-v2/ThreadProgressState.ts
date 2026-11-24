import {
  isOrchestrationV2WorkActive,
  THREAD_PROGRESS_AGENTS_MAX,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Subagent,
  type OrchestrationV2SubagentWorkflow,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type RunId,
  type ThreadId,
  type ThreadProgressAgent,
} from "@t3tools/contracts";

import type {
  ThreadProgressPromptInput,
  ThreadProgressPromptSubagent,
} from "../textGeneration/ThreadProgress.ts";

export const THREAD_PROGRESS_RING_BUFFER_MAX = 8;
const THREAD_PROGRESS_ACTIVITY_LINE_MAX = 160;
const THREAD_PROGRESS_SUBAGENT_TASK_MAX = 300;
export const THREAD_PROGRESS_INITIAL_DELAY_MS = 30_000;
export const THREAD_PROGRESS_REFRESH_INTERVAL_MS = 180_000;
export const THREAD_PROGRESS_SIGNIFICANT_INTERVAL_MS = 45_000;
const THREAD_PROGRESS_MAX_IN_FLIGHT = 2;

export interface ProgressActivityEntry {
  readonly key: string;
  readonly line: string;
}

export interface TrackedSubagentTodo {
  readonly done: number;
  readonly total: number;
  readonly runningStep: string | null;
}

export interface TrackedSubagentProgress {
  readonly id: NodeId;
  childThreadId: ThreadId | null;
  task: string;
  status: OrchestrationV2Subagent["status"];
  rawProgress: string | null;
  workflow: OrchestrationV2SubagentWorkflow | null;
  todo: TrackedSubagentTodo | null;
  readonly activity: Array<ProgressActivityEntry>;
  lastActivityAtMs: number;
  lastRecordedLine: string | null;
  isRemoteOnly: boolean;
}

export interface TrackedParentThreadProgress {
  readonly threadId: ThreadId;
  latestRunId: RunId | null;
  readonly subagents: Map<NodeId, TrackedSubagentProgress>;
  readonly mainActivity: Array<ProgressActivityEntry>;
  dirty: boolean;
  significant: boolean;
  firstLiveAtMs: number;
  lastGeneratedAtMs: number | null;
  inFlight: boolean;
  recorded: boolean;
  lastThreadLine: string | null;
}

export interface ThreadProgressTrackerState {
  readonly threads: Map<ThreadId, TrackedParentThreadProgress>;
  readonly childToParent: Map<
    ThreadId,
    { readonly parentThreadId: ThreadId; readonly subagentId: NodeId }
  >;
}

export interface ThreadProgressApplyResult {
  readonly clearThreadId?: ThreadId;
  readonly wakeup: boolean;
}

export function createThreadProgressState(): ThreadProgressTrackerState {
  return {
    threads: new Map(),
    childToParent: new Map(),
  };
}

function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function clipHead(text: string, maxChars: number): string {
  const normalized = collapseWhitespace(text);
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

// Runs per streaming delta, so only the end of a long message is ever scanned.
function clipTail(text: string, maxChars: number): string {
  const normalized = collapseWhitespace(text.slice(-maxChars * 4));
  if (normalized.length <= maxChars && text.length <= maxChars * 4) return normalized;
  return `…${normalized.slice(-(maxChars - 1)).trimStart()}`;
}

/** An assistant message arrives as a message and as a turn item; both write one entry. */
function assistantDigest(text: string): string | null {
  const prefix = "assistant: ";
  const tail = clipTail(text, THREAD_PROGRESS_ACTIVITY_LINE_MAX - prefix.length);
  return tail === "" || tail === "…" ? null : `${prefix}${tail}`;
}

function firstNonEmptyLine(text: string): string {
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed !== "") return trimmed;
  }
  return "";
}

function upsertRingBuffer(
  buffer: Array<ProgressActivityEntry>,
  key: string,
  rawLine: string,
): boolean {
  const line = clipHead(rawLine, THREAD_PROGRESS_ACTIVITY_LINE_MAX);
  if (line === "") return false;
  const existingIndex = buffer.findIndex((entry) => entry.key === key);
  if (existingIndex !== -1) {
    if (buffer[existingIndex]!.line === line) return false;
    buffer[existingIndex] = { key, line };
    return true;
  }
  buffer.push({ key, line });
  while (buffer.length > THREAD_PROGRESS_RING_BUFFER_MAX) {
    buffer.shift();
  }
  return true;
}

function statusTag(status: OrchestrationV2TurnItem["status"], failedExtra = false): string {
  if (status === "running") return " (running)";
  if (status === "failed" || failedExtra) return " (failed)";
  return "";
}

function digestTurnItem(item: OrchestrationV2TurnItem): {
  readonly line: string | null;
  readonly key?: string;
  readonly todo?: TrackedSubagentTodo | null;
} {
  switch (item.type) {
    case "todo_list": {
      const total = item.steps.length;
      const done = item.steps.filter((step) => step.status === "completed").length;
      const runningStep = item.steps.find((step) => step.status === "running")?.text ?? null;
      const todo: TrackedSubagentTodo | null = total > 0 ? { done, total, runningStep } : null;
      const suffix = runningStep ? `; now: ${runningStep}` : "";
      return {
        line: total > 0 ? `todo_list: ${done}/${total} done${suffix}` : null,
        todo,
      };
    }
    case "command_execution": {
      const label = item.title?.trim() || firstNonEmptyLine(item.input) || "command";
      const failed =
        item.outputIndicatesFailure === true ||
        (item.exitCode !== undefined && item.exitCode !== 0);
      return { line: `command_execution: ${label}${statusTag(item.status, failed)}` };
    }
    case "file_change": {
      const label = item.title?.trim() || item.fileName;
      return { line: `file_change: ${label}${statusTag(item.status)}` };
    }
    case "file_search": {
      const label = item.title?.trim() || item.pattern?.trim() || "search";
      return { line: `file_search: ${label}${statusTag(item.status)}` };
    }
    case "web_search": {
      const label = item.title?.trim() || item.patterns?.join(", ") || "search";
      return { line: `web_search: ${label}${statusTag(item.status)}` };
    }
    case "dynamic_tool": {
      const label = item.title?.trim() || item.toolName || "tool";
      return { line: `dynamic_tool: ${label}${statusTag(item.status)}` };
    }
    case "assistant_message":
      return { line: assistantDigest(item.text), key: `message:${item.messageId}` };
    case "subagent": {
      const label = item.title?.trim() || clipHead(item.prompt, 80) || "subagent";
      return { line: `subagent: ${label}${statusTag(item.status)}` };
    }
    case "error":
      return { line: `error: ${item.failure.message}` };
    case "approval_request": {
      const label = item.title?.trim() || item.prompt?.trim() || item.requestKind;
      return { line: `approval_request: ${label}${statusTag(item.status)}` };
    }
    case "user_input_request": {
      const label = item.title?.trim() || item.questions[0]?.question || "question";
      return { line: `user_input_request: ${label}${statusTag(item.status)}` };
    }
    case "proposed_plan": {
      const label = item.title?.trim() || "plan";
      return { line: `proposed_plan: ${label}${statusTag(item.status)}` };
    }
    case "reasoning":
    case "user_message":
    case "notification":
    case "checkpoint":
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
    case "compaction":
    case "handoff":
    case "fork":
    case "thread_created":
    case "secret_request":
    case "link_request":
    case "feedback_request":
      return { line: null };
  }
}

export function dropTrackedThread(state: ThreadProgressTrackerState, threadId: ThreadId): boolean {
  const tracked = state.threads.get(threadId);
  if (tracked === undefined) return false;
  state.threads.delete(threadId);
  for (const subagent of tracked.subagents.values()) {
    if (subagent.childThreadId !== null) {
      const link = state.childToParent.get(subagent.childThreadId);
      if (link?.parentThreadId === threadId) {
        state.childToParent.delete(subagent.childThreadId);
      }
    }
  }
  return true;
}

export function hasLiveSubagent(state: ThreadProgressTrackerState, threadId: ThreadId): boolean {
  const tracked = state.threads.get(threadId);
  if (tracked === undefined) return false;
  return trackedHasLiveSubagent(tracked);
}

function trackedHasLiveSubagent(tracked: TrackedParentThreadProgress): boolean {
  for (const subagent of tracked.subagents.values()) {
    if (isOrchestrationV2WorkActive(subagent.status)) return true;
  }
  return false;
}

/** Whether the thread's due time moved; activity on an already-dirty thread changes nothing. */
function markDirty(tracked: TrackedParentThreadProgress, significant = false): boolean {
  const moved = !tracked.dirty || (significant && !tracked.significant);
  tracked.dirty = true;
  if (significant) tracked.significant = true;
  return moved;
}

export function applyDomainEventToThreadProgress(
  state: ThreadProgressTrackerState,
  event: OrchestrationV2DomainEvent,
  nowMs: number,
): ThreadProgressApplyResult {
  switch (event.type) {
    case "subagent.updated": {
      const subagent = event.payload;
      const parentThreadId = subagent.threadId;
      const live = isOrchestrationV2WorkActive(subagent.status);
      let tracked = state.threads.get(parentThreadId);
      if (tracked === undefined) {
        if (!live) return { wakeup: false };
        tracked = {
          threadId: parentThreadId,
          latestRunId: subagent.runId,
          subagents: new Map(),
          mainActivity: [],
          dirty: false,
          significant: false,
          firstLiveAtMs: nowMs,
          lastGeneratedAtMs: null,
          inFlight: false,
          recorded: false,
          lastThreadLine: null,
        };
        state.threads.set(parentThreadId, tracked);
      }

      const previous = tracked.subagents.get(subagent.id);
      const wasLive = previous !== undefined && isOrchestrationV2WorkActive(previous.status);
      const titleText = subagent.title?.trim() ?? "";
      const promptText = subagent.promptOmitted === true ? "" : subagent.prompt.trim();
      const task =
        titleText !== ""
          ? clipHead(titleText, THREAD_PROGRESS_SUBAGENT_TASK_MAX)
          : promptText !== ""
            ? clipHead(promptText, THREAD_PROGRESS_SUBAGENT_TASK_MAX)
            : (previous?.task ?? "subagent");
      const rawProgress = subagent.progress?.trim() || null;
      const isRemoteOnly = subagent.remoteChild !== undefined && subagent.childThreadId === null;

      if (previous === undefined) {
        tracked.subagents.set(subagent.id, {
          id: subagent.id,
          childThreadId: subagent.childThreadId,
          task,
          status: subagent.status,
          rawProgress,
          workflow: subagent.workflow ?? null,
          todo: null,
          activity: [],
          lastActivityAtMs: nowMs,
          lastRecordedLine: null,
          isRemoteOnly,
        });
      } else {
        if (previous.childThreadId !== null && previous.childThreadId !== subagent.childThreadId) {
          state.childToParent.delete(previous.childThreadId);
        }
        previous.childThreadId = subagent.childThreadId;
        previous.task = task;
        previous.status = subagent.status;
        previous.rawProgress = rawProgress;
        if (subagent.workflow !== undefined) previous.workflow = subagent.workflow;
        previous.lastActivityAtMs = nowMs;
        previous.isRemoteOnly = isRemoteOnly;
      }

      if (subagent.childThreadId !== null) {
        state.childToParent.set(subagent.childThreadId, {
          parentThreadId,
          subagentId: subagent.id,
        });
      }

      const ended = wasLive && !live;
      const wakeup = markDirty(tracked, ended);

      if (!trackedHasLiveSubagent(tracked)) {
        const shouldClear = tracked.recorded;
        dropTrackedThread(state, parentThreadId);
        return shouldClear ? { clearThreadId: parentThreadId, wakeup: false } : { wakeup: false };
      }

      return { wakeup };
    }

    case "turn-item.updated": {
      const trackedParent = state.threads.get(event.threadId);
      const childLink = state.childToParent.get(event.threadId);
      if (trackedParent === undefined && childLink === undefined) {
        return { wakeup: false };
      }

      const digested = digestTurnItem(event.payload);
      const key = digested.key ?? `item:${event.payload.id}`;
      // Streaming prose updates the ring buffer for the next refresh, but does not schedule one on its own.
      const wakes = !(
        event.payload.type === "assistant_message" && event.payload.status === "running"
      );
      let woke = false;

      if (trackedParent !== undefined && digested.line !== null) {
        if (upsertRingBuffer(trackedParent.mainActivity, key, digested.line) && wakes) {
          woke = markDirty(trackedParent) || woke;
        }
      }

      if (childLink !== undefined) {
        const parent = state.threads.get(childLink.parentThreadId);
        const subagent = parent?.subagents.get(childLink.subagentId);
        if (parent !== undefined && subagent !== undefined) {
          let changed = false;
          if (digested.todo !== undefined) {
            const prevTodo = subagent.todo;
            if (
              prevTodo?.done !== digested.todo?.done ||
              prevTodo?.total !== digested.todo?.total ||
              prevTodo?.runningStep !== digested.todo?.runningStep
            ) {
              subagent.todo = digested.todo;
              changed = true;
            }
          }
          if (digested.line !== null && upsertRingBuffer(subagent.activity, key, digested.line)) {
            changed = true;
          }
          if (changed) {
            subagent.lastActivityAtMs = nowMs;
            if (wakes) woke = markDirty(parent) || woke;
          }
        }
      }

      return { wakeup: woke };
    }

    case "message.updated": {
      const trackedParent = state.threads.get(event.threadId);
      const childLink = state.childToParent.get(event.threadId);
      if (trackedParent === undefined && childLink === undefined) {
        return { wakeup: false };
      }
      if (event.payload.role !== "assistant") return { wakeup: false };
      const digest = assistantDigest(event.payload.text);
      if (digest === null) return { wakeup: false };
      // Streaming text deltas keep the buffer fresh without continually scheduling refreshes.
      const wakes = !event.payload.streaming;
      let woke = false;

      if (trackedParent !== undefined) {
        if (upsertRingBuffer(trackedParent.mainActivity, `message:${event.payload.id}`, digest)) {
          if (wakes) woke = markDirty(trackedParent) || woke;
        }
      }

      if (childLink !== undefined) {
        const parent = state.threads.get(childLink.parentThreadId);
        const subagent = parent?.subagents.get(childLink.subagentId);
        if (
          parent !== undefined &&
          subagent !== undefined &&
          upsertRingBuffer(subagent.activity, `message:${event.payload.id}`, digest)
        ) {
          subagent.lastActivityAtMs = nowMs;
          if (wakes) woke = markDirty(parent) || woke;
        }
      }

      return { wakeup: woke };
    }

    case "run.updated": {
      const tracked = state.threads.get(event.threadId);
      if (tracked === undefined) return { wakeup: false };
      if (tracked.latestRunId === event.payload.id) return { wakeup: false };
      tracked.latestRunId = event.payload.id;
      // Clients hide a line written for an earlier run, so its replacement is not left a minute.
      return { wakeup: markDirty(tracked, true) };
    }

    case "thread.deleted":
    case "thread.archived":
      dropTrackedThread(state, event.threadId);
      return { wakeup: false };

    default:
      return { wakeup: false };
  }
}

function threadDueAtMs(tracked: TrackedParentThreadProgress): number | null {
  if (!tracked.dirty || tracked.inFlight || !trackedHasLiveSubagent(tracked)) return null;
  const afterFirstLive = tracked.firstLiveAtMs + THREAD_PROGRESS_INITIAL_DELAY_MS;
  if (tracked.lastGeneratedAtMs === null) return afterFirstLive;
  const interval = tracked.significant
    ? THREAD_PROGRESS_SIGNIFICANT_INTERVAL_MS
    : THREAD_PROGRESS_REFRESH_INTERVAL_MS;
  return Math.max(afterFirstLive, tracked.lastGeneratedAtMs + interval);
}

function inFlightCount(state: ThreadProgressTrackerState): number {
  let count = 0;
  for (const tracked of state.threads.values()) {
    if (tracked.inFlight) count += 1;
  }
  return count;
}

export function dueThreadIds(
  state: ThreadProgressTrackerState,
  nowMs: number,
  maxInFlight = THREAD_PROGRESS_MAX_IN_FLIGHT,
): ReadonlyArray<ThreadId> {
  const slots = maxInFlight - inFlightCount(state);
  if (slots <= 0) return [];
  const candidates: Array<{ readonly threadId: ThreadId; readonly dueAt: number }> = [];
  for (const tracked of state.threads.values()) {
    const dueAt = threadDueAtMs(tracked);
    if (dueAt !== null && dueAt <= nowMs) {
      candidates.push({ threadId: tracked.threadId, dueAt });
    }
  }
  candidates.sort(
    (left, right) => left.dueAt - right.dueAt || left.threadId.localeCompare(right.threadId),
  );
  return candidates.slice(0, slots).map((candidate) => candidate.threadId);
}

export function nextDueAtMs(
  state: ThreadProgressTrackerState,
  maxInFlight = THREAD_PROGRESS_MAX_IN_FLIGHT,
): number | null {
  if (inFlightCount(state) >= maxInFlight) return null;
  let earliest: number | null = null;
  for (const tracked of state.threads.values()) {
    const dueAt = threadDueAtMs(tracked);
    if (dueAt !== null && (earliest === null || dueAt < earliest)) {
      earliest = dueAt;
    }
  }
  return earliest;
}

export function beginGeneration(state: ThreadProgressTrackerState, threadId: ThreadId): boolean {
  const tracked = state.threads.get(threadId);
  if (tracked === undefined || tracked.inFlight || !trackedHasLiveSubagent(tracked)) {
    return false;
  }
  tracked.inFlight = true;
  tracked.dirty = false;
  tracked.significant = false;
  return true;
}

export function recordGenerationResult(
  state: ThreadProgressTrackerState,
  threadId: ThreadId,
  line: string,
  agents: ReadonlyArray<ThreadProgressAgent>,
): void {
  const tracked = state.threads.get(threadId);
  if (tracked === undefined) return;
  tracked.recorded = true;
  tracked.lastThreadLine = line;
  for (const agent of agents) {
    const subagent = tracked.subagents.get(agent.subagentId);
    if (subagent !== undefined) {
      subagent.lastRecordedLine = agent.line;
    }
  }
}

export function finishGeneration(
  state: ThreadProgressTrackerState,
  threadId: ThreadId,
  completedAtMs: number,
): void {
  const tracked = state.threads.get(threadId);
  if (tracked === undefined) return;
  tracked.inFlight = false;
  tracked.lastGeneratedAtMs = completedAtMs;
}

function describeWorkflow(workflow: OrchestrationV2SubagentWorkflow): Array<string> {
  const lines: Array<string> = [];
  if (workflow.name) {
    lines.push(clipHead(`workflow: ${workflow.name}`, THREAD_PROGRESS_ACTIVITY_LINE_MAX));
  }
  let queued = 0;
  let running = 0;
  let done = 0;
  let failed = 0;
  const runningLabels: Array<string> = [];
  for (const agent of workflow.agents) {
    switch (agent.state) {
      case "queued":
        queued += 1;
        break;
      case "running":
        running += 1;
        runningLabels.push(agent.label);
        break;
      case "completed":
        done += 1;
        break;
      case "failed":
        failed += 1;
        break;
    }
  }
  const counts = [
    `${running} running`,
    `${done} done`,
    `${failed} failed`,
    ...(queued > 0 ? [`${queued} queued`] : []),
  ].join(", ");
  lines.push(clipHead(`members: ${counts}`, THREAD_PROGRESS_ACTIVITY_LINE_MAX));
  if (runningLabels.length > 0) {
    lines.push(
      clipHead(`running members: ${runningLabels.join(", ")}`, THREAD_PROGRESS_ACTIVITY_LINE_MAX),
    );
  }
  for (const phase of workflow.phases) {
    const members = workflow.agents.filter((agent) => agent.phaseIndex === phase.index);
    let phaseState = "pending";
    if (members.some((member) => member.state === "running")) phaseState = "running";
    else if (members.some((member) => member.state === "failed")) phaseState = "failed";
    else if (members.length > 0 && members.every((member) => member.state === "completed")) {
      phaseState = "done";
    } else if (members.some((member) => member.state === "queued")) {
      phaseState = "queued";
    }
    const phaseDone = members.filter((member) => member.state === "completed").length;
    const progressSuffix = members.length > 0 ? ` (${phaseDone}/${members.length})` : "";
    lines.push(
      clipHead(
        `phase ${phase.index + 1} ${phase.title}: ${phaseState}${progressSuffix}`,
        THREAD_PROGRESS_ACTIVITY_LINE_MAX,
      ),
    );
  }
  return lines;
}

function subagentActivityForPrompt(subagent: TrackedSubagentProgress): ReadonlyArray<string> {
  if (subagent.isRemoteOnly) {
    return [
      ...(subagent.workflow === null ? [] : describeWorkflow(subagent.workflow)),
      ...(subagent.rawProgress === null
        ? []
        : [clipHead(subagent.rawProgress, THREAD_PROGRESS_ACTIVITY_LINE_MAX)]),
    ];
  }
  const lines: Array<string> = [];
  if (subagent.workflow !== null) {
    lines.push(...describeWorkflow(subagent.workflow));
  }
  for (const entry of subagent.activity) {
    lines.push(entry.line);
  }
  if (subagent.activity.length === 0 && subagent.rawProgress !== null) {
    lines.push(clipHead(subagent.rawProgress, THREAD_PROGRESS_ACTIVITY_LINE_MAX));
  }
  return lines;
}

function mainAgentStatusFromShell(
  shell: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status">,
): string {
  const status = shell.activityRunStatus ?? shell.status;
  if (status === "running") return "working";
  if (status === "preparing" || status === "starting" || status === "queued") return "starting";
  return "waiting on subagents";
}

export function buildPromptSnapshotForThread(
  state: ThreadProgressTrackerState,
  threadId: ThreadId,
  shell: Pick<OrchestrationV2ThreadShell, "activityRunStatus" | "status">,
): {
  readonly promptInput: ThreadProgressPromptInput;
  readonly refToSubagentId: ReadonlyMap<string, NodeId>;
} | null {
  const tracked = state.threads.get(threadId);
  if (tracked === undefined || !trackedHasLiveSubagent(tracked)) return null;

  const selected = Array.from(tracked.subagents.values())
    .sort((left, right) => {
      const leftLive = Number(isOrchestrationV2WorkActive(left.status));
      const rightLive = Number(isOrchestrationV2WorkActive(right.status));
      if (leftLive !== rightLive) return rightLive - leftLive;
      return right.lastActivityAtMs - left.lastActivityAtMs || left.id.localeCompare(right.id);
    })
    .slice(0, THREAD_PROGRESS_AGENTS_MAX);

  const refToSubagentId = new Map<string, NodeId>();
  const subagents: Array<ThreadProgressPromptSubagent> = selected.map((subagent, index) => {
    const ref = `a${index + 1}`;
    refToSubagentId.set(ref, subagent.id);
    return {
      ref,
      status: subagent.status,
      ...(subagent.todo === null
        ? {}
        : { todo: { done: subagent.todo.done, total: subagent.todo.total } }),
      task: subagent.task,
      previousLine: subagent.lastRecordedLine,
      recentActivity: subagentActivityForPrompt(subagent),
    };
  });

  return {
    promptInput: {
      mainAgent: {
        status: mainAgentStatusFromShell(shell),
        recentActivity: tracked.mainActivity.map((entry) => entry.line),
      },
      subagents,
      previousThreadLine: tracked.lastThreadLine,
    },
    refToSubagentId,
  };
}

export function liveSubagentIds(
  state: ThreadProgressTrackerState,
  threadId: ThreadId,
): ReadonlySet<NodeId> {
  const tracked = state.threads.get(threadId);
  const live = new Set<NodeId>();
  if (tracked === undefined) return live;
  for (const subagent of tracked.subagents.values()) {
    if (isOrchestrationV2WorkActive(subagent.status)) live.add(subagent.id);
  }
  return live;
}
