import {
  CommandId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
  type ThreadContentsState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as DueHint from "../scheduling/DueHint.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const RUNS_SINCE_REGROUP_DUE = 5;
const SETTLED_REGROUP_EVERY_MS = 24 * 60 * 60 * 1000;
const IDLE_MS = 10 * 60 * 1000;

/**
 * Whether an idle candidate (ten minutes without a reply, long, with runs not yet regrouped) is
 * due. Five new runs make it due; fewer only once the thread is settled and not regrouped in the
 * last day, so a thread the owner checks hourly does not pay three calls after every message.
 */
export function regroupDue(input: {
  readonly state: ThreadContentsState;
  readonly shell: OrchestrationV2ThreadShell | null;
  readonly nowMs: number;
}): boolean {
  const { state, shell } = input;
  if (shell === null || shell.deletedAt !== null) return false;
  if (shell.activeRunId !== null || shell.activityRunStatus != null || shell.status === "queued") {
    return false;
  }
  if (state.runsSinceRegroup >= RUNS_SINCE_REGROUP_DUE) return true;
  // Read as the thread lists read it.
  const settled = shell.settledAt !== null || shell.settledOverride === "settled";
  return (
    state.runsSinceRegroup >= 1 &&
    settled &&
    (state.regroupedAt === null ||
      input.nowMs - Date.parse(state.regroupedAt) > SETTLED_REGROUP_EVERY_MS)
  );
}

// New run lines, settling and a run ending move candidates; nothing else does.
const affectsRegroups = (event: OrchestrationV2DomainEvent) =>
  event.type === "thread.entries-updated" ||
  event.type === "thread.settled" ||
  event.type === "run.updated";

const makeSweep = Effect.gen(function* () {
  const entries = yield* ThreadEntryStore.ThreadEntryStore;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsRegroups(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));

  return Effect.fn("ContentsRegroupWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    if ((yield* settings.getSettings).threadReplySummariesEnabled !== true) {
      return yield* due.record(readVersion, Infinity, nowMs);
    }
    let acted = false;
    for (const candidate of yield* entries.regroupCandidates(now)) {
      const shell = yield* projections.getThreadShell(candidate.threadId);
      if (!regroupDue({ state: candidate.state, shell, nowMs })) continue;
      const requested = yield* threads
        .dispatch({
          type: "thread.contents.regroup.request",
          // One request per state of the contents: a thread made due again at the same run
          // (its regroup failed, or the rules changed) must not replay an old receipt.
          commandId: CommandId.make(
            `contents-regroup-idle:${candidate.threadId}:${candidate.state.lastRunOrdinal}:${candidate.state.revision}`,
          ),
          threadId: candidate.threadId,
          kind: "idle",
        })
        .pipe(
          Effect.as(true),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.contents-regroup.request-failed", {
              threadId: candidate.threadId,
              cause,
            }).pipe(Effect.as(false)),
          ),
        );
      acted ||= requested;
    }
    // A sweep that requested re-checks on the next tick; a failed request waits for the backstop.
    if (acted) return;
    const nextIdle = yield* entries.regroupIdleAt(now);
    yield* due.record(
      readVersion,
      nextIdle === null ? Infinity : DateTime.toEpochMillis(nextIdle) + IDLE_MS,
      nowMs,
    );
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("contents-regroup", sweep());
  }),
);
