import * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, RunId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** "Set aside" is a snooze with no wake time the user will reach. */
export const THREAD_SET_ASIDE_UNTIL = "9999-12-31T00:00:00.000Z";
const THREAD_SET_ASIDE_UNTIL_MS = Date.parse(THREAD_SET_ASIDE_UNTIL);

export const isThreadSetAside = (snoozedUntil: string | DateTime.Utc | null | undefined) =>
  snoozedUntil != null &&
  (typeof snoozedUntil === "string"
    ? Date.parse(snoozedUntil)
    : DateTime.toEpochMillis(snoozedUntil)) >= THREAD_SET_ASIDE_UNTIL_MS;

export const THREAD_FOLLOW_UP_MIN_DELAY_MS = 10 * 60_000;
export const THREAD_FOLLOW_UP_MAX_DELAY_MS = 30 * 24 * 60 * 60_000;
export const THREAD_FOLLOW_UP_QUESTION_MAX = 2_000;
export const THREAD_FOLLOW_UP_REASON_MAX = 80;
/** How long after a publish a re-check armed for "after the next publish" runs. */
export const THREAD_FOLLOW_UP_AFTER_PUBLISH_MINUTES = 60;

export const ThreadFollowUp = Schema.Struct({
  question: TrimmedNonEmptyString.check(Schema.isMaxLength(THREAD_FOLLOW_UP_QUESTION_MAX)),
  reason: Schema.String.check(Schema.isMaxLength(THREAD_FOLLOW_UP_REASON_MAX)),
  /** Null while it waits for the project's next publish. */
  dueAt: Schema.NullOr(IsoDateTime),
  afterPublishMinutes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1_440 })),
  ),
  armedAt: IsoDateTime,
  armedBy: Schema.Literals(["agent", "user"]),
  /** Re-checks in a row that re-armed themselves. Reset when the user writes. */
  quietCount: NonNegativeInt,
  /** Set when this follow-up put the thread in Later, so reading it files it only once. */
  filedAt: Schema.optional(IsoDateTime),
  /** Set once the question is sent, or the follow-up ends unsent; `runId` is the run it started. */
  sentAt: Schema.optional(IsoDateTime),
  runId: Schema.optional(RunId),
});
export type ThreadFollowUp = typeof ThreadFollowUp.Type;

/**
 * What a list row needs. The question stays off the shell: it can be 2 KB. A subset of the
 * follow-up, so a thread's own follow-up fits where a shell's is expected.
 */
export const ThreadFollowUpSummary = Schema.Struct({
  reason: ThreadFollowUp.fields.reason,
  dueAt: ThreadFollowUp.fields.dueAt,
  armedBy: ThreadFollowUp.fields.armedBy,
  quietCount: ThreadFollowUp.fields.quietCount,
  sentAt: ThreadFollowUp.fields.sentAt,
});
export type ThreadFollowUpSummary = typeof ThreadFollowUpSummary.Type;

export const threadFollowUpSummary = (followUp: ThreadFollowUp): ThreadFollowUpSummary => ({
  reason: followUp.reason,
  dueAt: followUp.dueAt,
  armedBy: followUp.armedBy,
  quietCount: followUp.quietCount,
  ...(followUp.sentAt === undefined ? {} : { sentAt: followUp.sentAt }),
});

/** Armed means it will still send its question; a sent one is inert until the user writes. */
export const threadFollowUpIsArmed = (
  followUp: Pick<ThreadFollowUp, "sentAt"> | null | undefined,
): boolean => followUp != null && followUp.sentAt === undefined;
