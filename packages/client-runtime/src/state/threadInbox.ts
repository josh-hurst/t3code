import { threadRuntimeIsActive, type EnvironmentThreadShell } from "./models.ts";
import { toSortableTimestamp } from "./threadSort.ts";

type WorkingThreadInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "interactionMode"
  | "latestRun"
  | "runtime"
>;

export function isThreadWorking(thread: WorkingThreadInput): boolean {
  if (thread.hasPendingApprovals || thread.hasPendingUserInput) return false;
  if (thread.pendingSubagentRequest != null) return false;
  if (!threadRuntimeIsActive(thread.runtime) && thread.runtime?.status !== "idle") return false;
  const run = thread.latestRun;
  const runSettled =
    run !== null &&
    run.status !== "preparing" &&
    run.status !== "queued" &&
    run.status !== "starting" &&
    run.status !== "running" &&
    run.status !== "waiting" &&
    thread.runtime?.activeRunId !== run.runId;
  return !(thread.interactionMode === "plan" && thread.hasActionableProposedPlan && runSettled);
}

/**
 * A thread its own client is launching reads as preparing until its first run lands.
 * The server commits the thread before its run, so the list would otherwise place it twice.
 */
export function asLaunchingThread<T extends EnvironmentThreadShell>(thread: T): T {
  if (thread.latestRun !== null || thread.runtime !== null) return thread;
  return {
    ...thread,
    runtime: {
      status: "preparing",
      activeRunId: null,
      providerInstanceId: thread.providerInstanceId,
      providerName: null,
      lastError: null,
      updatedAt: thread.updatedAt,
    },
  };
}

type InboxThreadInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "unsettledAt" | "latestRun"
>;

export function sortInboxThreadsByReturn<T extends InboxThreadInput>(
  threads: readonly T[],
  observedReturnAt?: (thread: T) => number | undefined,
): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(thread.unsettledAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ?? 0,
        toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ?? 0,
        observedReturnAt?.(thread) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

type WorkingSortInput = Pick<
  EnvironmentThreadShell,
  "id" | "environmentId" | "createdAt" | "latestRun" | "latestUserAuthoredMessageAt"
>;

export function sortWorkingThreadsBySend<T extends WorkingSortInput>(threads: readonly T[]): T[] {
  const timestamps = new Map(
    threads.map((thread) => [
      thread,
      Math.max(
        toSortableTimestamp(thread.createdAt) ?? 0,
        toSortableTimestamp(
          (thread.latestUserAuthoredMessageAt === undefined
            ? thread.latestRun?.requestedAt
            : thread.latestUserAuthoredMessageAt) ?? undefined,
        ) ?? 0,
      ),
    ]),
  );
  return sortNewestFirst(threads, timestamps);
}

function sortNewestFirst<T extends Pick<EnvironmentThreadShell, "id" | "environmentId">>(
  threads: readonly T[],
  timestamps: ReadonlyMap<T, number>,
): T[] {
  return [...threads].sort(
    (left, right) =>
      timestamps.get(right)! - timestamps.get(left)! ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

type ThreadKeyInput = Pick<EnvironmentThreadShell, "environmentId" | "id">;

/**
 * Keep one at module scope so the inbox order survives routes that unmount the
 * list. Call `observe` with every thread shell whenever the shells change, or
 * with null to reset while the Working shelf is off. It returns the return times
 * as of that observation, which stay fixed so a list built from them can be cached.
 */
export function createInboxReturnTracker() {
  const keyOf = (thread: ThreadKeyInput) => `${thread.environmentId}:${thread.id}`;
  let lastWorkingKeys: ReadonlySet<string> | null = null;
  const returns = new Map<string, number>();
  return {
    observe(
      threads: ReadonlyArray<WorkingThreadInput & ThreadKeyInput> | null,
    ): (thread: ThreadKeyInput) => number | undefined {
      if (threads === null) {
        lastWorkingKeys = null;
        returns.clear();
        return () => undefined;
      }
      const working = new Set<string>();
      const present = new Set<string>();
      for (const thread of threads) {
        const key = keyOf(thread);
        present.add(key);
        if (isThreadWorking(thread)) working.add(key);
      }
      for (const key of returns.keys()) {
        if (!present.has(key)) returns.delete(key);
      }
      // @effect-diagnostics-next-line globalDate:off - Return order compares wall-clock times across web and native clients.
      const at = Date.now();
      for (const key of lastWorkingKeys ?? []) {
        if (present.has(key) && !working.has(key)) returns.set(key, at);
      }
      lastWorkingKeys = working;
      const observed = new Map(returns);
      return (thread) => observed.get(keyOf(thread));
    },
    returnedAt: (thread: ThreadKeyInput) => returns.get(keyOf(thread)),
  };
}
