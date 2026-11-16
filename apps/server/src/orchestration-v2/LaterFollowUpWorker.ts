import {
  CommandId,
  threadFollowUpIsArmed,
  type OrchestrationV2DomainEvent,
  type ProjectId,
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
import { followUpMessageIds, followUpPrompt } from "./ThreadFollowUp.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/**
 * What one sweep does. Overdue follow-ups are never skipped, however late, but a project sends
 * one at a time: after sleep several can be due at once, and they share one checkout.
 */
export function planFollowUpSweep(
  rows: ReadonlyArray<ProjectionStore.ProjectionFollowUpRow>,
  nowMs: number,
): {
  readonly send: ReadonlyArray<ProjectionStore.ProjectionFollowUpRow>;
  readonly clear: ReadonlyArray<ProjectionStore.ProjectionFollowUpRow>;
  /** The next future due time; a waiting project wakes the sweep through its run's events. */
  readonly wakeAt: number | null;
} {
  const busy = new Set<ProjectId>(
    rows.flatMap((row) =>
      row.runActive && row.thread.followUp?.sentAt !== undefined ? [row.thread.projectId] : [],
    ),
  );
  const armed = rows.flatMap((row) => {
    const dueAt = row.thread.followUp?.dueAt;
    return threadFollowUpIsArmed(row.thread.followUp) && dueAt != null
      ? [{ row, dueMs: Date.parse(dueAt) }]
      : [];
  });
  const send: Array<ProjectionStore.ProjectionFollowUpRow> = [];
  const clear: Array<ProjectionStore.ProjectionFollowUpRow> = [];
  for (const { row } of armed
    .filter(({ dueMs }) => dueMs <= nowMs)
    .toSorted((left, right) => left.dueMs - right.dueMs)) {
    if (row.thread.settledOverride === "settled") {
      clear.push(row);
    } else if (!busy.has(row.thread.projectId)) {
      busy.add(row.thread.projectId);
      send.push(row);
    }
  }
  const future = armed.flatMap(({ dueMs }) => (dueMs > nowMs ? [dueMs] : []));
  return { send, clear, wakeAt: future.length === 0 ? null : Math.min(...future) };
}

// Thread changes arm, cancel and settle follow-ups; run updates free a waiting project.
const affectsFollowUps = (event: OrchestrationV2DomainEvent) =>
  event.type.startsWith("thread.") || event.type === "run.updated";

const makeSweep = Effect.gen(function* () {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const settings = yield* ServerSettings.ServerSettingsService;
  const due = DueHint.make();
  yield* forkParked(
    Stream.runForEach(orchestrator.streamDomainEvents, (event) =>
      affectsFollowUps(event) ? due.invalidate : Effect.void,
    ),
  );
  yield* forkParked(Stream.runForEach(settings.streamChanges, () => due.invalidate));

  const clearFollowUp = (row: ProjectionStore.ProjectionFollowUpRow, cause: string) =>
    threads
      .dispatch({
        type: "thread.follow-up.clear",
        commandId: CommandId.make(
          `later-follow-up-${cause}:${row.thread.id}:${Date.parse(row.thread.followUp?.armedAt ?? "")}`,
        ),
        threadId: row.thread.id,
      })
      .pipe(
        Effect.catchCause((failure) =>
          Effect.logWarning("orchestration-v2.later-follow-up.clear-failed", {
            threadId: row.thread.id,
            cause: failure,
          }),
        ),
      );

  return Effect.fn("LaterFollowUpWorker.sweep")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    if (yield* due.isIdle(nowMs)) return;
    const readVersion = yield* due.version;
    const plan = planFollowUpSweep(yield* projections.getFollowUps(), nowMs);
    for (const row of plan.clear) yield* clearFollowUp(row, "settled");
    if (plan.send.length > 0) {
      const { laterRecheckLimit } = yield* settings.getSettings;
      for (const row of plan.send) {
        const followUp = row.thread.followUp;
        if (followUp == null) continue;
        yield* threads
          .sendToThread({
            projectId: row.thread.projectId,
            threadId: row.thread.id,
            ...followUpMessageIds(row.thread.id, followUp),
            text: followUpPrompt(followUp, laterRecheckLimit),
            attachments: [],
            mode: "queue",
            followUp: true,
            createdBy: "agent",
            creationSource: "server",
          })
          .pipe(
            // A refused send is recorded under its fixed id and would refuse again every tick,
            // so the follow-up ends and the thread leaves Later.
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                yield* Effect.logWarning("orchestration-v2.later-follow-up.send-failed", {
                  threadId: row.thread.id,
                  cause,
                });
                // A failure after the send committed leaves it sent; clearing it would reset the cap.
                const current = yield* projections
                  .getThread(row.thread.id)
                  .pipe(Effect.orElseSucceed(() => null));
                if (
                  threadFollowUpIsArmed(current?.followUp) &&
                  current?.followUp?.armedAt === followUp.armedAt
                ) {
                  yield* clearFollowUp(row, "failed");
                }
              }),
            ),
          );
      }
    }
    // A sweep that acted re-checks on the next tick.
    if (plan.send.length > 0 || plan.clear.length > 0) return;
    yield* due.record(readVersion, plan.wakeAt ?? Infinity, nowMs);
  });
});

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const sweep = yield* makeSweep;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("later-follow-up", sweep());
  }),
);
