import {
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ServerCommand,
  type RunId,
  THREAD_CARD_OPEN_MAX,
  THREAD_ENTRY_OUTCOME_MAX,
  THREAD_ENTRY_RUNS_MAX,
  THREAD_REGROUP_MARKS,
  THREAD_RUN_OWNER_TEXT_MAX,
  type ThreadCard,
  type ThreadCardOpenItem,
  threadCardOpenItemKey,
  type ThreadContentsState,
  type ThreadEntriesUpdate,
  type ThreadEntry,
  type ThreadEntryFiling,
  ThreadEntryId,
  type ThreadEntryOpenItem,
  type ThreadEntryRun,
  type ThreadId,
  type ThreadRunLine,
} from "@t3tools/contracts";

import type {
  ThreadCardContents,
  ThreadCardEntryLine,
  ThreadRunStarter,
} from "../textGeneration/ThreadCard.ts";

// From the grouping experiment, where these continued the previous topic in every lenient reading.
const GO_AHEAD =
  /^(yes+|yeah|yep|sure|ok(ay)?|k|do (it|that)|go ahead|fix (it|that)|add (it|that|them)|build it|again|published|nice|looks? good|that'?s fine|check that|done)\b[\s\w,.!?]*$/i;
const GO_AHEAD_WORDS_MAX = 4;
const PROMPT_ENTRIES_MAX = 20;
const OWNER_TEXT_START_CHARS = 170;
const OWNER_TEXT_MID_RUN_CHARS = 100;
const OPEN_ITEM_SHARED_WORDS = 0.6;

/** What one thread's contents hold when a run is filed. */
export interface ThreadContents {
  /** Active and retired, in order of first appearance. */
  readonly entries: ReadonlyArray<ThreadEntry>;
  readonly state: ThreadContentsState | null;
  /** The active entries the latest run line is filed under, its first entry first. */
  readonly previousRunEntryIds: ReadonlyArray<ThreadEntryId>;
}

export const EMPTY_STATE: ThreadContentsState = {
  revision: 0,
  nextEntrySeq: 1,
  ownerRuns: 0,
  lastRunOrdinal: 0,
  lastReplyAt: null,
  runsSinceRegroup: 0,
  regroupRequestedThrough: 0,
  regroupedThrough: 0,
  regroupedAt: null,
};

/** A whole message of four words or fewer that only says "go on". */
export function isGoAhead(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.split(/\s+/).length <= GO_AHEAD_WORDS_MAX && GO_AHEAD.test(trimmed);
}

type MessageOrigin = Pick<
  OrchestrationV2ConversationMessage,
  "createdBy" | "notification" | "delegatedCompletion" | "scheduledTaskId" | "followUp"
>;

/** The user typed it: not a wake, a subagent report, a scheduled task or a Later re-check. */
export function isOwnerMessage(message: MessageOrigin): boolean {
  return (
    message.createdBy === "user" &&
    message.notification === undefined &&
    message.delegatedCompletion === undefined &&
    message.scheduledTaskId === undefined &&
    message.followUp !== true
  );
}

export function runStarter(message: MessageOrigin | undefined): ThreadRunStarter {
  if (message === undefined) return "other";
  if (message.notification !== undefined || message.delegatedCompletion !== undefined) {
    return "report";
  }
  return isOwnerMessage(message) ? "owner" : "other";
}

const collapse = (text: string, maxChars: number) =>
  text.replace(/\s+/g, " ").trim().slice(0, maxChars).trim();

/** The owner's words as a regroup outline shows them. */
export function runOwnerText(input: {
  readonly startedBy: ThreadRunStarter;
  readonly startText: string | null;
  readonly midRun: ReadonlyArray<string>;
}): string | null {
  const start =
    input.startedBy === "report" || input.startText === null
      ? ""
      : collapse(input.startText, OWNER_TEXT_START_CHARS);
  const also = input.midRun
    .map((text) => collapse(text, OWNER_TEXT_MID_RUN_CHARS))
    .filter((text) => text !== "");
  const text =
    start === ""
      ? also.join(" / ")
      : also.length === 0
        ? start
        : `${start} / also: ${also.join(" / ")}`;
  return text === "" ? null : text.slice(0, THREAD_RUN_OWNER_TEXT_MAX);
}

const entrySeq = (id: ThreadEntryId) => Number(id.slice(id.lastIndexOf(":e") + 2));

/** Order of first appearance: by start, then by the order the entries were made. */
export function compareEntries(left: ThreadEntry, right: ThreadEntry): number {
  if (left.startedAt !== right.startedAt) return left.startedAt < right.startedAt ? -1 : 1;
  return entrySeq(left.id) - entrySeq(right.id);
}

/** The 20 most recently worked-on active entries, in order of first appearance, as `e1`, `e2`, … */
export function contentsForPrompt(contents: ThreadContents): {
  readonly contents: ThreadCardContents;
  readonly refToId: ReadonlyMap<string, ThreadEntryId>;
} {
  const active = contents.entries.filter((entry) => entry.status === "active");
  const recent = new Set(
    [...active]
      .sort((left, right) =>
        left.endedAt === right.endedAt ? 0 : left.endedAt > right.endedAt ? -1 : 1,
      )
      .slice(0, PROMPT_ENTRIES_MAX),
  );
  const shown = active.filter((entry) => recent.has(entry)).sort(compareEntries);
  const refToId = new Map<string, ThreadEntryId>();
  const idToRef = new Map<ThreadEntryId, string>();
  shown.forEach((entry, index) => {
    refToId.set(`e${index + 1}`, entry.id);
    idToRef.set(entry.id, `e${index + 1}`);
  });
  return {
    contents: {
      entries: shown.map((entry) => ({
        ref: idToRef.get(entry.id)!,
        title: entry.title,
        outcome: entry.outcome,
        open: entry.open.length > 0,
      })),
      previousRefs: contents.previousRunEntryIds.flatMap((id) => idToRef.get(id) ?? []),
    },
    refToId,
  };
}

/** The seam: how a run gets its filing. Today it is what the card call wrote. */
export function fileRun(input: {
  readonly parsed: ReadonlyArray<ThreadCardEntryLine>;
  readonly refToId: ReadonlyMap<string, ThreadEntryId>;
}): ReadonlyArray<ThreadEntryFiling> {
  return input.parsed.flatMap((entry): Array<ThreadEntryFiling> => {
    if (entry.ref === "new") {
      return [
        {
          ref: "new",
          ...(entry.title === null ? {} : { title: entry.title }),
          outcome: entry.outcome,
        },
      ];
    }
    const id = input.refToId.get(entry.ref);
    return id === undefined ? [] : [{ ref: id, outcome: entry.outcome }];
  });
}

const openItemWords = (item: ThreadCardOpenItem) =>
  new Set(
    threadCardOpenItemKey(item)
      .slice(item.kind.length + 1)
      .split(" ")
      .filter((word) => word !== ""),
  );

const sameKey = (held: ThreadCardOpenItem, item: ThreadCardOpenItem) =>
  threadCardOpenItemKey(held) === threadCardOpenItemKey(item);

// The card is told to carry items in the same words, and sometimes rewords them.
function reworded(held: ThreadCardOpenItem, item: ThreadCardOpenItem): boolean {
  if (held.kind !== item.kind) return false;
  const heldWords = openItemWords(held);
  const itemWords = openItemWords(item);
  const shared = [...heldWords].filter((word) => itemWords.has(word)).length;
  return shared > 0 && shared >= OPEN_ITEM_SHARED_WORDS * Math.max(heldWords.size, itemWords.size);
}

const entryOpenItem = (item: ThreadCardOpenItem, runId: RunId): ThreadEntryOpenItem => ({
  kind: item.kind,
  text: item.text,
  ...(item.dueAt === undefined ? {} : { dueAt: item.dueAt }),
  runId,
});

const sameOpen = (
  left: ReadonlyArray<ThreadEntryOpenItem>,
  right: ReadonlyArray<ThreadEntryOpenItem>,
) =>
  left.length === right.length &&
  left.every(
    (item, index) =>
      item.kind === right[index]!.kind &&
      item.text === right[index]!.text &&
      item.dueAt === right[index]!.dueAt &&
      item.runId === right[index]!.runId,
  );

/**
 * Makes the active entries hold exactly the card's open items. An item the entries already hold
 * stays where it is with its run and takes the card's wording; a new one goes to `firstEntryId`;
 * one the card dropped is removed. Unchanged entries keep their identity.
 */
export function syncOpenItems(
  entries: ReadonlyArray<ThreadEntry>,
  cardOpen: ReadonlyArray<ThreadCardOpenItem>,
  runId: RunId,
  firstEntryId: ThreadEntryId,
): ReadonlyArray<ThreadEntry> {
  const held = entries.flatMap((entry) =>
    entry.status === "active" ? entry.open.map((item) => ({ entryId: entry.id, item })) : [],
  );
  const matched: Array<ThreadCardOpenItem | undefined> = held.map(() => undefined);
  const claim = (
    item: ThreadCardOpenItem,
    test: (held: ThreadCardOpenItem, item: ThreadCardOpenItem) => boolean,
  ) => {
    const index = held.findIndex(
      (candidate, position) => matched[position] === undefined && test(candidate.item, item),
    );
    if (index >= 0) matched[index] = item;
    return index >= 0;
  };
  const fresh = cardOpen
    .filter((item) => !claim(item, sameKey))
    .filter((item) => !claim(item, reworded));

  const next = new Map<ThreadEntryId, Array<ThreadEntryOpenItem>>();
  const push = (entryId: ThreadEntryId, item: ThreadEntryOpenItem) =>
    next.set(entryId, [...(next.get(entryId) ?? []), item]);
  held.forEach(({ entryId, item }, index) => {
    const current = matched[index];
    if (current !== undefined) push(entryId, entryOpenItem(current, item.runId));
  });
  for (const item of fresh) push(firstEntryId, entryOpenItem(item, runId));

  return entries.map((entry) => {
    if (entry.status !== "active") return entry;
    const open = next.get(entry.id) ?? [];
    return sameOpen(entry.open, open) ? entry : { ...entry, open };
  });
}

const titleKey = (title: string) =>
  title
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, "")
    .replace(/\s+/g, " ")
    .trim();

type Choice =
  | { readonly id: ThreadEntryId; readonly outcome: string }
  /** A new entry. */
  | { readonly id: null; readonly title: string | undefined; readonly outcome: string };

/**
 * Files one carded run under one or two entries, applying the experiment's code rules on top of
 * the filer's answer, and keeps the entries' open items equal to the card's. Null when the run is
 * already filed (an effect replay).
 */
export function assignEntries(
  input: ThreadContents & {
    readonly run: ThreadRunLine;
    readonly goAhead: boolean;
    readonly ownerSpokeMidRun: boolean;
    readonly filing: ReadonlyArray<ThreadEntryFiling>;
    /** After `nextThreadCard`, so asks the user already answered are gone. */
    readonly card: Pick<ThreadCard, "line" | "open">;
  },
): { readonly update: ThreadEntriesUpdate; readonly mark: number | null } | null {
  const { run, card } = input;
  if (input.entries.some((entry) => entry.runs.some((link) => link.runId === run.runId))) {
    return null;
  }
  const byId = new Map(input.entries.map((entry) => [entry.id, entry]));
  const resolve = (id: ThreadEntryId): ThreadEntry | undefined => {
    const entry = byId.get(id);
    if (entry?.status === "active") return entry;
    const target = entry?.mergedInto === undefined ? undefined : byId.get(entry.mergedInto);
    return target?.status === "active" ? target : undefined;
  };
  const active = input.entries.filter((entry) => entry.status === "active");
  const previous = [...new Set(input.previousRunEntryIds.flatMap((id) => resolve(id)?.id ?? []))];
  const latest = active.reduce<ThreadEntry | undefined>(
    (best, entry) => (best === undefined || entry.endedAt > best.endedAt ? entry : best),
    undefined,
  );
  const fallback = previous[0] ?? latest?.id;

  let choices: ReadonlyArray<Choice>;
  if (fallback === undefined) {
    const first = input.filing[0];
    choices = [
      {
        id: null,
        title: first?.ref === "new" ? first.title : undefined,
        outcome: first?.outcome ?? "",
      },
    ];
  } else {
    let filed = input.filing.flatMap((filing): Array<Choice> => {
      if (filing.ref === "new") return [{ id: null, title: filing.title, outcome: filing.outcome }];
      const entry = resolve(filing.ref);
      return entry === undefined ? [] : [{ id: entry.id, outcome: filing.outcome }];
    });
    if (input.goAhead && previous.length > 0) {
      const kept = filed.filter((choice) => choice.id !== null && previous.includes(choice.id));
      filed = kept.length > 0 ? kept : [{ id: previous[0]!, outcome: card.line }];
    }
    filed = filed.map((choice): Choice => {
      if (choice.id !== null) return choice;
      const key = choice.title === undefined ? "" : titleKey(choice.title);
      const same = key === "" ? undefined : active.find((entry) => titleKey(entry.title) === key);
      if (same !== undefined) return { id: same.id, outcome: choice.outcome };
      // A run nobody typed into never starts a topic.
      if (run.startedBy === "report" && !input.ownerSpokeMidRun) {
        return { id: fallback, outcome: choice.outcome };
      }
      return choice;
    });
    choices = filed.length > 0 ? filed : [{ id: fallback, outcome: card.line }];
  }
  const seen = new Set<string>();
  choices = choices
    .filter((choice) => {
      const key = choice.id === null ? `new:${titleKey(choice.title ?? card.line)}` : choice.id;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 2);

  const state = input.state ?? EMPTY_STATE;
  let nextEntrySeq = state.nextEntrySeq;
  const filed: Array<ThreadEntry> = [];
  choices.forEach((choice, index) => {
    const link: ThreadEntryRun = {
      runId: run.runId,
      source: "online",
      ...(index > 0 ? { second: true as const } : {}),
    };
    const outcome = choice.outcome === "" ? card.line : choice.outcome;
    if (choice.id === null) {
      filed.push({
        id: ThreadEntryId.make(`${run.threadId}:e${nextEntrySeq++}`),
        threadId: run.threadId,
        title: choice.title ?? card.line,
        titleSource: "model",
        outcome,
        open: [],
        runs: [link],
        startMessageId: run.userMessageId,
        endMessageId: run.replyMessageId,
        startedAt: run.startedAt,
        endedAt: run.repliedAt,
        status: "active",
      });
      return;
    }
    const entry = byId.get(choice.id)!;
    filed.push({
      ...entry,
      outcome,
      runs: [...entry.runs, link].slice(-THREAD_ENTRY_RUNS_MAX),
      endMessageId: run.replyMessageId,
      endedAt: run.repliedAt,
    });
  });

  const filedById = new Map(filed.map((entry) => [entry.id, entry]));
  const linked = [
    ...input.entries.map((entry) => filedById.get(entry.id) ?? entry),
    ...filed.filter((entry) => !byId.has(entry.id)),
  ];
  const synced = syncOpenItems(linked, card.open, run.runId, filed[0]!.id);
  const ownerRuns = state.ownerRuns + (run.startedBy === "owner" ? 1 : 0);
  return {
    update: {
      entries: synced.filter((entry, index) => entry !== linked[index] || filedById.has(entry.id)),
      runLines: [run],
      state: {
        ...state,
        revision: state.revision + 1,
        nextEntrySeq,
        ownerRuns,
        lastRunOrdinal: Math.max(state.lastRunOrdinal, run.ordinal),
        lastReplyAt: run.repliedAt,
        runsSinceRegroup: state.runsSinceRegroup + 1,
      },
    },
    mark: run.startedBy === "owner" && THREAD_REGROUP_MARKS.includes(ownerRuns) ? ownerRuns : null,
  };
}

/** The run line a card record carries, or null for a card written without its run. */
export function cardRunLine(
  command: Extract<OrchestrationV2ServerCommand, { readonly type: "thread.card.record" }>,
): ThreadRunLine | null {
  if (command.run === undefined) return null;
  return {
    runId: command.runId,
    threadId: command.threadId,
    ordinal: command.run.ordinal,
    userMessageId: command.run.userMessageId,
    replyMessageId: command.messageId,
    line: command.line,
    ownerText: command.run.ownerText,
    startedBy: command.run.startedBy,
    startedAt: command.run.startedAt,
    repliedAt: command.repliedAt,
  };
}

const latestActive = (entries: ReadonlyArray<ThreadEntry>) =>
  entries.reduce<ThreadEntry | undefined>(
    (best, entry) =>
      entry.status === "active" && (best === undefined || entry.endedAt > best.endedAt)
        ? entry
        : best,
    undefined,
  );

/** The active entry that holds a run's first link, else the one worked on last. */
function homeFor(entries: ReadonlyArray<ThreadEntry>, runId: RunId): ThreadEntry | undefined {
  return (
    entries.find(
      (entry) =>
        entry.status === "active" &&
        entry.runs.some((link) => link.runId === runId && link.second !== true),
    ) ?? latestActive(entries)
  );
}

/**
 * Moves every open item to the entry that now holds its run's first link, or to the entry worked
 * on last when its run is in none. With no active entry the items leave the entries; the card
 * still holds them and the next filed run attaches them again.
 */
export function rehomeOpenItems(entries: ReadonlyArray<ThreadEntry>): ReadonlyArray<ThreadEntry> {
  const next = new Map<ThreadEntryId, Array<ThreadEntryOpenItem>>();
  for (const entry of entries) {
    for (const item of entry.open) {
      const home = homeFor(entries, item.runId);
      if (home !== undefined) next.set(home.id, [...(next.get(home.id) ?? []), item]);
    }
  }
  return entries.map((entry) => {
    const open = next.get(entry.id) ?? [];
    return sameOpen(entry.open, open) ? entry : { ...entry, open };
  });
}

/** Start and end from the entry's remaining runs, in run order. */
export function withSpan(
  entry: ThreadEntry,
  lines: ReadonlyMap<RunId, ThreadRunLine>,
): ThreadEntry {
  const spanned = entry.runs
    .flatMap((link) => lines.get(link.runId) ?? [])
    .sort((left, right) => left.ordinal - right.ordinal);
  const first = spanned[0];
  const last = spanned.at(-1);
  if (first === undefined || last === undefined) return entry;
  return {
    ...entry,
    startMessageId: first.userMessageId,
    startedAt: first.startedAt,
    endMessageId: last.replyMessageId,
    endedAt: last.repliedAt,
  };
}

const changedEntries = (before: ReadonlyArray<ThreadEntry>, after: ReadonlyArray<ThreadEntry>) =>
  after.filter((entry, index) => entry !== before[index]);

/**
 * Takes a rolled-back run out of the contents: its links go, an entry left with no runs is
 * retired, spans and counts are recomputed, and its open items move to the entry worked on last.
 * `runLines` are the thread's lines before the removal.
 */
export function withoutRun(
  contents: ThreadContents,
  runLines: ReadonlyArray<ThreadRunLine>,
  runId: RunId,
): ThreadEntriesUpdate | null {
  if (contents.state === null || !runLines.some((line) => line.runId === runId)) return null;
  const remaining = runLines.filter((line) => line.runId !== runId);
  const byRun = new Map(remaining.map((line) => [line.runId, line]));
  const unlinked = contents.entries.map((entry): ThreadEntry => {
    if (!entry.runs.some((link) => link.runId === runId)) return entry;
    const runs = entry.runs.filter((link) => link.runId !== runId);
    if (runs.length === 0) {
      const { mergedInto: _mergedInto, ...rest } = entry;
      return { ...rest, runs, status: "retired" };
    }
    return withSpan({ ...entry, runs }, byRun);
  });
  const rehomed = rehomeOpenItems(unlinked);
  return {
    entries: changedEntries(contents.entries, rehomed),
    runLines: [],
    state: {
      ...contents.state,
      revision: contents.state.revision + 1,
      ownerRuns: remaining.filter((line) => line.startedBy === "owner").length,
      lastRunOrdinal: Math.max(0, ...remaining.map((line) => line.ordinal)),
      lastReplyAt: remaining.reduce<string | null>(
        (latest, line) => (latest === null || line.repliedAt > latest ? line.repliedAt : latest),
        null,
      ),
      runsSinceRegroup: remaining.filter(
        (line) => line.ordinal > (contents.state?.regroupedThrough ?? 0),
      ).length,
    },
  };
}

/** Removes the matching open items from the entries, as the same rule removes them from the card. */
export function removeOpenItems(
  contents: ThreadContents,
  match: (item: ThreadCardOpenItem) => boolean,
): ThreadEntriesUpdate | null {
  if (contents.state === null) return null;
  const entries = contents.entries.flatMap((entry) =>
    entry.status === "active" && entry.open.some(match)
      ? [{ ...entry, open: entry.open.filter((item) => !match(item)) }]
      : [],
  );
  if (entries.length === 0) return null;
  return {
    entries,
    runLines: [],
    state: { ...contents.state, revision: contents.state.revision + 1 },
  };
}

/** The items Undo puts back on a card: those it does not hold already, while there is room. */
export function itemsToRestore(
  cardOpen: ReadonlyArray<ThreadCardOpenItem>,
  items: ReadonlyArray<ThreadEntryOpenItem>,
): ReadonlyArray<ThreadEntryOpenItem> {
  const keys = new Set(cardOpen.map(threadCardOpenItemKey));
  const restored: Array<ThreadEntryOpenItem> = [];
  for (const item of items) {
    const key = threadCardOpenItemKey(item);
    if (keys.has(key) || cardOpen.length + restored.length >= THREAD_CARD_OPEN_MAX) continue;
    keys.add(key);
    restored.push(item);
  }
  return restored;
}

/** Puts restored items back on the entry that now holds each one's run. */
export function restoreOpenItems(
  contents: ThreadContents,
  items: ReadonlyArray<ThreadEntryOpenItem>,
): ThreadEntriesUpdate | null {
  if (contents.state === null || items.length === 0) return null;
  let entries = contents.entries;
  for (const item of items) {
    const home = homeFor(entries, item.runId);
    if (home === undefined) continue;
    entries = entries.map((entry) =>
      entry.id === home.id ? { ...entry, open: [...entry.open, item] } : entry,
    );
  }
  const changed = changedEntries(contents.entries, entries);
  if (changed.length === 0) return null;
  return {
    entries: changed,
    runLines: [],
    state: { ...contents.state, revision: contents.state.revision + 1 },
  };
}

/** A hand edit either changes the entries (null: nothing to change) or is refused with a reason. */
export type HandEditResult =
  | { readonly update: ThreadEntriesUpdate | null }
  | { readonly refused: string };

const NO_CONTENTS = "This thread has no topics yet.";
const GONE = "That topic is no longer in this thread.";

/** The active entry an id names, following a retired entry's pointer. */
function activeEntry(
  entries: ReadonlyArray<ThreadEntry>,
  id: ThreadEntryId,
): ThreadEntry | undefined {
  const entry = entries.find((candidate) => candidate.id === id);
  if (entry?.status === "active") return entry;
  const target = entries.find((candidate) => candidate.id === entry?.mergedInto);
  return target?.status === "active" ? target : undefined;
}

const retire = (entry: ThreadEntry, into: ThreadEntryId): ThreadEntry => ({
  ...entry,
  runs: [],
  status: "retired",
  mergedInto: into,
});

const byRunOrder =
  (lines: ReadonlyMap<RunId, ThreadRunLine>) => (left: ThreadEntryRun, right: ThreadEntryRun) =>
    (lines.get(left.runId)?.ordinal ?? Number.MAX_SAFE_INTEGER) -
    (lines.get(right.runId)?.ordinal ?? Number.MAX_SAFE_INTEGER);

/**
 * The end of every hand edit: retired pointers follow on to an active entry so they stay one hop,
 * changed entries get their span from their runs, and open items follow their runs. `edited` is
 * `contents.entries` in the same order with any new entries after them.
 */
function finishEdit(
  contents: ThreadContents & { readonly state: ThreadContentsState },
  edited: ReadonlyArray<ThreadEntry>,
  lines: ReadonlyMap<RunId, ThreadRunLine>,
  nextEntrySeq = contents.state.nextEntrySeq,
): ThreadEntriesUpdate | null {
  const byId = new Map(edited.map((entry) => [entry.id, entry]));
  const pointed = edited.map((entry, index): ThreadEntry => {
    const spanned = entry === contents.entries[index] ? entry : withSpan(entry, lines);
    if (spanned.status !== "retired" || spanned.mergedInto === undefined) return spanned;
    const visited = new Set([spanned.id]);
    let target = byId.get(spanned.mergedInto);
    while (target !== undefined && target.status === "retired" && !visited.has(target.id)) {
      visited.add(target.id);
      target = target.mergedInto === undefined ? undefined : byId.get(target.mergedInto);
    }
    return target?.status !== "active" || target.id === spanned.mergedInto
      ? spanned
      : { ...spanned, mergedInto: target.id };
  });
  const rehomed = rehomeOpenItems(pointed);
  const changed = rehomed.filter(
    (entry, index) => index >= contents.entries.length || entry !== contents.entries[index],
  );
  if (changed.length === 0) return null;
  return {
    entries: changed,
    runLines: [],
    state: { ...contents.state, revision: contents.state.revision + 1, nextEntrySeq },
  };
}

const hasState = (
  contents: ThreadContents,
): contents is ThreadContents & { readonly state: ThreadContentsState } => contents.state !== null;

const cleanTitle = (title: string) => title.replace(/\s+/g, " ").trim();

/** The owner names a topic. The title is never changed by a regroup afterwards. */
export function renameEntry(
  contents: ThreadContents,
  lines: ReadonlyMap<RunId, ThreadRunLine>,
  entryId: ThreadEntryId,
  title: string,
): HandEditResult {
  if (!hasState(contents)) return { refused: NO_CONTENTS };
  const target = activeEntry(contents.entries, entryId);
  if (target === undefined) return { refused: GONE };
  const cleaned = cleanTitle(title);
  if (cleaned === "") return { refused: "A topic needs a title." };
  if (cleaned === target.title && target.titleSource === "owner") return { update: null };
  return {
    update: finishEdit(
      contents,
      contents.entries.map((entry) =>
        entry === target ? { ...entry, title: cleaned, titleSource: "owner" } : entry,
      ),
      lines,
    ),
  };
}

/**
 * The target takes every run of both entries, each placed by the owner, so a regroup leaves the
 * merged topic as it is. It keeps its title and takes the outcome of whichever was worked on last.
 */
export function mergeEntries(
  contents: ThreadContents,
  lines: ReadonlyMap<RunId, ThreadRunLine>,
  sourceEntryId: ThreadEntryId,
  targetEntryId: ThreadEntryId,
): HandEditResult {
  if (!hasState(contents)) return { refused: NO_CONTENTS };
  const source = activeEntry(contents.entries, sourceEntryId);
  const target = activeEntry(contents.entries, targetEntryId);
  if (source === undefined || target === undefined) return { refused: GONE };
  if (source === target) return { refused: "A topic cannot be merged into itself." };
  // A run first in either entry is first in the merged one, so it never gains a first link.
  const first = new Map<RunId, boolean>();
  for (const link of [...target.runs, ...source.runs]) {
    first.set(link.runId, first.get(link.runId) === true || link.second !== true);
  }
  if (first.size > THREAD_ENTRY_RUNS_MAX) {
    return { refused: `A topic holds at most ${THREAD_ENTRY_RUNS_MAX} messages.` };
  }
  const runs = [...first]
    .map(([runId, isFirst]): ThreadEntryRun => ({
      runId,
      source: "owner",
      ...(isFirst ? {} : { second: true as const }),
    }))
    .sort(byRunOrder(lines));
  const outcome = source.endedAt > target.endedAt ? source.outcome : target.outcome;
  return {
    update: finishEdit(
      contents,
      contents.entries.map((entry) =>
        entry === target
          ? { ...entry, runs, outcome }
          : entry === source
            ? retire(entry, target.id)
            : entry,
      ),
      lines,
    ),
  };
}

/**
 * The run leaves every entry it was in and sits, placed by the owner, in the target or in a new
 * entry. An entry left with no runs is retired into the target.
 */
export function moveRun(
  contents: ThreadContents,
  lines: ReadonlyMap<RunId, ThreadRunLine>,
  runId: RunId,
  target: { readonly entryId: ThreadEntryId } | { readonly newTitle: string },
): HandEditResult {
  if (!hasState(contents)) return { refused: NO_CONTENTS };
  const line = lines.get(runId);
  if (line === undefined) return { refused: "That message is not in a topic yet." };
  const link: ThreadEntryRun = { runId, source: "owner" };
  const holding = contents.entries.filter(
    (entry) => entry.status === "active" && entry.runs.some((held) => held.runId === runId),
  );
  let nextEntrySeq = contents.state.nextEntrySeq;
  let destination: ThreadEntry;
  if ("entryId" in target) {
    const found = activeEntry(contents.entries, target.entryId);
    if (found === undefined) return { refused: GONE };
    const [only] = holding;
    if (
      holding.length === 1 &&
      only === found &&
      found.runs.some((held) => held.runId === runId && held.source === "owner" && !held.second)
    ) {
      return { update: null };
    }
    const kept = found.runs.filter((held) => held.runId !== runId);
    if (kept.length >= THREAD_ENTRY_RUNS_MAX) {
      return { refused: `A topic holds at most ${THREAD_ENTRY_RUNS_MAX} messages.` };
    }
    destination = { ...found, runs: [...kept, link].sort(byRunOrder(lines)) };
  } else {
    const title = cleanTitle(target.newTitle);
    if (title === "") return { refused: "A topic needs a title." };
    destination = {
      id: ThreadEntryId.make(`${line.threadId}:e${nextEntrySeq++}`),
      threadId: line.threadId,
      title,
      titleSource: "owner",
      outcome: (line.line ?? "").slice(0, THREAD_ENTRY_OUTCOME_MAX),
      open: [],
      runs: [link],
      startMessageId: line.userMessageId,
      endMessageId: line.replyMessageId,
      startedAt: line.startedAt,
      endedAt: line.repliedAt,
      status: "active",
    };
  }
  const edited = contents.entries.map((entry): ThreadEntry => {
    if (entry.id === destination.id) return destination;
    if (!holding.includes(entry)) return entry;
    const runs = entry.runs.filter((held) => held.runId !== runId);
    return runs.length === 0 ? retire(entry, destination.id) : { ...entry, runs };
  });
  const fresh = "entryId" in target ? [] : [destination];
  return { update: finishEdit(contents, [...edited, ...fresh], lines, nextEntrySeq) };
}

/**
 * Undo of a hand edit: puts back the entries as they were, if nothing changed since. Open items are
 * not taken from the given entries; the current ones follow their runs. An entry the edit made (a
 * message moved to a new topic) loses the runs the restored entries hold and is retired.
 */
export function restoreEntries(
  contents: ThreadContents,
  lines: ReadonlyMap<RunId, ThreadRunLine>,
  threadId: ThreadId,
  given: ReadonlyArray<ThreadEntry>,
  expectRevision: number,
): HandEditResult {
  if (!hasState(contents)) return { refused: NO_CONTENTS };
  if (contents.state.revision !== expectRevision) {
    return { refused: "These topics changed since, so this can no longer be undone." };
  }
  const stored = new Map(contents.entries.map((entry) => [entry.id, entry]));
  const restored = new Map(given.map((entry) => [entry.id, entry]));
  if (
    restored.size !== given.length ||
    given.some((entry) => entry.threadId !== threadId || !stored.has(entry.id))
  ) {
    return { refused: "Undo names a topic this thread does not have." };
  }
  if (given.some((entry) => entry.runs.some((link) => !lines.has(link.runId)))) {
    return { refused: "Undo names a message that is no longer in this thread." };
  }
  const firstHeld = new Map<RunId, ThreadEntryId>();
  for (const entry of given) {
    if (entry.status !== "active") continue;
    for (const link of entry.runs) if (link.second !== true) firstHeld.set(link.runId, entry.id);
  }
  const edited = contents.entries.map((entry): ThreadEntry => {
    const back = restored.get(entry.id);
    if (back !== undefined) return { ...back, open: entry.open };
    if (entry.status !== "active") return entry;
    const taken = entry.runs.filter((link) => link.second !== true && firstHeld.has(link.runId));
    if (taken.length === 0) return entry;
    const runs = entry.runs.filter((link) => !taken.includes(link));
    return runs.length > 0 ? { ...entry, runs } : retire(entry, firstHeld.get(taken[0]!.runId)!);
  });
  const active = new Set(edited.flatMap((entry) => (entry.status === "active" ? [entry.id] : [])));
  const firsts = new Map<RunId, number>();
  const linked = new Set<RunId>();
  for (const entry of edited) {
    if (entry.status !== "active") continue;
    for (const link of entry.runs) {
      linked.add(link.runId);
      if (link.second !== true) firsts.set(link.runId, (firsts.get(link.runId) ?? 0) + 1);
    }
  }
  const wasLinked = contents.entries.flatMap((entry) =>
    entry.status === "active" ? entry.runs.map((link) => link.runId) : [],
  );
  const consistent =
    wasLinked.every((runId) => linked.has(runId)) &&
    [...linked].every((runId) => firsts.get(runId) === 1) &&
    // Older pointers at an entry this retires are carried on by `finishEdit`.
    given.every(
      (entry) =>
        entry.status === "active" ||
        (entry.runs.length === 0 &&
          (entry.mergedInto === undefined || active.has(entry.mergedInto))),
    );
  if (!consistent) return { refused: "Undo would leave a message in no topic or in two." };
  return { update: finishEdit(contents, edited, lines) };
}
