import {
  canSnooze,
  effectiveSnoozed,
  hasQueuedTurnStart,
  laterWhenLabel,
  pickSnoozePreset,
  QUEUED_TURN_START_GRACE_MS,
  resolveSnoozePresets,
  snoozeWakeAtMs,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import type { SnoozePreset } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { resolveThreadProviderStack } from "@t3tools/client-runtime/state/models";
import {
  hasUnseenCompletion as threadHasUnseenCompletion,
  sortLaterThreads,
  sortNeedsYouThreads,
  sortTrailThreads,
  splitTrail,
  threadCardOwedLabel,
  threadCardRowLine,
  threadLaterLead,
  threadRowLineText,
  threadRowProjectName,
  threadLastTouchAt,
  threadNeedsYou,
  trailMoreLabel,
  withHeldThreadTouch,
  type createOpenThreadTouchHold,
} from "@t3tools/client-runtime/state/thread-zones";
import {
  threadSearchMatchKey,
  threadSearchSubject,
} from "@t3tools/client-runtime/state/thread-search";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";
import {
  createInboxReturnTracker,
  isThreadWorking,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "@t3tools/client-runtime/state/thread-inbox";
import {
  sortActiveThreadsByOrderKey,
  resolveSettledThreadTimestamp,
  resolveThreadActivityTimestamp,
  sortPinnedThreadsByOrderKey,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import { isListedThreadLineage, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import type { MenuAction } from "@react-native-menu/menu";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import type { ThreadMoveAvailability } from "./threadOrder";

import { relativeTime } from "../../lib/time";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";

import {
  applyPendingThreadOrder,
  reconcilePendingThreadOrder,
  type PendingThreadOrder,
} from "./threadOrder";

export const threadListInboxReturns = createInboxReturnTracker();

export function resolveThreadListV2ProviderDrivers(
  thread: Pick<EnvironmentThreadShell, "providerInstanceHistory" | "modelSelection" | "runtime">,
  providers: ReadonlyArray<ThreadListProvider> | undefined,
): ReadonlyArray<string> {
  if (providers === undefined) return [];
  const stack = resolveThreadProviderStack(thread);
  const drivers = stack.flatMap((instanceId) => {
    const driver = providers.find((provider) => provider.instanceId === instanceId)?.driver;
    return driver === undefined ? [] : [driver];
  });
  const currentDriver = providers.find(
    (provider) => provider.instanceId === stack[stack.length - 1],
  )?.driver;
  return currentDriver === undefined ? [] : drivers;
}

export type ThreadListV2Status =
  | "approval"
  | "input"
  | "request"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";
export type ThreadListV2SwipeAction = "archive" | "settle" | "unsettle" | "snooze" | "unsnooze";

/**
 * Presets for a row's snooze menu, read at the list's minute instead of the
 * clock: the compiler keys a row's memo on its inputs, so a clock read inside
 * it would keep the times from the row's first render.
 */
export function resolveThreadListV2SnoozePresets(input: {
  readonly secondary: "snooze" | null;
  readonly now: string;
  readonly presets: ReadonlyArray<SnoozePresetSetting> | undefined;
}): ReadonlyArray<SnoozePreset> {
  return input.secondary === "snooze"
    ? resolveSnoozePresets(new Date(input.now), presetOptions(input.presets))
    : [];
}

function presetOptions(presets: ReadonlyArray<SnoozePresetSetting> | undefined) {
  return presets ? { presets } : {};
}

export function resolveThreadListV2SnoozeMenuSelection(input: {
  readonly event: string;
  readonly displayedPresets: ReadonlyArray<SnoozePreset>;
  readonly now: Date;
  readonly presets: ReadonlyArray<SnoozePresetSetting> | undefined;
}):
  | { readonly _tag: "selected"; readonly preset: SnoozePreset }
  | { readonly _tag: "expired" }
  | { readonly _tag: "not-snooze" } {
  if (!input.event.startsWith("snooze:")) return { _tag: "not-snooze" };
  const preset = pickSnoozePreset({
    shown: input.displayedPresets,
    id: input.event.slice("snooze:".length),
    now: input.now,
    ...presetOptions(input.presets),
  });
  return preset ? { _tag: "selected", preset } : { _tag: "expired" };
}

export function resolveThreadListV2SwipeActions(input: {
  readonly settled: boolean;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozable: boolean;
  readonly snoozed?: boolean;
}): {
  readonly primary: Exclude<ThreadListV2SwipeAction, "snooze">;
  readonly secondary: "snooze" | null;
} {
  if (input.snoozed === true) {
    return { primary: "unsnooze", secondary: null };
  }
  const primary = input.settlementSupported ? (input.settled ? "unsettle" : "settle") : "archive";
  return {
    primary,
    secondary: input.snoozeSupported && input.snoozable ? "snooze" : null,
  };
}

// Nested keeps iOS menus short: UIKit scrolls a taller menu, and that scroll
// cancels press-drag-release selection.
export function layoutThreadListV2RowMenuActions(input: {
  readonly nested: boolean;
  readonly direct: readonly MenuAction[];
  readonly reorder: readonly MenuAction[];
  readonly pin: readonly MenuAction[];
  readonly secondary: readonly MenuAction[];
}): MenuAction[] {
  if (!input.nested) {
    return [...input.direct, ...input.reorder, ...input.pin, ...input.secondary];
  }
  return [
    ...input.direct,
    ...input.pin,
    {
      id: "more",
      title: "More",
      image: "ellipsis.circle",
      subactions: [
        ...(input.reorder.length > 1
          ? [
              {
                id: "arrange-menu",
                title: "Arrange",
                image: "arrow.up.arrow.down",
                subactions: [...input.reorder],
              },
            ]
          : input.reorder),
        ...input.secondary,
      ],
    },
  ];
}

export function resolveThreadListV2SnoozeGateExpiryMs(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "latestRun"
    | "latestUserMessageAt"
    | "runtime"
  >,
  options: { readonly now: string },
): number | null {
  if (thread.hasPendingApprovals) return null;
  if (thread.pendingSubagentRequest != null) return null;
  if (!hasQueuedTurnStart(thread, options)) return null;
  const messageAtMs = Date.parse(thread.latestUserMessageAt ?? "");
  if (Number.isNaN(messageAtMs)) return null;
  return messageAtMs + QUEUED_TURN_START_GRACE_MS;
}

/** A held row's ways out of what holds it, beside Wake thread. */
export function threadListV2LaterMenuActions(
  thread: Pick<EnvironmentThreadShell, "followUp" | "standingCheck">,
): MenuAction[] {
  return [
    ...(thread.followUp != null && thread.followUp.sentAt === undefined
      ? [{ id: "later:cancel-recheck", title: "Cancel re-check", image: "xmark.circle" }]
      : []),
    ...(thread.standingCheck === true
      ? [{ id: "later:stop-standing-check", title: "Stop standing check", image: "calendar" }]
      : []),
  ];
}

/** The earliest `snoozedUntil` strictly after `nowMs`, in epoch ms; set aside has none. */
export function nextSnoozeWakeAfter(
  threads: ReadonlyArray<{ readonly snoozedUntil?: string | null }>,
  nowMs: number,
): number | null {
  let next: number | null = null;
  for (const thread of threads) {
    const wakeAtMs = snoozeWakeAtMs(thread.snoozedUntil);
    if (wakeAtMs !== null && wakeAtMs > nowMs && (next === null || wakeAtMs < next)) {
      next = wakeAtMs;
    }
  }
  return next;
}

// Outside search, the clock only changes list membership/order at snooze deadlines.
export function threadListV2LayoutTime(input: {
  readonly threads: ReadonlyArray<{ readonly snoozedUntil?: string | null }>;
  readonly now: string;
  readonly searchQuery: string;
}) {
  if (input.searchQuery !== "") return input.now;
  const nowMs = Date.parse(input.now);
  if (!Number.isFinite(nowMs)) return input.now;
  let previousWakeAt: number | undefined;
  let nextWakeAt: number | undefined;
  for (const thread of input.threads) {
    const wakeAt = snoozeWakeAtMs(thread.snoozedUntil);
    if (wakeAt === null) continue;
    if (wakeAt <= nowMs) previousWakeAt = Math.max(previousWakeAt ?? wakeAt, wakeAt);
    else nextWakeAt = Math.min(nextWakeAt ?? wakeAt, wakeAt);
  }
  return new Date(previousWakeAt ?? (nextWakeAt === undefined ? 0 : nextWakeAt - 1)).toISOString();
}

const EMPTY_TIDE_LAYOUT = {
  needsYouHeaderIndex: null,
  needsYouCount: 0,
  trailHeaderIndex: null,
  trailCount: 0,
  trailMore: null,
  trailClearThreads: [],
} satisfies Partial<ThreadListV2Layout>;

export const THREAD_LIST_V2_SETTLED_INITIAL_COUNT = 10;
export const THREAD_LIST_V2_SETTLED_PAGE_COUNT = 25;

export { threadHasUnseenCompletion };

export function resolveThreadListV2WokeAt(
  thread: EnvironmentThreadShell,
  options: { readonly now: string },
): string | null {
  // Older servers cannot persist an acknowledgement.
  if (thread.lastVisitedAt === undefined || thread.settledOverride === "settled") return null;
  const wokeAt = threadWokeAt(thread, options);
  const wokeAtMs = Date.parse(wokeAt ?? "");
  const lastVisitedAtMs = Date.parse(thread.lastVisitedAt ?? "");
  return !Number.isNaN(wokeAtMs) && (Number.isNaN(lastVisitedAtMs) || lastVisitedAtMs < wokeAtMs)
    ? wokeAt
    : null;
}

export function resolveThreadListV2Status(
  thread: Pick<
    EnvironmentThreadShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "runtime"
    | "blockedOnThreadWait"
  >,
): ThreadListV2Status {
  if (thread.hasPendingApprovals || thread.pendingSubagentRequest === "approval") {
    return "approval";
  }
  if (thread.hasPendingUserInput || thread.pendingSubagentRequest === "user_input") {
    return "input";
  }
  // A guest is waiting on the owner; the agent's own requests come first.
  if ((thread.pendingGuestMessageCount ?? 0) > 0) {
    return "request";
  }
  if (thread.runtime?.status === "running" && thread.blockedOnThreadWait === true) {
    return "waiting";
  }
  if (
    thread.runtime !== null &&
    ["preparing", "queued", "starting", "running", "waiting"].includes(thread.runtime.status)
  ) {
    return "working";
  }
  if (thread.runtime?.status === "idle") {
    return "waiting";
  }
  if (thread.runtime?.status === "failed") {
    return thread.runtime.lastErrorClass === "usage_limit" ? "limited" : "failed";
  }
  return "ready";
}

function parseTimestampMs(isoDate: string): number {
  const parsed = Date.parse(isoDate);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function sortThreadsForListV2<
  T extends {
    readonly id: string;
    readonly createdAt: string;
    readonly unsettledAt?: string | null | undefined;
    readonly activeOrderKey?: string | null | undefined;
    readonly environmentId?: string | undefined;
  },
>(threads: readonly T[]): T[] {
  return sortActiveThreadsByOrderKey(threads);
}

export function getThreadListV2OrderedSection(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly section: "pinned" | "active";
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly now: string;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
}): EnvironmentThreadShell[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const threads = input.threads.filter((thread) => {
    if (thread.archivedAt !== null || !isListedThreadLineage(thread.lineage)) return false;
    if (
      (input.settlementEnvironmentIds?.has(thread.environmentId) ?? true) &&
      thread.settledOverride === "settled" &&
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) !== true
    ) {
      return false;
    }
    if (
      (input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true) &&
      effectiveSnoozed(thread, { now: input.now })
    ) {
      return false;
    }
    return (thread.pinnedAt != null) === (input.section === "pinned");
  });
  const ordered =
    input.section === "pinned"
      ? sortPinnedThreadsByOrderKey(threads)
      : sortActiveThreadsByOrderKey(threads);
  const pending =
    input.pendingOrder?.section === input.section
      ? reconcilePendingThreadOrder(input.pendingOrder, ordered)
      : null;
  return applyPendingThreadOrder(ordered, input.section, pending);
}

export interface ThreadListV2Item {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly snoozed: boolean;
  readonly pinned: boolean;
  readonly wokeAt: string | null;
  /** The card's line, or its open question in Needs you; only in the new layout. */
  readonly cardLine: string | null;
  /** The project's name on its own line above a slim row's title; only in the new layout. */
  readonly projectLine: string | null;
  readonly isLast: boolean;
}

/** A project folder's threads start at `headerIndex` in the layout's items. */
export interface ThreadListV2Folder {
  readonly key: string;
  readonly title: string;
  readonly count: number;
  readonly collapsed: boolean;
  readonly headerIndex: number;
}

export interface ThreadListV2Layout {
  readonly items: ThreadListV2Item[];
  /** Project folders that hold the active threads, in order; empty when folders are off. */
  readonly folders: ReadonlyArray<ThreadListV2Folder>;
  readonly hiddenSettledCount: number;
  /** The settled rows the shelf may list, before its visible limit. */
  readonly listedSettledThreads: ReadonlyArray<EnvironmentThreadShell>;
  readonly workingCount: number;
  readonly workingShelfHeaderIndex: number | null;
  readonly snoozedCount: number;
  readonly snoozedShelfHeaderIndex: number | null;
  readonly settledCount: number;
  readonly settledShelfHeaderIndex: number | null;
  readonly needsYouHeaderIndex: number | null;
  readonly needsYouCount: number;
  readonly trailHeaderIndex: number | null;
  readonly trailCount: number;
  /** The Trail rows past the first eight; null while there are none. */
  readonly trailMore: { readonly moreToday: number; readonly earlier: number } | null;
  /** Every Trail thread, folded or not, except the open one. */
  readonly trailClearThreads: ReadonlyArray<EnvironmentThreadShell>;
  /** Arm a timeout here to repartition at snooze expiry rather than the next minute tick. */
  readonly nextSnoozeWakeAt: string | null;
  /** Threads listed only because their messages match the search. */
  readonly contentOnlyThreadKeys: ReadonlySet<string>;
}

export interface ThreadListV2ThreadListItem {
  readonly type: "v2-thread";
  readonly key: string;
  readonly item: ThreadListV2Item;
  readonly snoozeWakeLabelText: string | undefined;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string | undefined;
  readonly showTrailingDivider: boolean;
  /** Include queued state in item equality; outbox writes do not update thread shells. */
  readonly hasQueuedMessages: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
}

export interface ThreadListV2PendingListItem {
  readonly type: "v2-pending";
  readonly key: string;
  readonly pendingTask: PendingNewTask;
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider: boolean;
}

export interface ThreadListV2WorkingShelfListItem {
  readonly type: "v2-working-shelf";
  readonly key: "v2-working-shelf";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2FolderListItem {
  readonly type: "v2-folder";
  readonly key: string;
  readonly folderKey: string;
  readonly title: string;
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export interface ThreadListV2SnoozedShelfListItem {
  readonly type: "v2-snoozed-shelf";
  readonly key: "v2-snoozed-shelf";
  readonly label: "Snoozed" | "Later";
  readonly count: number;
  readonly expanded: boolean;
  /** Include disabled state in item equality; recycled cells ignore render-closure updates. */
  readonly disabled: boolean;
}

export interface ThreadListV2SettledShelfListItem {
  readonly type: "v2-settled-shelf";
  readonly key: "v2-settled-shelf";
  readonly label: "Settled" | "History";
  readonly count: number;
  readonly expanded: boolean;
  readonly disabled: boolean;
  /** The header offers "All", which opens every topic; only where a server keeps topics. */
  readonly showsAll: boolean;
}

export interface ThreadListV2SectionHeaderListItem {
  readonly type: "v2-section-header";
  readonly key: "v2-needs-you-header" | "v2-trail-header";
  readonly title: "Needs you" | "Trail";
  readonly count: number;
  /** What the header's Clear settles; on the item so a recycled cell never settles an old set. */
  readonly clearThreads: ReadonlyArray<EnvironmentThreadShell> | null;
  readonly disabled: boolean;
}

export interface ThreadListV2TrailMoreListItem {
  readonly type: "v2-trail-more";
  readonly key: "v2-trail-more";
  readonly label: string;
  readonly expanded: boolean;
  readonly disabled: boolean;
}

export type ThreadListV2ListItem =
  | ThreadListV2ThreadListItem
  | ThreadListV2PendingListItem
  | ThreadListV2WorkingShelfListItem
  | ThreadListV2FolderListItem
  | ThreadListV2SnoozedShelfListItem
  | ThreadListV2SettledShelfListItem
  | ThreadListV2SectionHeaderListItem
  | ThreadListV2TrailMoreListItem;

export function isThreadListV2ListItem(value: {
  readonly type: string;
}): value is ThreadListV2ListItem {
  return (
    value.type === "v2-thread" ||
    value.type === "v2-pending" ||
    value.type === "v2-working-shelf" ||
    value.type === "v2-folder" ||
    value.type === "v2-snoozed-shelf" ||
    value.type === "v2-settled-shelf" ||
    value.type === "v2-section-header" ||
    value.type === "v2-trail-more"
  );
}

/** Compare rebuilt items by content so minute ticks and partition runs do not re-render every mounted row. */
export function threadListV2ListItemsAreEqual(
  previous: ThreadListV2ListItem,
  item: ThreadListV2ListItem,
): boolean {
  switch (item.type) {
    case "v2-thread":
      return (
        previous.type === "v2-thread" &&
        previous.key === item.key &&
        previous.item.thread === item.item.thread &&
        previous.item.variant === item.item.variant &&
        previous.item.snoozed === item.item.snoozed &&
        previous.item.pinned === item.item.pinned &&
        previous.item.wokeAt === item.item.wokeAt &&
        previous.item.cardLine === item.item.cardLine &&
        previous.item.projectLine === item.item.projectLine &&
        previous.snoozeWakeLabelText === item.snoozeWakeLabelText &&
        previous.timeLabel === item.timeLabel &&
        previous.snoozePresetMinute === item.snoozePresetMinute &&
        previous.showTrailingDivider === item.showTrailingDivider &&
        previous.hasQueuedMessages === item.hasQueuedMessages &&
        previous.canMoveUp === item.canMoveUp &&
        previous.canMoveDown === item.canMoveDown
      );
    case "v2-pending":
      return (
        previous.type === "v2-pending" &&
        previous.key === item.key &&
        previous.pendingTask === item.pendingTask &&
        previous.showPendingDivider === item.showPendingDivider &&
        previous.showTrailingDivider === item.showTrailingDivider
      );
    case "v2-working-shelf":
      return (
        previous.type === "v2-working-shelf" &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-folder":
      return (
        previous.type === "v2-folder" &&
        previous.key === item.key &&
        previous.title === item.title &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-snoozed-shelf":
      return (
        previous.type === "v2-snoozed-shelf" &&
        previous.label === item.label &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
    case "v2-settled-shelf":
      return (
        previous.type === "v2-settled-shelf" &&
        previous.label === item.label &&
        previous.count === item.count &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled &&
        previous.showsAll === item.showsAll
      );
    case "v2-section-header":
      return (
        previous.type === "v2-section-header" &&
        previous.key === item.key &&
        previous.count === item.count &&
        previous.disabled === item.disabled &&
        sameThreadKeys(previous.clearThreads, item.clearThreads)
      );
    case "v2-trail-more":
      return (
        previous.type === "v2-trail-more" &&
        previous.label === item.label &&
        previous.expanded === item.expanded &&
        previous.disabled === item.disabled
      );
  }
}

function sameThreadKeys(
  left: ReadonlyArray<EnvironmentThreadShell> | null,
  right: ReadonlyArray<EnvironmentThreadShell> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.length === right.length &&
    left.every(
      (thread, index) =>
        thread.id === right[index]!.id && thread.environmentId === right[index]!.environmentId,
    )
  );
}

function resolveThreadListV2ItemTimeLabel(
  item: ThreadListV2Item,
  showSnoozeWakeLabel: boolean,
  inTrail: boolean,
): string {
  const { thread, variant, snoozed } = item;
  // A held row with no wake label is set aside or a standing check: it has no time to show.
  if (showSnoozeWakeLabel || snoozed) return "";
  // The Trail is ordered by your last touch, so its rows show that time and read in order.
  if (inTrail) return relativeTime(new Date(threadLastTouchAt(thread)).toISOString());
  if (
    variant === "card" &&
    (resolveThreadListV2Status(thread) !== "ready" ||
      item.wokeAt !== null ||
      threadHasUnseenCompletion(thread))
  )
    return "";
  const settledTimestamp =
    variant === "slim" && !snoozed && thread.settledOverride === "settled"
      ? resolveSettledThreadTimestamp(thread)
      : null;
  return relativeTime(
    settledTimestamp ?? resolveThreadActivityTimestamp(thread) ?? thread.createdAt,
  );
}

export function buildThreadListV2ListItems(input: {
  readonly items: ReadonlyArray<ThreadListV2Item>;
  readonly pendingTasks: ReadonlyArray<PendingNewTask>;
  readonly folders?: ReadonlyArray<ThreadListV2Folder>;
  readonly workingCount?: number;
  readonly workingShelfExpanded?: boolean;
  readonly workingShelfHeaderIndex?: number | null;
  readonly snoozedCount?: number;
  readonly snoozedShelfExpanded?: boolean;
  readonly snoozedShelfHeaderIndex?: number | null;
  readonly settledCount?: number;
  readonly settledShelfExpanded?: boolean;
  readonly settledShelfHeaderIndex?: number | null;
  /** The self-filing list's sections, from `buildThreadListV2Items` with `tide` set. */
  readonly tide?: Pick<
    ThreadListV2Layout,
    | "needsYouHeaderIndex"
    | "needsYouCount"
    | "trailHeaderIndex"
    | "trailCount"
    | "trailMore"
    | "trailClearThreads"
  > & { readonly trailExpanded: boolean };
  readonly snoozeLabelNow?: string;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  readonly moveAvailability?: ReadonlyMap<string, ThreadMoveAvailability>;
  readonly shelfPreferencesLoading?: boolean;
  /** Some connected server keeps topics, so the self-filing History header links to them. */
  readonly historyAll?: boolean;
}): ThreadListV2ListItem[] {
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const trailStart = input.tide?.trailHeaderIndex ?? null;
  // The self-filing list draws Later after the Trail, so the Trail stops where Later starts.
  const trailStop =
    input.snoozedShelfHeaderIndex ?? input.settledShelfHeaderIndex ?? input.items.length;
  const threadItems = input.items.map((item, index): ThreadListV2ListItem => {
    const snoozeWakeLabelText =
      item.snoozed && input.snoozeLabelNow !== undefined
        ? (laterWhenLabel(item.thread, { now: input.snoozeLabelNow }) ?? undefined)
        : undefined;
    // Put the clock on items so recycler equality limits ticks to rows displaying snooze preset times.
    const snoozePresetMinute =
      !item.snoozed &&
      input.snoozeLabelNow !== undefined &&
      (input.snoozeEnvironmentIds?.has(item.thread.environmentId) ?? true) &&
      canSnooze(item.thread, { now: input.snoozeLabelNow })
        ? input.snoozeLabelNow
        : undefined;
    const move =
      item.variant === "card"
        ? input.moveAvailability?.get(`${item.thread.environmentId}:${item.thread.id}`)
        : undefined;
    return {
      type: "v2-thread",
      key: `v2-thread:${item.thread.environmentId}:${item.thread.id}`,
      item,
      snoozeWakeLabelText,
      timeLabel: resolveThreadListV2ItemTimeLabel(
        item,
        snoozeWakeLabelText !== undefined,
        trailStart !== null && index >= trailStart && index < trailStop,
      ),
      snoozePresetMinute,
      showTrailingDivider: false,
      hasQueuedMessages:
        queuedThreadKeys?.has(`${item.thread.environmentId}:${item.thread.id}`) === true,
      canMoveUp: move?.canMoveUp === true,
      canMoveDown: move?.canMoveDown === true,
    };
  });
  const pendingItems = input.pendingTasks.map((pendingTask, index): ThreadListV2ListItem => ({
    type: "v2-pending",
    key: `v2-${pendingTask.key}`,
    pendingTask,
    showPendingDivider: index === 0,
    showTrailingDivider: false,
  }));
  const workingCount = input.workingCount ?? 0;
  const workingShelfHeaderIndex = input.workingShelfHeaderIndex ?? null;
  const snoozedCount = input.snoozedCount ?? 0;
  const snoozedShelfHeaderIndex = input.snoozedShelfHeaderIndex ?? null;
  const settledCount = input.settledCount ?? 0;
  const settledShelfHeaderIndex = input.settledShelfHeaderIndex ?? null;
  const tide = input.tide ?? null;
  const trailHeaderIndex = tide?.trailHeaderIndex ?? null;
  const listEnd = settledShelfHeaderIndex ?? threadItems.length;
  const trailEnd = snoozedShelfHeaderIndex ?? listEnd;
  const snoozedEnd = tide === null ? (trailHeaderIndex ?? listEnd) : listEnd;
  const workingEnd =
    (tide === null ? snoozedShelfHeaderIndex : (trailHeaderIndex ?? snoozedShelfHeaderIndex)) ??
    snoozedEnd;
  const activeEnd = workingShelfHeaderIndex ?? workingEnd;
  const shelfDisabled = input.shelfPreferencesLoading === true;
  const result: ThreadListV2ListItem[] = [...pendingItems];
  const folders = input.folders ?? [];
  let folderIndex = 0;
  // A collapsed folder can hold no rows, so several headers may share an index.
  const pushFoldersAt = (index: number) => {
    while (folderIndex < folders.length && folders[folderIndex]!.headerIndex <= index) {
      const folder = folders[folderIndex]!;
      result.push({
        type: "v2-folder",
        key: `v2-folder:${folder.key}`,
        folderKey: folder.key,
        title: folder.title,
        count: folder.count,
        expanded: !folder.collapsed,
        disabled: shelfDisabled,
      });
      folderIndex += 1;
    }
  };
  for (let index = 0; index < activeEnd; index += 1) {
    pushFoldersAt(index);
    if (tide !== null && index === tide.needsYouHeaderIndex) {
      result.push({
        type: "v2-section-header",
        key: "v2-needs-you-header",
        title: "Needs you",
        count: tide.needsYouCount,
        clearThreads: null,
        disabled: shelfDisabled,
      });
    }
    result.push(threadItems[index]!);
  }
  pushFoldersAt(activeEnd);
  if (workingShelfHeaderIndex !== null && workingCount > 0) {
    result.push({
      type: "v2-working-shelf",
      key: "v2-working-shelf",
      count: workingCount,
      expanded: input.workingShelfExpanded === true,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(workingShelfHeaderIndex, workingEnd));
  }
  const pushLater = () => {
    if (snoozedShelfHeaderIndex !== null && snoozedCount > 0) {
      result.push({
        type: "v2-snoozed-shelf",
        key: "v2-snoozed-shelf",
        label: tide === null ? "Snoozed" : "Later",
        count: snoozedCount,
        expanded: input.snoozedShelfExpanded === true,
        disabled: shelfDisabled,
      });
      result.push(...threadItems.slice(snoozedShelfHeaderIndex, snoozedEnd));
    }
  };
  if (tide === null) pushLater();
  if (tide !== null && trailHeaderIndex !== null && tide.trailCount > 0) {
    result.push({
      type: "v2-section-header",
      key: "v2-trail-header",
      title: "Trail",
      count: tide.trailCount,
      clearThreads: tide.trailClearThreads.length > 0 ? tide.trailClearThreads : null,
      disabled: shelfDisabled,
    });
    result.push(...threadItems.slice(trailHeaderIndex, trailEnd));
    if (tide.trailMore !== null) {
      result.push({
        type: "v2-trail-more",
        key: "v2-trail-more",
        label: tide.trailExpanded ? "Show less" : trailMoreLabel(tide.trailMore),
        expanded: tide.trailExpanded,
        disabled: shelfDisabled,
      });
    }
  }
  if (tide !== null) pushLater();
  if (settledShelfHeaderIndex !== null && settledCount > 0) {
    result.push({
      type: "v2-settled-shelf",
      key: "v2-settled-shelf",
      label: tide === null ? "Settled" : "History",
      count: settledCount,
      expanded: input.settledShelfExpanded !== false,
      disabled: shelfDisabled,
      showsAll: tide !== null && input.historyAll === true,
    });
    result.push(...threadItems.slice(settledShelfHeaderIndex));
  }
  return result.map((entry, index) => {
    if (entry.type !== "v2-thread" && entry.type !== "v2-pending") return entry;
    const next = result[index + 1];
    const showTrailingDivider =
      next?.type === "v2-thread" || (next?.type === "v2-pending" && !next.showPendingDivider);
    return showTrailingDivider === entry.showTrailingDivider
      ? entry
      : { ...entry, showTrailingDivider };
  });
}

type ThreadListV2TideInput = {
  readonly trailExpanded: boolean;
  /** Any time on the local day whose threads the Trail's expander counts as today. */
  readonly day: number;
  /** From `createOpenThreadPlacementHold`, called with `selectedThreadKey`. */
  readonly holdNeedsYou?: (key: string, needsYou: boolean, sentAt: string | null) => boolean;
  /** From `createOpenThreadTouchHold`, called with the selected thread. */
  readonly heldTouch?: ReturnType<ReturnType<typeof createOpenThreadTouchHold>>;
};

/** Splits the active threads into Needs you (longest wait first) and the Trail (latest touch first). */
function arrangeThreadListV2Tide(
  active: ReadonlyArray<EnvironmentThreadShell>,
  tide: ThreadListV2TideInput,
  selectedThreadKey: string | null,
) {
  const keyOf = (thread: EnvironmentThreadShell) => `${thread.environmentId}:${thread.id}`;
  const needsYou: EnvironmentThreadShell[] = [];
  const rest: EnvironmentThreadShell[] = [];
  for (const thread of active) {
    const needs = threadNeedsYou(thread, { includeCompleted: "owed" });
    const sentAt =
      (thread.latestUserAuthoredMessageAt === undefined
        ? thread.latestRun?.requestedAt
        : thread.latestUserAuthoredMessageAt) ?? null;
    ((tide.holdNeedsYou?.(keyOf(thread), needs, sentAt) ?? needs) ? needsYou : rest).push(thread);
  }
  // The held copy only sorts; rows keep the shells passed in, which row equality compares.
  const held = tide.heldTouch ?? null;
  const original = new Map<EnvironmentThreadShell, EnvironmentThreadShell>();
  const sorted = sortTrailThreads(
    rest.map((thread) => {
      const copy = withHeldThreadTouch(thread, held);
      if (copy !== thread) original.set(copy, thread);
      return copy;
    }),
  );
  const restore = (threads: ReadonlyArray<EnvironmentThreadShell>) =>
    threads.map((thread) => original.get(thread) ?? thread);
  const split = splitTrail(sorted, { now: tide.day });
  const trail = restore(sorted);
  const folded = restore([...split.moreToday, ...split.earlier]);
  return {
    needsYou: sortNeedsYouThreads(needsYou),
    trail,
    // The open thread stays listed, as it does in a collapsed shelf.
    visibleTrail:
      tide.trailExpanded || folded.length === 0
        ? trail
        : [
            ...restore(split.head),
            ...folded.filter((thread) => keyOf(thread) === selectedThreadKey),
          ],
    trailMore:
      folded.length === 0
        ? null
        : { moreToday: split.moreToday.length, earlier: split.earlier.length },
  };
}

// Immutable shells and field-only sorting make element-identical inputs produce identical output.
let lastSettledInput: ReadonlyArray<EnvironmentThreadShell> = [];
let lastSettledOutput: ReadonlyArray<EnvironmentThreadShell> = [];

function sortSettledThreadsReusingLast(
  settled: ReadonlyArray<EnvironmentThreadShell>,
): ReadonlyArray<EnvironmentThreadShell> {
  if (settled.length === lastSettledInput.length) {
    let same = true;
    for (let index = 0; index < settled.length; index += 1) {
      if (settled[index] !== lastSettledInput[index]) {
        same = false;
        break;
      }
    }
    if (same) return lastSettledOutput;
  }
  lastSettledInput = settled;
  lastSettledOutput = sortSettledThreads(settled);
  return lastSettledOutput;
}

/**
 * A slim row in the self-filing list: what is still to do, then the outcome. A Later row
 * leads with what it waits for instead, such as "Re-check 2 of 3" and its reason.
 */
function slimRowLine(
  thread: EnvironmentThreadShell,
  later: { readonly recheckLimit: number | null } | null = null,
): string | null {
  const lead = later === null ? null : threadLaterLead(thread, later);
  const line = threadCardRowLine(thread.card, { needsYou: false });
  return lead === null
    ? threadRowLineText({
        // An unread finished run that owes nothing sits in the Trail, marked until opened.
        owed:
          threadCardOwedLabel(thread.card) ?? (threadHasUnseenCompletion(thread) ? "Done" : null),
        line,
      })
    : threadRowLineText({ owed: lead.word, line: lead.text ?? line });
}

/** The project a slim row names above its title, unless the list is scoped to one. */
function slimRowProject(
  thread: EnvironmentThreadShell,
  input: Pick<Parameters<typeof buildThreadListV2Items>[0], "projectTitleOf" | "projectRefs">,
): string | null {
  return threadRowProjectName(input.projectTitleOf?.(thread), {
    singleProject: input.projectRefs != null,
    underProjectLabel: false,
  });
}

export function buildThreadListV2Items(input: {
  readonly pendingOrder?: PendingThreadOrder | null;
  readonly threads: ReadonlyArray<EnvironmentThreadShell>;
  readonly environmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null;
  readonly searchQuery: string;
  readonly matchedThreadKeys?: ReadonlySet<string>;
  readonly settlementEnvironmentIds?: ReadonlySet<EnvironmentId>;
  readonly snoozeEnvironmentIds?: ReadonlySet<EnvironmentId>;
  /** Each environment's `laterRecheckLimit`, for "Re-check 2 of 3" on Later rows. */
  readonly laterRecheckLimits?: ReadonlyMap<EnvironmentId, number>;
  readonly settledLimit?: number;
  readonly now: string;
  readonly workingShelfEnabled?: boolean;
  readonly workingShelfExpanded?: boolean;
  readonly isWorking?: (thread: EnvironmentThreadShell) => boolean;
  readonly inboxReturnAt?: (thread: EnvironmentThreadShell) => number | undefined;
  readonly snoozedShelfExpanded?: boolean;
  readonly settledShelfExpanded?: boolean;
  /**
   * Set to group active threads into these project folders, in order. A thread whose
   * project is in no folder is left out, as in the web sidebar.
   */
  readonly projectFolders?: ReadonlyArray<{
    readonly key: string;
    readonly title: string;
    readonly projectRefs: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectId: ProjectId;
    }>;
  }> | null;
  readonly collapsedFolderKeys?: ReadonlySet<string>;
  readonly selectedThreadKey?: string | null;
  readonly queuedThreadKeys?: ReadonlySet<string>;
  /** Whether the shelf may list a settled row yet; older settled rows load in pages. */
  readonly isListedSettled?: (thread: EnvironmentThreadShell) => boolean;
  /** Settled threads in scope that are not local (older settled threads not loaded). */
  readonly unloadedSettledCount?: number;
  /** The self-filing list: Needs you, Working, the Trail, then Later. Ignores project folders. */
  readonly tide?: ThreadListV2TideInput;
  /** Names a slim row's project in the self-filing list. */
  readonly projectTitleOf?: (thread: EnvironmentThreadShell) => string | null;
}): ThreadListV2Layout {
  const now = input.now;
  const pending =
    input.pendingOrder == null
      ? null
      : reconcilePendingThreadOrder(
          input.pendingOrder,
          getThreadListV2OrderedSection({
            ...input,
            section: input.pendingOrder.section,
            pendingOrder: null,
          }),
        );
  const query = foldSearchQuery(input.searchQuery);
  const nowMs = Date.parse(now);
  const projectKeys = input.projectRefs
    ? new Set(input.projectRefs.map((ref) => `${ref.environmentId}:${ref.projectId}`))
    : null;

  const tide = input.tide ?? null;
  const laterOf = (thread: EnvironmentThreadShell) => ({
    recheckLimit: input.laterRecheckLimits?.get(thread.environmentId) ?? null,
  });
  const workingShelfEnabled = input.workingShelfEnabled === true || tide !== null;
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  let nextSnoozeWakeAt: string | null = null;
  const queuedThreadKeys = input.queuedThreadKeys?.size ? input.queuedThreadKeys : undefined;
  const listedThreads = input.threads.filter(
    (thread) =>
      thread.archivedAt === null &&
      isListedThreadLineage(thread.lineage) &&
      (input.environmentId === null || thread.environmentId === input.environmentId) &&
      (projectKeys === null || projectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
  );
  // The same matches as the command palette, typo fallback included. Only
  // listed threads are ranked: a hidden exact match must not turn typos off.
  const rankedMatches =
    query.length > 0
      ? rankSearchItems(listedThreads, (thread, options) =>
          scoreThreadSearch(query, threadSearchSubject(thread, null), nowMs, {
            ...options,
            picks: false,
          }),
        ).map(({ item }) => item)
      : null;
  const matchingThreads = rankedMatches === null ? null : new Set(rankedMatches);
  // Threads listed only because their messages match; only their rows show
  // the message and open at it.
  const contentOnlyThreadKeys = new Set<string>();
  for (const thread of listedThreads) {
    if (matchingThreads !== null && !matchingThreads.has(thread)) {
      const key = threadSearchMatchKey({
        environmentId: thread.environmentId,
        threadId: thread.id,
      });
      if (input.matchedThreadKeys?.has(key) !== true) continue;
      contentOnlyThreadKeys.add(key);
    }
    const supportsSettlement = input.settlementEnvironmentIds?.has(thread.environmentId) ?? true;
    const supportsSnooze = input.snoozeEnvironmentIds?.has(thread.environmentId) ?? true;
    if (supportsSnooze && effectiveSnoozed(thread, { now })) {
      snoozed.push(thread);
      // A set-aside hold has no wake to arm a timer for.
      const wakeAtMs = snoozeWakeAtMs(thread.snoozedUntil);
      if (
        wakeAtMs !== null &&
        (nextSnoozeWakeAt === null || wakeAtMs < parseTimestampMs(nextSnoozeWakeAt))
      ) {
        nextSnoozeWakeAt = thread.snoozedUntil;
      }
      continue;
    }
    const hasQueuedMessages =
      queuedThreadKeys?.has(`${thread.environmentId}:${thread.id}`) === true;
    if (supportsSettlement && thread.settledOverride === "settled" && !hasQueuedMessages) {
      settled.push(thread);
    } else if (thread.pinnedAt != null) {
      pinned.push(thread);
    } else if (workingShelfEnabled && (input.isWorking ?? isThreadWorking)(thread)) {
      working.push(thread);
    } else {
      active.push(thread);
    }
  }

  if (rankedMatches !== null) {
    // Searching lists every match by rank across shelves, as the palette and
    // the web sidebar do, then threads listed for their messages in the
    // server's order. Each row keeps its shelf's look.
    const slim = new Set([...snoozed, ...settled]);
    const snoozedThreads = new Set(snoozed);
    const pinnedThreads = new Set(pinned);
    const threadByKey = new Map(
      listedThreads.map((thread) => [
        threadSearchMatchKey({ environmentId: thread.environmentId, threadId: thread.id }),
        thread,
      ]),
    );
    const contentOnly = [...(input.matchedThreadKeys ?? [])].flatMap((key) => {
      const thread = contentOnlyThreadKeys.has(key) ? threadByKey.get(key) : undefined;
      return thread ? [thread] : [];
    });
    const results = [...rankedMatches, ...contentOnly];
    return {
      items: results.map((thread, index) => ({
        thread,
        variant: slim.has(thread) ? "slim" : "card",
        snoozed: snoozedThreads.has(thread),
        pinned: pinnedThreads.has(thread),
        wokeAt: slim.has(thread) ? null : resolveThreadListV2WokeAt(thread, { now }),
        // A search can match the card, so its line says why the row is listed.
        cardLine:
          tide === null
            ? null
            : slim.has(thread)
              ? slimRowLine(thread, snoozedThreads.has(thread) ? laterOf(thread) : null)
              : threadCardRowLine(thread.card, { needsYou: false }),
        projectLine: tide !== null && slim.has(thread) ? slimRowProject(thread, input) : null,
        isLast: index === results.length - 1,
      })),
      folders: [],
      hiddenSettledCount: 0,
      listedSettledThreads: [],
      workingCount: 0,
      workingShelfHeaderIndex: null,
      snoozedCount: 0,
      snoozedShelfHeaderIndex: null,
      settledCount: 0,
      settledShelfHeaderIndex: null,
      ...EMPTY_TIDE_LAYOUT,
      nextSnoozeWakeAt,
      contentOnlyThreadKeys,
    };
  }

  const projectFolders = tide === null ? (input.projectFolders ?? null) : null;
  const selectedThreadKey = input.selectedThreadKey ?? null;
  const tideZones = tide === null ? null : arrangeThreadListV2Tide(active, tide, selectedThreadKey);
  // Folders keep the hand order, not the inbox's return order.
  const orderedActive =
    tideZones !== null
      ? tideZones.needsYou
      : workingShelfEnabled && projectFolders === null
        ? sortInboxThreadsByReturn(active, input.inboxReturnAt)
        : applyPendingThreadOrder(sortThreadsForListV2(active), "active", pending);
  const orderedWorking = sortWorkingThreadsBySend(working);
  const orderedSnoozed = sortLaterThreads(snoozed);
  const visibleWorking =
    input.workingShelfExpanded === true
      ? orderedWorking
      : orderedWorking.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const visibleSnoozed =
    input.snoozedShelfExpanded === true
      ? orderedSnoozed
      : orderedSnoozed.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const orderedSettled = sortSettledThreadsReusingLast(settled);
  const listedSettled =
    input.isListedSettled === undefined
      ? orderedSettled
      : orderedSettled.filter(input.isListedSettled);
  const settledTotal = orderedSettled.length + (input.unloadedSettledCount ?? 0);
  const settledLimit = input.settledLimit ?? Number.POSITIVE_INFINITY;
  const limitedSettled =
    listedSettled.length > settledLimit ? listedSettled.slice(0, settledLimit) : listedSettled;
  const selectedSettled =
    selectedThreadKey === null ||
    limitedSettled.some((thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey)
      ? undefined
      : orderedSettled.find(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );
  const pagedSettled =
    selectedSettled === undefined ? limitedSettled : [...limitedSettled, selectedSettled];
  const visibleSettled =
    input.settledShelfExpanded !== false
      ? pagedSettled
      : pagedSettled.filter(
          (thread) => `${thread.environmentId}:${thread.id}` === selectedThreadKey,
        );

  const items: ThreadListV2Item[] = [];
  // In the new layout, active rows are the Needs you section, so they show its open question.
  const cardLineOf = (thread: EnvironmentThreadShell, needsYou: boolean) =>
    tideZones === null
      ? null
      : threadCardRowLine(thread.card, {
          needsYou,
          request: thread.source.pendingRuntimeRequest,
        });
  const slimLineOf = (thread: EnvironmentThreadShell) =>
    tideZones === null ? null : slimRowLine(thread);
  const slimProjectOf = (thread: EnvironmentThreadShell) =>
    tideZones === null ? null : slimRowProject(thread, input);
  for (const thread of applyPendingThreadOrder(
    sortPinnedThreadsByOrderKey(pinned),
    "pinned",
    pending,
  )) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: true,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      cardLine: cardLineOf(thread, false),
      projectLine: null,
      isLast: false,
    });
  }
  const pushActive = (thread: EnvironmentThreadShell) =>
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      cardLine: cardLineOf(thread, true),
      projectLine: null,
      isLast: false,
    });
  const folders: ThreadListV2Folder[] = [];
  const needsYouHeaderIndex = tideZones !== null && orderedActive.length > 0 ? items.length : null;
  if (projectFolders === null) {
    for (const thread of orderedActive) pushActive(thread);
  } else {
    const threadsByFolder = projectFolders.map(() => [] as EnvironmentThreadShell[]);
    const folderIndexByProject = new Map<string, number>();
    projectFolders.forEach((folder, index) => {
      for (const ref of folder.projectRefs) {
        folderIndexByProject.set(`${ref.environmentId}:${ref.projectId}`, index);
      }
    });
    for (const thread of orderedActive) {
      const index = folderIndexByProject.get(`${thread.environmentId}:${thread.projectId}`);
      if (index !== undefined) threadsByFolder[index]!.push(thread);
    }
    projectFolders.forEach((folder, index) => {
      const threads = threadsByFolder[index]!;
      if (threads.length === 0) return;
      const collapsed = input.collapsedFolderKeys?.has(folder.key) === true;
      folders.push({
        key: folder.key,
        title: folder.title,
        count: threads.length,
        collapsed,
        headerIndex: items.length,
      });
      for (const thread of threads) {
        if (!collapsed || `${thread.environmentId}:${thread.id}` === selectedThreadKey) {
          pushActive(thread);
        }
      }
    });
  }
  const workingShelfHeaderIndex = orderedWorking.length > 0 ? items.length : null;
  for (const thread of visibleWorking) {
    items.push({
      thread,
      variant: "card",
      snoozed: false,
      pinned: false,
      wokeAt: resolveThreadListV2WokeAt(thread, { now }),
      cardLine: cardLineOf(thread, false),
      projectLine: null,
      isLast: false,
    });
  }
  let snoozedShelfHeaderIndex: number | null = null;
  const pushLater = () => {
    snoozedShelfHeaderIndex = orderedSnoozed.length > 0 ? items.length : null;
    for (const thread of visibleSnoozed) {
      items.push({
        thread,
        variant: "slim",
        snoozed: true,
        pinned: false,
        wokeAt: null,
        cardLine: tideZones === null ? null : slimRowLine(thread, laterOf(thread)),
        projectLine: slimProjectOf(thread),
        isLast: false,
      });
    }
  };
  // The self-filing list keeps Later at the bottom with History: put away until it wakes.
  if (tideZones === null) pushLater();
  const trailHeaderIndex = tideZones !== null && tideZones.trail.length > 0 ? items.length : null;
  for (const thread of tideZones?.visibleTrail ?? []) {
    items.push({
      thread,
      variant: "slim",
      snoozed: false,
      pinned: false,
      wokeAt: null,
      cardLine: slimLineOf(thread),
      projectLine: slimProjectOf(thread),
      isLast: false,
    });
  }
  if (tideZones !== null) pushLater();
  const settledShelfHeaderIndex = settledTotal > 0 ? items.length : null;
  for (const thread of visibleSettled) {
    items.push({
      thread,
      variant: "slim",
      snoozed: false,
      pinned: false,
      wokeAt: null,
      cardLine: slimLineOf(thread),
      projectLine: slimProjectOf(thread),
      isLast: false,
    });
  }
  const last = items.at(-1);
  if (last) {
    items[items.length - 1] = { ...last, isLast: true };
  }
  return {
    items,
    folders,
    hiddenSettledCount: Math.max(0, settledTotal - pagedSettled.length),
    listedSettledThreads: listedSettled,
    workingCount: orderedWorking.length,
    workingShelfHeaderIndex,
    snoozedCount: orderedSnoozed.length,
    snoozedShelfHeaderIndex,
    settledCount: settledTotal,
    settledShelfHeaderIndex,
    needsYouHeaderIndex,
    needsYouCount: tideZones?.needsYou.length ?? 0,
    trailHeaderIndex,
    trailCount: tideZones?.trail.length ?? 0,
    trailMore: tideZones?.trailMore ?? null,
    trailClearThreads:
      tideZones?.trail.filter(
        (thread) => `${thread.environmentId}:${thread.id}` !== selectedThreadKey,
      ) ?? [],
    nextSnoozeWakeAt,
    contentOnlyThreadKeys,
  };
}
