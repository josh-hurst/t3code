import {
  CommandId,
  isThreadSetAside,
  MessageId,
  THREAD_FOLLOW_UP_MAX_DELAY_MS,
  THREAD_FOLLOW_UP_MIN_DELAY_MS,
  THREAD_SET_ASIDE_UNTIL,
  threadFollowUpIsArmed,
  type OrchestrationV2AppThread,
  type OrchestrationV2Command,
  type RunId,
  type ThreadFollowUp,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

/** The service reads the clock before the decider does, so a delay at the minimum still passes. */
const FOLLOW_UP_DELAY_GRACE_MS = 60_000;
const SET_ASIDE_UNTIL = DateTime.makeUnsafe(THREAD_SET_ASIDE_UNTIL);

type FollowUpSet = Extract<OrchestrationV2Command, { readonly type: "thread.follow-up.set" }>;

/**
 * The follow-up a set command leaves, and whether it files the thread into Later now. A sent
 * follow-up still on the thread means the owner has not written since, so an agent arming
 * then continues the quiet chain whichever run it arms from.
 */
export function nextFollowUp(input: {
  readonly previous: ThreadFollowUp | null | undefined;
  readonly activeRunId: RunId | null;
  readonly command: FollowUpSet;
  readonly nowMs: number;
}): Result.Result<{ readonly followUp: ThreadFollowUp; readonly files: boolean }, string> {
  const { previous, command, nowMs } = input;
  if ((command.dueAt === undefined) === (command.afterPublishMinutes === undefined)) {
    return Result.fail("A re-check needs exactly one of a time and a publish.");
  }
  if (command.dueAt !== undefined) {
    const dueAtMs = Date.parse(command.dueAt);
    if (!Number.isFinite(dueAtMs) || dueAtMs <= nowMs) {
      return Result.fail(`The re-check time ${command.dueAt} is not in the future.`);
    }
    if (command.armedBy === "agent") {
      const delayMs = dueAtMs - nowMs;
      if (delayMs < THREAD_FOLLOW_UP_MIN_DELAY_MS - FOLLOW_UP_DELAY_GRACE_MS) {
        return Result.fail("A re-check must be at least 10 minutes away.");
      }
      if (delayMs > THREAD_FOLLOW_UP_MAX_DELAY_MS + FOLLOW_UP_DELAY_GRACE_MS) {
        return Result.fail("A re-check must be at most 30 days away.");
      }
    }
  }
  const sent = previous != null && previous.sentAt !== undefined;
  const inFollowUpRun =
    sent && previous.runId !== undefined && previous.runId === input.activeRunId;
  const quietCount =
    command.armedBy === "user" || previous == null
      ? 0
      : sent
        ? previous.quietCount + 1
        : previous.quietCount;
  if (command.armedBy === "agent") {
    if (command.limit === undefined || command.limit === 0) {
      return Result.fail(
        "Agent re-checks are turned off in this environment. Tell the user what you found instead.",
      );
    }
    if (quietCount > command.limit) {
      return Result.fail(
        `This thread has re-checked ${quietCount} times without news. Tell the user what you found instead.`,
      );
    }
  }
  const keepsFiling = previous != null && !sent && previous.filedAt !== undefined;
  return Result.succeed({
    followUp: {
      question: command.question,
      reason: command.reason,
      dueAt: command.dueAt ?? null,
      ...(command.afterPublishMinutes === undefined
        ? {}
        : { afterPublishMinutes: command.afterPublishMinutes }),
      armedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
      armedBy: command.armedBy,
      quietCount,
      ...(keepsFiling ? { filedAt: previous.filedAt } : {}),
    },
    files: inFollowUpRun || command.armedBy === "user",
  });
}

/** Holds the thread in Later until the follow-up sends: its row shows the follow-up's own time. */
export function holdForFollowUp(
  thread: OrchestrationV2AppThread,
  followUp: ThreadFollowUp,
  now: DateTime.Utc,
): OrchestrationV2AppThread {
  return {
    ...thread,
    followUp: { ...followUp, filedAt: DateTime.formatIso(now) },
    snoozedUntil: SET_ASIDE_UNTIL,
    snoozedAt: now,
    limitRecovery: thread.limitRecovery ? { ...thread.limitRecovery, snooze: false } : null,
    updatedAt: isThreadSetAside(thread.snoozedUntil) ? thread.updatedAt : now,
  };
}

/** Ends a set-aside hold, as an unsnooze does. Leaves any other snooze alone. */
export function releaseSetAside(
  thread: OrchestrationV2AppThread,
  now: DateTime.Utc,
): OrchestrationV2AppThread {
  if (!isThreadSetAside(thread.snoozedUntil)) return thread;
  return {
    ...thread,
    snoozedUntil: null,
    snoozedAt: null,
    lastSnoozeWakeAt: now,
    updatedAt: now,
  };
}

/**
 * Ends a follow-up without sending it, keeping its quiet count: only the user writing resets
 * that, so an agent cannot clear a thread and start a fresh chain.
 */
export function spendFollowUp(
  followUp: ThreadFollowUp | null | undefined,
  now: DateTime.Utc,
): ThreadFollowUp | null | undefined {
  return followUp == null || followUp.sentAt !== undefined
    ? followUp
    : { ...followUp, sentAt: DateTime.formatIso(now) };
}

/**
 * A user message keeps an armed follow-up but ends its filing, so an agent re-arming in the
 * reply files afresh; a sent one is done.
 */
export function followUpAfterOwnerMessage(
  followUp: ThreadFollowUp | null | undefined,
): ThreadFollowUp | null | undefined {
  if (followUp == null) return followUp;
  if (!threadFollowUpIsArmed(followUp)) return null;
  if (followUp.quietCount === 0 && followUp.filedAt === undefined) return followUp;
  const { filedAt: _filedAt, ...rest } = followUp;
  return { ...rest, quietCount: 0 };
}

/** Whether reading the thread now files its follow-up into Later. */
export function followUpFilesOnVisit(
  thread: Pick<OrchestrationV2AppThread, "followUp" | "snoozedUntil">,
  nowMs: number,
): boolean {
  const followUp = thread.followUp;
  return (
    threadFollowUpIsArmed(followUp) &&
    followUp?.filedAt === undefined &&
    (thread.snoozedUntil == null || DateTime.toEpochMillis(thread.snoozedUntil) <= nowMs)
  );
}

export function followUpMessageIds(
  threadId: ThreadId,
  followUp: Pick<ThreadFollowUp, "armedAt">,
): { readonly commandId: CommandId; readonly messageId: MessageId } {
  const identity = `later-follow-up:${threadId}:${Date.parse(followUp.armedAt)}`;
  return { commandId: CommandId.make(identity), messageId: MessageId.make(identity) };
}

const FOLLOW_UP_PREAMBLE =
  "T3 Code re-check, set by you earlier in this thread. No user is present.";

export function followUpPrompt(
  followUp: Pick<ThreadFollowUp, "question" | "quietCount">,
  limit: number,
): string {
  const next =
    followUp.quietCount < limit
      ? "If this still cannot be answered, call `t3_thread_organize` `check_later` again with a new time and say so in one line. Otherwise answer it."
      : "This is the last re-check: answer it with what you found, even if the answer is incomplete.";
  return `${FOLLOW_UP_PREAMBLE}\n\n${followUp.question}\n\n${next}`;
}

/** The question inside a `followUpPrompt` message, for the contents outline, which must not carry its instructions. */
export function followUpPromptQuestion(text: string): string | null {
  const parts = text.split("\n\n");
  return parts[0] === FOLLOW_UP_PREAMBLE && parts.length >= 3
    ? parts.slice(1, -1).join("\n\n")
    : null;
}
