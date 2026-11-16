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
  const completedAt = Date.parse(thread.latestRun.completedAt);
  if (Number.isNaN(completedAt)) return false;
  if (!thread.lastVisitedAt) return false;

  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(lastVisitedAt)) return true;
  return completedAt > lastVisitedAt;
}

/** Unopened threads' failures still count as unseen, unlike completions. */
function hasUnseenFailure(thread: Pick<ThreadStatusInput, "latestRun" | "lastVisitedAt">): boolean {
  if (thread.latestRun?.status !== "failed") return false;
  if (!thread.lastVisitedAt) return true;
  const completedAt = Date.parse(thread.latestRun.completedAt ?? "");
  const lastVisitedAt = Date.parse(thread.lastVisitedAt);
  if (Number.isNaN(completedAt) || Number.isNaN(lastVisitedAt)) return true;
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
  if (
    (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) ||
    backgroundWorkHoldsCompletion(thread.pendingBackgroundTasks ?? [])
  ) {
    return "waiting";
  }
  if (hasUnseenFailure(thread)) return "failed";
  if (
    !thread.hasPendingUserInput &&
    thread.interactionMode === "plan" &&
    isLatestRunSettled(thread.latestRun, thread.runtime) &&
    thread.hasActionableProposedPlan
  ) {
    return "plan";
  }
  // An open question outranks "Done": it is what the thread needs, read or not.
  if (threadCardHasOpenAsk(thread.card)) return "question";
  if (hasUnseenCompletion(thread)) return "completed";
  return null;
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

// A followup is a later re-read, not something to act on when the run lands.
const OWED_KINDS: ReadonlySet<ThreadCardOpenKind> = new Set(["ask", "verify", "commit", "ship"]);

/**
 * Whether a finished run leaves you something to do: its own card owes an item. A run with no
 * card of its own (summaries off, failed, still coming, or it finished before cards) owes nothing.
 */
function threadCompletionOwes(
  thread: Pick<ThreadStatusInput, "latestRun"> & Partial<Pick<EnvironmentThreadShell, "card">>,
): boolean {
  const card = thread.card;
  if (card == null) return false;
  const completedAt = Date.parse(thread.latestRun?.completedAt ?? "");
  if (Number.isNaN(completedAt) || Date.parse(card.at) < completedAt) return false;
  return card.open.some((item) => OWED_KINDS.has(item.kind));
}

/**
 * Whether the thread asks you to act, or with `includeCompleted`, to look at a finished run.
 * `"owed"` counts a finished run only when it leaves something to do (`threadCompletionOwes`).
 */
export function threadNeedsYou(
  thread: ThreadStatusInput,
  options: { readonly includeCompleted: boolean | "owed" },
): boolean {
  const kind = threadStatusKind(thread);
  if (kind !== null && NEEDS_YOU_KINDS.has(kind)) return true;
  if (
    kind === "completed" &&
    (options.includeCompleted === true ||
      (options.includeCompleted === "owed" && threadCompletionOwes(thread)))
  ) {
    return true;
  }
  return threadCardHasOpenAsk(thread.card);
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

const OWED_LABELS: Record<Exclude<ThreadCardOpenKind, "ask">, string> = {
  verify: "Check",
  commit: "Commit",
  ship: "Publish",
  followup: "Follow up",
};
const OWED_LABELS_MAX = 2;

export function threadCardOpenItemLabel(kind: ThreadCardOpenKind): string {
  return kind === "ask" ? "Question" : OWED_LABELS[kind];
}

/** What the thread still owes besides an answer, as at most two short labels, e.g. "Publish, Check". */
export function threadCardOwedLabel(card: ThreadCardSummary | null | undefined): string | null {
  const labels: string[] = [];
  for (const item of card?.open ?? []) {
    if (item.kind === "ask") continue;
    const label = OWED_LABELS[item.kind];
    if (!labels.includes(label)) labels.push(label);
  }
  return labels.length === 0 ? null : labels.slice(0, OWED_LABELS_MAX).join(", ");
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
 * A slim row's last line as plain text, what is owed first so truncation cuts the outcome.
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

type LastTouchInput = Pick<
  EnvironmentThreadShell,
  "createdAt" | "lastVisitedAt" | "latestUserMessageAt" | "latestUserAuthoredMessageAt" | "opens"
>;

/**
 * The user's last touch: the later of opening the thread and writing to it.
 * `lastVisitedAt` is a read watermark that follows the thread's own updates, so it
 * stands in for the open time only on threads opened before opens were recorded.
 */
export function threadLastTouchAt(thread: LastTouchInput): number {
  const sentAt =
    thread.latestUserAuthoredMessageAt === undefined
      ? thread.latestUserMessageAt
      : thread.latestUserAuthoredMessageAt;
  return Math.max(
    toSortableTimestamp(thread.createdAt) ?? 0,
    thread.opens?.openedAt ?? toSortableTimestamp(thread.lastVisitedAt ?? undefined) ?? 0,
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

/** Finished runs not yet opened first, then latest touch first. */
export function sortTrailThreads<
  T extends SortKeyInput & LastTouchInput & Pick<EnvironmentThreadShell, "latestRun">,
>(threads: readonly T[]): T[] {
  const sorted = sortByTimestamp(threads, threadLastTouchAt, -1);
  return [
    ...sorted.filter((thread) => hasUnseenCompletion(thread)),
    ...sorted.filter((thread) => !hasUnseenCompletion(thread)),
  ];
}

const TRAIL_VISIBLE_COUNT = 8;

function startOfLocalDay(timestampMs: number, dayOffset = 0): number {
  const date = new Date(timestampMs);
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + dayOffset);
  return date.getTime();
}

/** `trail` must already be sorted by `sortTrailThreads`. */
export function splitTrail<T extends LastTouchInput>(
  trail: readonly T[],
  options: { readonly now: number; readonly visibleCount?: number },
): { readonly head: T[]; readonly moreToday: T[]; readonly earlier: T[] } {
  const visibleCount = options.visibleCount ?? TRAIL_VISIBLE_COUNT;
  const todayStart = startOfLocalDay(options.now);
  const moreToday: T[] = [];
  const earlier: T[] = [];
  for (const thread of trail.slice(visibleCount)) {
    (threadLastTouchAt(thread) >= todayStart ? moreToday : earlier).push(thread);
  }
  return { head: trail.slice(0, visibleCount), moreToday, earlier };
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
 * finished run never moves the row being looked at. Leaving it, or sending it a
 * message (a new `sentAt`), re-sorts it. Call with the route key on each pass.
 */
export function createOpenThreadPlacementHold() {
  let held: {
    readonly key: string;
    readonly needsYou: boolean;
    readonly sentAt: string | null;
  } | null = null;
  return (routeKey: string | null) => {
    if (held?.key !== routeKey) held = null;
    return (key: string, needsYou: boolean, sentAt: string | null): boolean => {
      if (key !== routeKey) return needsYou;
      if (held === null || held.sentAt !== sentAt) held = { key, needsYou, sentAt };
      return held.needsYou;
    };
  };
}

type HeldThreadTouch = {
  readonly key: string;
  readonly lastVisitedAt: EnvironmentThreadShell["lastVisitedAt"];
  readonly opens: EnvironmentThreadShell["opens"];
};

type TouchHoldInput = SortKeyInput & LastTouchInput;

const touchKeyOf = (thread: SortKeyInput) => `${thread.environmentId}:${thread.id}`;

/** The held thread as it was when opened, for sorting only; other threads pass through. */
export function withHeldThreadTouch<T extends TouchHoldInput>(
  thread: T,
  held: HeldThreadTouch | null,
): T {
  if (held === null || touchKeyOf(thread) !== held.key) return thread;
  const { lastVisitedAt: _visited, opens: _opens, ...rest } = thread;
  return {
    ...rest,
    ...(held.lastVisitedAt === undefined ? {} : { lastVisitedAt: held.lastVisitedAt }),
    ...(held.opens === undefined ? {} : { opens: held.opens }),
  } as T;
}

/**
 * Keeps the open thread's place in the Trail as it was when opened. Opening and
 * reading a thread both advance its last touch, which would move the row being
 * looked at. Leaving it, or sending it a message (a new `sentAt`), re-sorts it.
 * Call with the open thread on each pass.
 */
export function createOpenThreadTouchHold() {
  let held: (HeldThreadTouch & { readonly sentAt: string | null }) | null = null;
  return (openThread: TouchHoldInput | undefined): HeldThreadTouch | null => {
    if (openThread === undefined) {
      held = null;
      return null;
    }
    const key = touchKeyOf(openThread);
    const sentAt =
      (openThread.latestUserAuthoredMessageAt === undefined
        ? openThread.latestUserMessageAt
        : openThread.latestUserAuthoredMessageAt) ?? null;
    if (held?.key !== key || held.sentAt !== sentAt) {
      held = { key, sentAt, lastVisitedAt: openThread.lastVisitedAt, opens: openThread.opens };
    }
    return held;
  };
}
