import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import { resolveSettledThreadTimestamp } from "@t3tools/client-runtime/state/thread-sort";
import {
  sortNeedsYouThreads,
  sortTrailThreads,
  splitTrail,
  threadCardOwedLabel,
  threadCardRowLine,
  threadLastSentAt,
  threadLaterLead,
  threadNeedsYou,
  threadRowLineText,
  threadStatusKind,
  threadStatusWord,
  threadWaitingSince,
  trailDayLabel,
  type ThreadStatusKind,
} from "@t3tools/client-runtime/state/thread-zones";

import { filterSidebarV2VisibleThreads, resolveSidebarThreadSection } from "../Sidebar.logic";

type Thread = EnvironmentThreadShell;

const keyOf = (thread: Pick<Thread, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

/** Where a thread's project sits in the project order, and what to call it. */
export type TideProjectOf = (thread: Thread) => { readonly rank: number; readonly label: string };

/** The label above the first row of each run of rows that share one. */
function groupLabels(
  threads: readonly Thread[],
  labelOf: (thread: Thread) => string | null,
): Map<string, string> {
  const labels = new Map<string, string>();
  let previous: string | null = null;
  for (const thread of threads) {
    const label = labelOf(thread);
    if (label !== null && label !== previous) labels.set(keyOf(thread), label);
    previous = label;
  }
  return labels;
}

function groupByProject(threads: readonly Thread[], projectOf: TideProjectOf) {
  const ranked = threads.map((thread, index) => ({ thread, index, ...projectOf(thread) }));
  ranked.sort((left, right) => left.rank - right.rank || left.index - right.index);
  const sorted = ranked.map(({ thread }) => thread);
  return {
    threads: sorted,
    groupLabelByKey: groupLabels(sorted, (thread) => projectOf(thread).label),
    projectLabelledKeys: new Set(sorted.map(keyOf)),
  };
}

const NO_KEYS: ReadonlySet<string> = new Set();

/**
 * Splits the active bucket into Needs you (longest wait first) and the Trail
 * (latest message you sent first). The Trail shows its first rows; expanded, it adds the
 * rest under day labels, or under project labels when `projectOf` is set.
 */
export function arrangeTideActive(input: {
  readonly active: readonly Thread[];
  readonly isNeedsYou: (thread: Thread) => boolean;
  readonly nowMs: number;
  readonly trailExpanded: boolean;
  readonly routeKey: string | null;
  readonly projectOf: TideProjectOf | null;
}) {
  const needsYou = sortNeedsYouThreads(input.active.filter(input.isNeedsYou));
  const trail = sortTrailThreads(input.active.filter((thread) => !input.isNeedsYou(thread)));
  const { head, moreToday, earlier } = splitTrail(trail, { now: input.nowMs });
  // The time each row shows is the one it is sorted by, so the column reads in order.
  const timeAtByKey = new Map<string, number>([
    ...needsYou.map((thread) => [keyOf(thread), threadWaitingSince(thread)] as const),
    ...trail.map((thread) => [keyOf(thread), threadLastSentAt(thread)] as const),
  ]);
  const rest = [...moreToday, ...earlier];
  if (!input.trailExpanded) {
    // The open thread stays listed, as it does in a collapsed shelf, and leaves the expander's count.
    const isOpen = (thread: Thread) => keyOf(thread) === input.routeKey;
    return {
      needsYou,
      trail,
      visibleTrail: [...head, ...rest.filter(isOpen)],
      counts: {
        moreToday: moreToday.filter((thread) => !isOpen(thread)).length,
        earlier: earlier.filter((thread) => !isOpen(thread)).length,
      },
      timeAtByKey,
      groupLabelByKey: new Map<string, string>(),
      groupDividerKey: null,
      projectLabelledKeys: NO_KEYS,
    };
  }
  const counts = { moreToday: moreToday.length, earlier: earlier.length };
  const today = new Set(moreToday);
  const grouped =
    input.projectOf === null
      ? {
          threads: rest,
          groupLabelByKey: groupLabels(rest, (thread) =>
            today.has(thread) ? null : trailDayLabel(threadLastSentAt(thread), input.nowMs),
          ),
          projectLabelledKeys: NO_KEYS,
        }
      : groupByProject(rest, input.projectOf);
  return {
    needsYou,
    trail,
    visibleTrail: [...head, ...grouped.threads],
    counts,
    timeAtByKey,
    groupLabelByKey: grouped.groupLabelByKey,
    // Project groups leave last-touch order, so a rule marks where they start below the first rows.
    groupDividerKey:
      input.projectOf !== null && head.length > 0 && grouped.threads[0] !== undefined
        ? keyOf(grouped.threads[0])
        : null,
    // Rows under a project label, which then need not name their project themselves.
    projectLabelledKeys: grouped.projectLabelledKeys,
  };
}

/** History rows under day labels, or regrouped under project labels. */
export function arrangeTideHistory(
  settled: readonly Thread[],
  options: { readonly nowMs: number; readonly projectOf: TideProjectOf | null },
): {
  readonly threads: readonly Thread[];
  readonly groupLabelByKey: Map<string, string>;
  readonly projectLabelledKeys: ReadonlySet<string>;
} {
  if (options.projectOf !== null) return groupByProject(settled, options.projectOf);
  return {
    threads: settled,
    projectLabelledKeys: NO_KEYS,
    groupLabelByKey: groupLabels(settled, (thread) => {
      const settledAt = Date.parse(resolveSettledThreadTimestamp(thread) ?? "");
      return Number.isNaN(settledAt) ? null : trailDayLabel(settledAt, options.nowMs);
    }),
  };
}

/** The rows as drawn, top to bottom; jumps and next/previous index this. */
export function tideRenderedOrder<T>(sections: {
  readonly pinned: readonly T[];
  readonly needsYou: readonly T[];
  readonly working: readonly T[];
  readonly later: readonly T[];
  readonly trail: readonly T[];
  readonly history: readonly T[];
}): T[] {
  return [
    ...sections.pinned,
    ...sections.needsYou,
    ...sections.trail,
    ...sections.working,
    ...sections.later,
    ...sections.history,
  ];
}

/**
 * Threads that need you in projects the current scope leaves out, longest wait
 * first. Hidden projects stay out: `unscopedProjectKeys` is the list with no
 * project picked.
 */
export function needsYouElsewhere(input: {
  readonly threads: readonly Thread[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
  readonly unscopedProjectKeys: ReadonlySet<string> | null;
  readonly delegatedUnderParent: ReadonlySet<string>;
  readonly settlementKnown: (thread: Thread) => boolean;
  readonly now: string;
}): Thread[] {
  const scoped = input.scopedProjectKeys;
  if (scoped === null) return [];
  return sortNeedsYouThreads(
    filterSidebarV2VisibleThreads(
      input.threads,
      input.unscopedProjectKeys,
      input.delegatedUnderParent,
    ).filter((thread) => {
      if (scoped.has(`${thread.environmentId}:${thread.projectId}`)) return false;
      const known = input.settlementKnown(thread);
      const section = resolveSidebarThreadSection({
        snoozed: known && effectiveSnoozed(thread, { now: input.now }),
        settled: known && thread.settledOverride === "settled",
        pinned: thread.pinnedAt != null,
      });
      return (
        (section === "active" || section === "pinned") &&
        !isThreadWorking(thread) &&
        threadNeedsYou(thread, { includeCompleted: false })
      );
    }),
  );
}

/**
 * The thread after the open one among those that need you, wrapping. With none
 * left in scope it is the first one elsewhere.
 */
export function nextNeedsYouKey(input: {
  readonly keys: readonly string[];
  readonly elsewhereKeys: readonly string[];
  readonly currentKey: string | null;
}): string | null {
  const { keys, currentKey } = input;
  const index = currentKey === null ? -1 : keys.indexOf(currentKey);
  const next = index === -1 ? keys[0] : keys[(index + 1) % keys.length];
  if (next !== undefined && next !== currentKey) return next;
  return input.elsewhereKeys.find((key) => key !== currentKey) ?? null;
}

/** Clearing the Trail leaves the open thread: settling it would navigate away. */
export function trailThreadsToClear(trail: readonly Thread[], routeKey: string | null): Thread[] {
  return trail.filter((thread) => keyOf(thread) !== routeKey);
}

/**
 * What a row's time means in the new layout, and the time itself, for the
 * row's label and its hover card. Null where the row shows no time of its own.
 */
export function resolveTideRowTime(input: {
  readonly variantAction: "settle" | "unsettle" | "unsnooze";
  readonly needsYou: boolean;
  readonly tideTimeAt: number | null;
  /** From `threadLaterAt`: never a set-aside thread's placeholder date. */
  readonly laterAt: string | null;
  readonly recheck: boolean;
  readonly settledAt: string | null;
}): { readonly label: string; readonly at: string } | null {
  if (input.variantAction === "unsnooze") {
    return input.laterAt === null
      ? null
      : { label: input.recheck ? "Re-checks" : "Wakes", at: input.laterAt };
  }
  if (input.variantAction === "unsettle") {
    return input.settledAt === null ? null : { label: "Settled", at: input.settledAt };
  }
  if (input.tideTimeAt === null) return null;
  return {
    label: input.needsYou ? "Waiting on you since" : "Last opened or written",
    at: new Date(input.tideTimeAt).toISOString(),
  };
}

/** A row's status colour: the shared status kinds plus the web's usage limit and woken snooze. */
export type TideStatusTone = ThreadStatusKind | "limited" | "woke";

export type TideRowLead =
  | { readonly kind: "status"; readonly tone: TideStatusTone; readonly word: string }
  | { readonly kind: "owed"; readonly word: string };

const RUNNING_KINDS: ReadonlySet<ThreadStatusKind> = new Set(["working", "connecting", "waiting"]);
// A woken snooze outranks these, but not a thread that is busy or asks for something.
const WOKE_OUTRANKS: ReadonlySet<ThreadStatusKind> = new Set(["plan", "completed", "question"]);

/**
 * What leads a row's last line in the new layout, and the text after it. Rows that show status
 * (Needs you, Working, pinned) lead with it and, unless running, say what the thread asks;
 * every other row leads with what is still owed and its outcome. A woken snooze shows anywhere.
 */
export function resolveTideRowLead(
  thread: Thread,
  options: {
    readonly showsStatus: boolean;
    readonly isWoke: boolean;
    /** Set on Later rows, which lead with what they wait for. */
    readonly later?: { readonly recheckLimit: number | null } | undefined;
  },
): { readonly lead: TideRowLead | null; readonly text: string | null; readonly running: boolean } {
  const kind = threadStatusKind(thread);
  const running = kind !== null && RUNNING_KINDS.has(kind);
  const line = (asks: boolean) =>
    threadCardRowLine(thread.card, {
      needsYou: asks,
      request: thread.source.pendingRuntimeRequest,
    });
  if (options.isWoke && (kind === null || WOKE_OUTRANKS.has(kind))) {
    return { lead: { kind: "status", tone: "woke", word: "Woke" }, text: line(false), running };
  }
  const later = options.later === undefined ? null : threadLaterLead(thread, options.later);
  if (later !== null) {
    return { lead: { kind: "owed", word: later.word }, text: later.text ?? line(false), running };
  }
  // A finished run leads with Done; what it still owes starts the text.
  if (kind === "completed" && options.showsStatus) {
    return {
      lead: { kind: "status", tone: "completed", word: threadStatusWord("completed") },
      text: threadRowLineText({ owed: threadCardOwedLabel(thread.card), line: line(false) }),
      running,
    };
  }
  if (kind !== null && options.showsStatus) {
    const limited = kind === "failed" && thread.runtime?.lastErrorClass === "usage_limit";
    const word = limited
      ? "Limited"
      : kind === "working" && thread.goal?.status === "active"
        ? "Goal"
        : threadStatusWord(kind, {
            userOnlyRequest: thread.source.pendingRuntimeRequest?.userOnly === true,
          });
    return {
      lead: { kind: "status", tone: limited ? "limited" : kind, word },
      text: line(!running),
      running,
    };
  }
  const owed = threadCardOwedLabel(thread.card);
  return { lead: owed === null ? null : { kind: "owed", word: owed }, text: line(false), running };
}
