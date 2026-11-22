// @effect-diagnostics globalDate:off -- Trail day groups use local calendar boundaries.
import {
  isThreadSetAside,
  threadCardHasOpenAsk,
  type OrchestrationV2PendingRuntimeRequestSummary,
  type OrchestrationV2ThreadShell,
  type ThreadCardOpenKind,
  type ThreadCardSummary,
} from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import * as DateTime from "effect/DateTime";

import type { EnvironmentThreadShell, ThreadRunSummary, ThreadRuntimeSummary } from "./models.ts";
import {
  effectiveSnoozed,
  laterWhenLabel,
  snoozeWakeLabel,
  threadAskUnread,
  threadLaterAt,
  type ThreadLaterShell,
  type ThreadSnoozeShell,
} from "./threadSettled.ts";
import { toSortableTimestamp } from "./threadSort.ts";

export type ThreadStatusKind =
  | "approval"
  | "input"
  | "guest"
  | "working"
  | "connecting"
  | "waiting"
  | "failed"
  | "plan"
  | "completed"
  | "question";

export type ThreadStatusInput = Pick<
  EnvironmentThreadShell,
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "pendingSubagentRequest"
  | "pendingGuestMessageCount"
  | "interactionMode"
  | "latestRun"
  | "runtime"
> &
  Partial<Pick<EnvironmentThreadShell, "card">> & {
    lastVisitedAt?: string | null | undefined;
    pendingBackgroundTasks?: EnvironmentThreadShell["pendingBackgroundTasks"] | undefined;
    blockedOnThreadWait?: boolean | undefined;
  };

export function isLatestRunSettled(
  latestRun: Pick<ThreadRunSummary, "runId" | "startedAt" | "completedAt" | "status"> | null,
  runtime: Pick<ThreadRuntimeSummary, "status" | "activeRunId"> | null,
): boolean {
  if (latestRun === null) return false;
  if (
    latestRun.status === "preparing" ||
    latestRun.status === "queued" ||
    latestRun.status === "starting" ||
    latestRun.status === "running" ||
    latestRun.status === "waiting"
  )
    return false;
  return runtime?.activeRunId !== latestRun.runId;
}

export function hasUnseenCompletion(
  thread: Pick<ThreadStatusInput, "latestRun" | "lastVisitedAt">,
): boolean {
  if (!thread.latestRun?.completedAt) return false;
  if (thread.latestRun.status === "interrupted" || thread.latestRun.status === "cancelled") {
    return false;
  }
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** The single decision behind the web status pill and both clients' Needs you. */
export function threadStatusKind(thread: ThreadStatusInput): ThreadStatusKind | null {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  if ((thread.pendingGuestMessageCount ?? 0) > 0) return "guest";
  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait !== true) ||
    thread.runtime?.status === "waiting"
  ) {
    return "working";
  }
  if (
    thread.runtime?.status === "preparing" ||
    thread.runtime?.status === "starting" ||
    thread.runtime?.status === "queued"
  ) {
    return "connecting";
  }
  // A turn still running, blocked on another thread, outranks the last reply's card: you
  // already answered that card's question by starting this turn.
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (thread.latestRun?.status === "failed") return "failed";
  if (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan
  ) {
    return "plan";
  }
  // A finished reply's unread question outranks the background work it left running, and "Done".
  if (threadAskUnread(thread)) return "question";
  if (backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])) return "waiting";
  if (hasUnseenCompletion(thread)) return "completed";
  // Read and still open: the row keeps saying so, below anything new.
  return threadCardHasOpenAsk(thread.card) ? "question" : null;
}

const STATUS_WORDS: Record<ThreadStatusKind, string> = {
  approval: "Approval",
  input: "Question",
  guest: "Request",
  working: "Working",
  connecting: "Starting",
  waiting: "Waiting",
  failed: "Failed",
  plan: "Plan ready",
  completed: "Done",
  question: "Question",
};

/** The one word a row leads with for its status. Secret and link requests are "Input", not questions. */
export function threadStatusWord(
  kind: ThreadStatusKind,
  options: { readonly userOnlyRequest?: boolean } = {},
): string {
  return kind === "input" && options.userOnlyRequest === true ? "Input" : STATUS_WORDS[kind];
}

const NEEDS_YOU_KINDS: ReadonlySet<ThreadStatusKind> = new Set([
  "approval",
  "input",
  "guest",
  "failed",
  "plan",
]);

/**
 * Whether the thread asks you to act, or with `includeCompleted`, to look at a finished run.
 * The self-filing list passes false: a finished run waits in the Trail under Done. A question in
 * a reply counts until you have read that reply; after that the row keeps its Question label only.
 */
export function threadNeedsYou(
  thread: ThreadStatusInput,
  options: { readonly includeCompleted: boolean },
): boolean {
  const kind = threadStatusKind(thread);
  if (kind !== null && NEEDS_YOU_KINDS.has(kind)) return true;
  if (kind === "completed" && options.includeCompleted) return true;
  return threadAskUnread(thread);
}

/**
 * A row's second line. While the thread waits on you: what the provider asks (an approval's
 * command or a question), else the card's open question, else the outcome. Otherwise the outcome.
 */
export function threadCardRowLine(
  card: ThreadCardSummary | null | undefined,
  options: {
    readonly needsYou: boolean;
    readonly request?: Pick<OrchestrationV2PendingRuntimeRequestSummary, "description"> | null;
  },
): string | null {
  if (!options.needsYou) return card?.line ?? null;
  return (
    options.request?.description ??
    card?.open.find((item) => item.kind === "ask")?.text ??
    card?.line ??
    null
  );
}

/** Strip markdown delimiters and line breaks from text shown under a thread title. */
export function threadPreviewText(text: string): string | null {
  return (
    text
      .replace(/\*\*|__|`+|^#+\s+|^>\s+/g, "")
      .replace(/\s+/g, " ")
      .trim() || null
  );
}

function workingRunText(thread: EnvironmentThreadShell): string | null {
  const {
    activityDescription,
    latestVisibleMessage,
    latestRunRequestedAt,
    latestRunId,
    activeRunId,
  } = thread.source;
  if (activityDescription !== undefined) return activityDescription;
  // Older servers only have the thread-wide preview, which can belong to a queued or finished turn.
  if (
    latestVisibleMessage === null ||
    latestRunRequestedAt == null ||
    (activeRunId !== null && activeRunId !== latestRunId) ||
    (thread.source.activityRunStatus != null &&
      thread.source.activityRunStatus !== thread.source.status) ||
    latestVisibleMessage.id === thread.card?.messageId ||
    DateTime.isLessThan(latestVisibleMessage.updatedAt, latestRunRequestedAt)
  )
    return null;
  return latestVisibleMessage.text;
}

export function threadWorkingLine(
  thread: EnvironmentThreadShell,
  kind = threadStatusKind(thread),
): string | null {
  if (kind !== "working" && kind !== "connecting" && kind !== "waiting") return null;
  if (kind === "waiting") {
    const task = thread.pendingBackgroundTasks.find(
      (task) => task.description && backgroundWorkHoldsCompletion([task]),
    );
    return (
      threadPreviewText(task?.description ?? thread.source.activityDescription ?? "") ??
      (thread.blockedOnThreadWait ? "Waiting for another thread" : "Waiting for background work")
    );
  }
  const text =
    workingRunText(thread) ?? (thread.goal?.status === "active" ? thread.goal.objective : "");
  return (
    threadPreviewText(text) ??
    (thread.runtime?.status === "preparing"
      ? "Preparing the workspace"
      : kind === "connecting"
        ? "Starting the agent"
        : "Processing the request")
  );
}

/**
 * The question the thread's last reply leaves you, in its card's words. Only while the card is
 * about that reply: once you answer, or a newer reply has no card yet, there is nothing to show.
 */
export function threadAwaitingAsk(
  thread: Pick<EnvironmentThreadShell, "card" | "source">,
): string | null {
  const message = thread.source.latestVisibleMessage;
  if (message?.role !== "assistant" || thread.card?.messageId !== message.id) return null;
  return thread.card.open.find((item) => item.kind === "ask")?.text ?? null;
}

const OPEN_ITEM_LABELS: Record<ThreadCardOpenKind, string> = {
  ask: "Question",
  verify: "Check",
  commit: "Commit",
  ship: "Publish",
  followup: "Follow up",
};

export function threadCardOpenItemLabel(kind: ThreadCardOpenKind): string {
  return OPEN_ITEM_LABELS[kind];
}

/**
 * "Question" for a card whose question was read and left: outside Needs you this label is all
 * that marks it. A row names nothing else the card leaves open. In the owner's history a check
 * or a commit was handed back to an agent, and a publish was decided per project, not per thread.
 */
export function threadCardQuestionLabel(card: ThreadCardSummary | null | undefined): string | null {
  return threadCardHasOpenAsk(card) ? OPEN_ITEM_LABELS.ask : null;
}

/**
 * The project name a row shows as text, or null where it would repeat what the list
 * already says: a list scoped to one project, or a row under a project's group label.
 */
export function threadRowProjectName(
  projectName: string | null | undefined,
  context: { readonly singleProject: boolean; readonly underProjectLabel: boolean },
): string | null {
  if (context.singleProject || context.underProjectLabel) return null;
  const name = projectName?.trim() ?? "";
  return name === "" ? null : name;
}

/**
 * A slim row's last line as plain text, its lead word first so truncation cuts the outcome.
 */
export function threadRowLineText(parts: {
  readonly owed: string | null;
  readonly line: string | null;
}): string | null {
  const text = [parts.owed, parts.line].filter((part) => part !== null).join(" · ");
  return text === "" ? null : text;
}

/** "Later · in 3d" for a thread still in Later, so search results keep its state. */
export function threadLaterLabel(
  thread: ThreadSnoozeShell & ThreadLaterShell,
  options: { readonly now: string },
): string | null {
  if (thread.snoozedUntil == null || !effectiveSnoozed(thread, options)) return null;
  const when = laterWhenLabel(thread, options);
  return when === null ? "Later" : when === "due" ? "Later · due" : `Later · in ${when}`;
}

type LaterLeadInput = Pick<EnvironmentThreadShell, "snoozedUntil"> &
  Partial<Pick<EnvironmentThreadShell, "followUp" | "standingCheck">>;

/**
 * What a Later row leads with, and its text when the row has its own: an armed re-check
 * ("Re-check 2 of 3" once it has re-armed itself) with its reason, a standing check, or a
 * thread set aside. Null for a plain snooze, which reads like any other row.
 */
export function threadLaterLead(
  thread: LaterLeadInput,
  options: { readonly recheckLimit: number | null },
): { readonly word: string; readonly text: string | null } | null {
  const followUp = thread.followUp;
  if (followUp != null && followUp.sentAt === undefined) {
    const count =
      followUp.quietCount === 0
        ? ""
        : options.recheckLimit === null
          ? ` ${followUp.quietCount}`
          : ` ${followUp.quietCount} of ${options.recheckLimit}`;
    const reason = followUp.reason.trim();
    return {
      word: `Re-check${count}`,
      text: reason !== "" ? reason : followUp.dueAt === null ? "After the next publish" : null,
    };
  }
  if (thread.standingCheck === true) return { word: "Standing check", text: null };
  if (isThreadSetAside(thread.snoozedUntil)) return { word: "Set aside", text: null };
  return null;
}

/** A held thread's status line: "Snoozed, wakes in 3h", "Re-check 1 of 3, due", "Set aside". */
export function threadLaterStatusLabel(
  thread: LaterLeadInput & ThreadLaterShell,
  options: { readonly now: string; readonly recheckLimit: number | null },
): string {
  const word = threadLaterLead(thread, options)?.word ?? "Snoozed";
  const when = laterWhenLabel(thread, options);
  if (when === null || when === "now") return word;
  return when === "due" ? `${word}, due` : `${word}, wakes in ${when}`;
}

/** How long before its settle time a quiet thread's row says so. */
export const AUTO_SETTLE_SOON_MS = 60 * 60 * 1_000;
export const AUTO_SETTLE_SOON_WORD = "Settling soon";

type AutoSettleInput = Pick<
  EnvironmentThreadShell,
  "archivedAt" | "settledOverride" | "pinnedAt" | "latestRun" | "latestUserMessageAt"
> &
  Partial<Pick<EnvironmentThreadShell, "autoSettlePlan" | "autoSettleDisabledAt">>;

/**
 * When the server will settle a quiet thread, in epoch ms. Null without a plan, and once the
 * thread has moved on from the activity the plan was worked out from: the server rewrites it
 * only when the thread goes quiet again, and never for a thread it has stopped sweeping.
 */
export function threadAutoSettleAt(thread: AutoSettleInput): number | null {
  const plan = thread.autoSettlePlan;
  if (plan == null || thread.archivedAt !== null || thread.settledOverride !== null) return null;
  if (thread.pinnedAt !== null || thread.autoSettleDisabledAt != null) return null;
  const run = thread.latestRun;
  const moved = [thread.latestUserMessageAt, run?.requestedAt, run?.startedAt, run?.completedAt]
    .map((value) => (value == null ? Number.NaN : Date.parse(value)))
    .some((atMs) => atMs > plan.basisAt);
  return moved ? null : plan.at;
}

/** "Settles in 3h". A time already past is held until the owner is back, which the server decides. */
export function threadAutoSettleLabel(atMs: number, options: { readonly now: string }): string {
  const when = snoozeWakeLabel(DateTime.formatIso(DateTime.makeUnsafe(atMs)), options);
  return when === "now" ? "Settles soon after your next message" : `Settles in ${when}`;
}

/** Later, soonest first; rows with no time (set aside, standing checks) last, oldest hold first. */
export function sortLaterThreads<
  T extends SortKeyInput & ThreadLaterShell & { readonly snoozedAt?: string | null },
>(threads: readonly T[]): T[] {
  const keys = new Map(
    threads.map((thread) => {
      const at = threadLaterAt(thread);
      return [
        thread,
        {
          at: at === null ? Number.POSITIVE_INFINITY : Date.parse(at),
          heldAt: toSortableTimestamp(thread.snoozedAt ?? undefined) ?? 0,
        },
      ] as const;
    }),
  );
  return [...threads].sort((left, right) => {
    const a = keys.get(left)!;
    const b = keys.get(right)!;
    return (
      (a.at === b.at ? 0 : a.at < b.at ? -1 : 1) ||
      a.heldAt - b.heldAt ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId)
    );
  });
}

type WaitingSinceInput = Pick<
  EnvironmentThreadShell,
  "pendingUserInputAt" | "latestRun" | "createdAt"
> & {
  readonly source: Pick<OrchestrationV2ThreadShell, "pendingRuntimeRequest">;
};

/** When the thread started needing you, in epoch ms. Agent activity never moves it. */
export function threadWaitingSince(thread: WaitingSinceInput): number {
  const request = thread.source.pendingRuntimeRequest;
  return (
    toSortableTimestamp(thread.pendingUserInputAt ?? undefined) ??
    (request === null ? null : DateTime.toEpochMillis(request.createdAt)) ??
    toSortableTimestamp(thread.latestRun?.completedAt ?? undefined) ??
    toSortableTimestamp(thread.latestRun?.requestedAt ?? undefined) ??
    toSortableTimestamp(thread.createdAt) ??
    0
  );
}

type LastSentInput = Pick<
  EnvironmentThreadShell,
  "createdAt" | "latestUserMessageAt" | "latestUserAuthoredMessageAt"
>;

/**
 * When you last wrote to the thread, or its creation before that. Opening a thread and its runs
 * finishing never move it, so a row stays where it was while you read.
 */
export function threadLastSentAt(thread: LastSentInput): number {
  const sentAt =
    thread.latestUserAuthoredMessageAt === undefined
      ? thread.latestUserMessageAt
      : thread.latestUserAuthoredMessageAt;
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    toSortableTimestamp(sentAt ?? undefined) ?? 0,
  );
}

type SortKeyInput = Pick<EnvironmentThreadShell, "id" | "environmentId">;

function sortByTimestamp<T extends SortKeyInput>(
  threads: readonly T[],
  timestampOf: (thread: T) => number,
  direction: 1 | -1,
): T[] {
  const timestamps = new Map(threads.map((thread) => [thread, timestampOf(thread)]));
  // A copy, not `toSorted`: Hermes has no `toSorted`.
  return [...threads].sort(
    (left, right) =>
      direction * (timestamps.get(left)! - timestamps.get(right)!) ||
      left.id.localeCompare(right.id) ||
      left.environmentId.localeCompare(right.environmentId),
  );
}

/** Longest wait first. */
export function sortNeedsYouThreads<T extends SortKeyInput & WaitingSinceInput>(
  threads: readonly T[],
): T[] {
  return sortByTimestamp(threads, threadWaitingSince, 1);
}

/** Latest message you sent first. */
export function sortTrailThreads<T extends SortKeyInput & LastSentInput>(
  threads: readonly T[],
): T[] {
  return sortByTimestamp(threads, threadLastSentAt, -1);
}

const TRAIL_VISIBLE_COUNT = 8;

function startOfLocalDay(timestampMs: number, dayOffset = 0): number {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.getTime();
}

/**
 * The first rows, then the rest split at local midnight. A finish you haven't opened stays in
 * the first rows, so its Done shows. `trail` must already be sorted by `sortTrailThreads`.
 */
export function splitTrail<
  T extends LastSentInput & Pick<ThreadStatusInput, "latestRun" | "lastVisitedAt">,
>(
  trail: readonly T[],
  options: { readonly now: number; readonly visibleCount?: number },
): { readonly head: T[]; readonly moreToday: T[]; readonly earlier: T[] } {
  const visibleCount = options.visibleCount ?? TRAIL_VISIBLE_COUNT;
  const todayStart = startOfLocalDay(options.now);
  const head = trail.slice(0, visibleCount);
  const moreToday: T[] = [];
  const earlier: T[] = [];
  for (const thread of trail.slice(visibleCount)) {
    if (hasUnseenCompletion(thread)) head.push(thread);
    else (threadLastSentAt(thread) >= todayStart ? moreToday : earlier).push(thread);
  }
  return { head, moreToday, earlier };
}

export function trailMoreLabel(counts: {
  readonly moreToday: number;
  readonly earlier: number;
}): string {
  const parts: string[] = [];
  if (counts.moreToday > 0) parts.push(`${counts.moreToday} more today`);
  if (counts.earlier > 0) parts.push(`${counts.earlier} earlier`);
  return parts.join(", ");
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
] as const;

/** "Today", "Yesterday", or a local date like "Mon 10 Nov". */
export function trailDayLabel(timestampMs: number, nowMs: number): string {
  const dayStart = startOfLocalDay(timestampMs);
  if (dayStart === startOfLocalDay(nowMs)) return "Today";
  if (dayStart === startOfLocalDay(nowMs, -1)) return "Yesterday";
  const date = new Date(timestampMs);
  return `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]}`;
}

/**
 * Keeps the open thread in or out of Needs you as it was when opened, so opening a
 * finished run never moves the row being looked at. Leaving it, sending it a message
 * (a new `sentAt`), or dismissing its card's question (or undoing that) re-sorts it.
 * Call with the route key on each pass.
 */
export function createOpenThreadPlacementHold() {
  let held: {
    readonly key: string;
    readonly needsYou: boolean;
    readonly sentAt: string | null;
    readonly ask: { readonly messageId: string; readonly open: boolean } | null;
  } | null = null;
  return (routeKey: string | null) => {
    if (held?.key !== routeKey) held = null;
    return (
      key: string,
      needsYou: boolean,
      sentAt: string | null,
      card?: Pick<ThreadCardSummary, "messageId" | "open"> | null,
    ): boolean => {
      if (key !== routeKey) return needsYou;
      const ask =
        card == null ? null : { messageId: card.messageId, open: threadCardHasOpenAsk(card) };
      // The same card gaining or losing its ask is you dismissing it or undoing that; a new
      // card is a run finishing, which must not move the row being read.
      const toggled =
        held?.ask != null && ask?.messageId === held.ask.messageId && ask.open !== held.ask.open;
      if (held === null || held.sentAt !== sentAt || toggled) {
        held = { key, needsYou, sentAt, ask };
      } else {
        held = { ...held, ask };
      }
      return held.needsYou;
    };
  };
}
