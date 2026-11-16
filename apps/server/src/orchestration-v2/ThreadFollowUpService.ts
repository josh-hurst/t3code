import {
  CommandId,
  type ServerSettingsError,
  THREAD_FOLLOW_UP_AFTER_PUBLISH_MINUTES,
  THREAD_FOLLOW_UP_QUESTION_MAX,
  THREAD_FOLLOW_UP_REASON_MAX,
  threadFollowUpIsArmed,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerSettings from "../serverSettings.ts";
import type * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const ThreadFollowUpProblem = Schema.Literals([
  "not-own-thread",
  "needs-question",
  "needs-reason",
  "needs-one-time",
  "invalid-time",
]);

export class ThreadFollowUpRequestError extends Schema.TaggedError<ThreadFollowUpRequestError>()(
  "ThreadFollowUpRequestError",
  { threadId: ThreadId, problem: ThreadFollowUpProblem },
) {
  override get message(): string {
    switch (this.problem) {
      case "not-own-thread":
        return "An agent can schedule a re-check only in its own thread.";
      case "needs-question":
        return `check_later needs a question of at most ${THREAD_FOLLOW_UP_QUESTION_MAX} characters.`;
      case "needs-reason":
        return `check_later needs a reason of at most ${THREAD_FOLLOW_UP_REASON_MAX} characters.`;
      case "needs-one-time":
        return "check_later needs exactly one of at, inMinutes and afterPublish.";
      case "invalid-time":
        return "check_later's at is not a valid time.";
    }
  }
}

type DispatchError =
  | Orchestrator.OrchestratorV2Error
  | ThreadManagement.ThreadManagementProviderInstanceDisabledError;

export class ThreadFollowUpService extends Context.Service<
  ThreadFollowUpService,
  {
    /** An agent asks its own thread `question` again later. The decider enforces the cap. */
    readonly arm: (input: {
      readonly commandId: CommandId;
      readonly threadId: ThreadId;
      readonly callerThreadId: ThreadId | null;
      readonly at?: string | undefined;
      readonly inMinutes?: number | undefined;
      readonly afterPublish?: boolean | undefined;
      readonly question?: string | undefined;
      readonly reason?: string | undefined;
    }) => Effect.Effect<
      { readonly checkAt: string | null; readonly recheck: number; readonly limit: number },
      ThreadFollowUpRequestError | DispatchError | ServerSettingsError
    >;
    /** Gives every follow-up waiting for a publish in these projects its time. */
    readonly releaseForProjects: (
      projectIds: ReadonlyArray<ProjectId>,
      now: DateTime.Utc,
    ) => Effect.Effect<number, DispatchError | ProjectionStore.ProjectionStoreV2Error>;
  }
>()("t3/orchestration-v2/ThreadFollowUpService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const arm: ThreadFollowUpService["Service"]["arm"] = Effect.fn("ThreadFollowUpService.arm")(
    function* (input) {
      const refuse = (problem: typeof ThreadFollowUpProblem.Type) =>
        new ThreadFollowUpRequestError({ threadId: input.threadId, problem });
      if (input.callerThreadId !== input.threadId) return yield* refuse("not-own-thread");
      const question = input.question?.trim() ?? "";
      if (question.length === 0 || question.length > THREAD_FOLLOW_UP_QUESTION_MAX) {
        return yield* refuse("needs-question");
      }
      const reason = input.reason?.trim() ?? "";
      if (reason.length === 0 || reason.length > THREAD_FOLLOW_UP_REASON_MAX) {
        return yield* refuse("needs-reason");
      }
      const times = [input.at, input.inMinutes, input.afterPublish === true ? true : undefined];
      if (times.filter((time) => time !== undefined).length !== 1) {
        return yield* refuse("needs-one-time");
      }
      const now = yield* DateTime.now;
      let dueAt: string | undefined;
      if (input.at !== undefined) {
        const atMs = Date.parse(input.at);
        if (!Number.isFinite(atMs)) return yield* refuse("invalid-time");
        dueAt = DateTime.formatIso(DateTime.makeUnsafe(atMs));
      } else if (input.inMinutes !== undefined) {
        dueAt = DateTime.formatIso(DateTime.add(now, { minutes: input.inMinutes }));
      }
      const { laterRecheckLimit: limit } = yield* settings.getSettings;
      yield* threads.dispatch({
        type: "thread.follow-up.set",
        commandId: input.commandId,
        threadId: input.threadId,
        question,
        reason,
        ...(dueAt === undefined
          ? { afterPublishMinutes: THREAD_FOLLOW_UP_AFTER_PUBLISH_MINUTES }
          : { dueAt }),
        // Agents never arm as the user: the cap and the minimum delay are the decider's.
        armedBy: "agent",
        limit,
      });
      const shell = yield* threads.getThreadShell(input.threadId);
      return {
        checkAt: shell?.followUp?.dueAt ?? dueAt ?? null,
        recheck: shell?.followUp?.quietCount ?? 0,
        limit,
      };
    },
  );

  const releaseForProjects: ThreadFollowUpService["Service"]["releaseForProjects"] = Effect.fn(
    "ThreadFollowUpService.releaseForProjects",
  )(function* (projectIds, now) {
    const projects = new Set(projectIds);
    const waiting = (yield* projections.getFollowUps()).flatMap(({ thread }) =>
      projects.has(thread.projectId) &&
      thread.followUp != null &&
      threadFollowUpIsArmed(thread.followUp) &&
      thread.followUp.dueAt === null
        ? [{ threadId: thread.id, followUp: thread.followUp }]
        : [],
    );
    for (const { threadId, followUp } of waiting) {
      yield* threads.dispatch({
        type: "thread.follow-up.release",
        commandId: CommandId.make(`later-release:${threadId}:${Date.parse(followUp.armedAt)}`),
        threadId,
        dueAt: DateTime.formatIso(
          DateTime.add(now, { minutes: followUp.afterPublishMinutes ?? 0 }),
        ),
      });
    }
    return waiting.length;
  });

  return ThreadFollowUpService.of({ arm, releaseForProjects });
});

export const layer = Layer.effect(ThreadFollowUpService, make);
