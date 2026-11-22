import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type GetProjectChangesInput,
  type ListEntriesInput,
  type ListEntriesResult,
  type ListThreadEntriesResult,
  type OpenItemCountsResult,
  type OrchestrationV2ThreadShell,
  type ProjectChangeCommit,
  type ProjectChangeCounts,
  type ProjectChangePeriod,
  type ProjectChangesResult,
  type ProjectId,
  type RunId,
  type ScopedProjectRef,
  type ThreadEntriesUpdate,
  type ThreadEntry,
  type ThreadEntryCursor,
  type ThreadEntryListItem,
  type ThreadEntryOpenItem,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";
import type { EnvironmentThreadState, SequencedEntriesUpdate } from "./threadState.ts";
import { threadCardOpenItemLabel, trailDayLabel } from "./threadZones.ts";

/** How many `thread.entries-updated` events an open thread keeps to replay over a fetched list. */
const ENTRY_UPDATES_KEPT = 20;

/**
 * Keeps the newest updates, dropping any the next one does not follow. A regroup request
 * changes only the state, at the same revision, so an update of equal revision stays.
 */
export function appendEntriesUpdate(
  updates: ReadonlyArray<SequencedEntriesUpdate> | undefined,
  update: ThreadEntriesUpdate,
  sequence: number,
): ReadonlyArray<SequencedEntriesUpdate> {
  const kept = (updates ?? []).filter(
    (held) => held.state.revision <= update.state.revision && held.sequence < sequence,
  );
  return [...kept, { ...update, sequence }].slice(-ENTRY_UPDATES_KEPT);
}

const byFirstAppearance = (left: ThreadEntry, right: ThreadEntry) =>
  left.startedAt === right.startedAt
    ? left.id.localeCompare(right.id, undefined, { numeric: true })
    : left.startedAt < right.startedAt
      ? -1
      : 1;

/**
 * A thread's active entries: the fetched list with the events since replayed on it. An event
 * carries only the entries it changed, so it applies only on the revision just before it; a gap
 * means the list must be read again. A fetch older than an event already applied is the same gap.
 */
export function resolveThreadEntries(
  fetched: ListThreadEntriesResult,
  updates: ReadonlyArray<ThreadEntriesUpdate>,
): ListThreadEntriesResult | "refetch" {
  let revision = fetched.revision;
  const byId = new Map(fetched.entries.map((entry) => [entry.id, entry]));
  for (const update of updates) {
    if (update.state.revision <= revision) continue;
    if (update.state.revision !== revision + 1) return "refetch";
    for (const entry of update.entries) {
      if (entry.status === "active") byId.set(entry.id, entry);
      else byId.delete(entry.id);
    }
    revision = update.state.revision;
  }
  if (revision === fetched.revision) return fetched;
  return { entries: [...byId.values()].sort(byFirstAppearance), revision };
}

/** Which `listThreadEntries` answer a thread's topics come from, and the list shown meanwhile. */
export interface ThreadEntriesRead {
  /** Snapshots after the thread's first; each may have skipped events, so the list is read again. */
  readonly resyncs: number;
  /** Reads asked for because the stored events did not follow the answer. */
  readonly refetches: number;
  /** The newest event revision that asked for a read; one read per newer event, never a loop. */
  readonly refetchedThrough: number;
  readonly shown: ListThreadEntriesResult | null;
}

/** Names one answer: a new basis reads the list again. */
const threadEntriesReadBasis = (read: Pick<ThreadEntriesRead, "resyncs" | "refetches">) =>
  `${read.resyncs}.${read.refetches}`;

/**
 * The next read of a thread's topics. `answer` gives the fetched list for a basis, or null while
 * it loads; asking for a new basis starts its fetch. The last list stays shown while one loads.
 */
export function stepThreadEntriesRead(
  previous: ThreadEntriesRead | null,
  input: {
    readonly resyncs: number;
    readonly updates: ReadonlyArray<ThreadEntriesUpdate>;
    readonly answer: (basis: string) => ListThreadEntriesResult | null;
  },
): ThreadEntriesRead {
  const read: ThreadEntriesRead = {
    resyncs: input.resyncs,
    refetches: previous?.refetches ?? 0,
    refetchedThrough: previous?.refetchedThrough ?? -1,
    shown: previous?.shown ?? null,
  };
  const answer = input.answer(threadEntriesReadBasis(read));
  if (answer === null) return read;
  const resolved = resolveThreadEntries(answer, input.updates);
  if (resolved !== "refetch") return { ...read, shown: resolved };
  const newest = input.updates.at(-1)?.state.revision ?? 0;
  if (newest <= read.refetchedThrough) return { ...read, shown: answer };
  const next: ThreadEntriesRead = {
    ...read,
    refetches: read.refetches + 1,
    refetchedThrough: newest,
    shown: read.shown ?? answer,
  };
  const fresh = input.answer(threadEntriesReadBasis(next));
  if (fresh === null) return next;
  const replayed = resolveThreadEntries(fresh, input.updates);
  return { ...next, shown: replayed === "refetch" ? fresh : replayed };
}

const NO_ENTRY_UPDATES: ReadonlyArray<SequencedEntriesUpdate> = [];

/**
 * One thread's active topics, kept current by the `thread.entries-updated` events its open stream
 * stores. Reading it subscribes to the thread; read it only where the server has `threadEntries`.
 */
export function createThreadContentsAtoms<R, ER, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
  threadStateAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>,
) {
  const answers = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:thread-entries",
    staleTimeMs: Number.POSITIVE_INFINITY,
    // A later open reads afresh: events that arrived while nobody watched were not stored.
    idleTtlMs: 0,
    // `basis` only names which read this is.
    execute: (input: { readonly threadId: ThreadId; readonly basis: string }) =>
      request(ORCHESTRATION_V2_WS_METHODS.listThreadEntries, { threadId: input.threadId }),
  });

  const parseKey = (key: string) =>
    JSON.parse(key) as { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  const stateOf =
    (key: string) =>
    (get: Atom.AtomContext): EnvironmentThreadState | null => {
      const { environmentId, threadId } = parseKey(key);
      return AsyncResult.getOrElse(get(threadStateAtom(environmentId, threadId)), () => null);
    };
  // Narrow reads, so streamed text does not re-run the reads that follow.
  const updatesFamily = Atom.family((key: string) =>
    Atom.make((get) => stateOf(key)(get)?.entryUpdates ?? NO_ENTRY_UPDATES).pipe(
      Atom.withLabel(`thread-entries:updates:${key}`),
    ),
  );

  const family = Atom.family((key: string) => {
    const { environmentId, threadId } = parseKey(key);
    const resyncsAtom = Atom.make((get) =>
      Math.max(0, (stateOf(key)(get)?.snapshots ?? 0) - 1),
    ).pipe(Atom.withLabel(`thread-entries:resyncs:${key}`));
    const readAtom = Atom.make((get) =>
      stepThreadEntriesRead(Option.getOrNull(get.self<ThreadEntriesRead>()), {
        resyncs: get(resyncsAtom),
        updates: get(updatesFamily(key)),
        answer: (basis) =>
          AsyncResult.getOrElse(
            get(answers({ environmentId, input: { threadId, basis } })),
            () => null,
          ),
      }),
    ).pipe(Atom.withLabel(`thread-entries:read:${key}`));
    return Atom.make((get) => get(readAtom).shown).pipe(Atom.withLabel(`thread-entries:${key}`));
  });

  return {
    /** Active entries in order of first appearance, or null until the first answer. */
    threadEntriesAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      family(JSON.stringify({ environmentId, threadId })),
    /** The entries events the open thread holds, each with its stream sequence. */
    entryUpdatesAtom: (environmentId: EnvironmentId, threadId: ThreadId) =>
      updatesFamily(JSON.stringify({ environmentId, threadId })),
  };
}

/** A thread shows its contents once it has two topics. */
export const contentsVisible = (entries: ReadonlyArray<ThreadEntry> | null | undefined) =>
  (entries?.length ?? 0) >= 2;

/** Each run's first entry: where it sits, and where the open items it raised are held. */
export function entryByRunId(entries: ReadonlyArray<ThreadEntry>): ReadonlyMap<RunId, ThreadEntry> {
  const byRun = new Map<RunId, ThreadEntry>();
  for (const entry of entries) {
    for (const run of entry.runs) if (run.second !== true) byRun.set(run.runId, entry);
  }
  for (const entry of entries) {
    for (const run of entry.runs) if (!byRun.has(run.runId)) byRun.set(run.runId, entry);
  }
  return byRun;
}

/** The Undo of one hand edit, once its event is in: `thread.entries.restore`'s input. */
export type EntriesUndo =
  | { readonly kind: "waiting" }
  | { readonly kind: "none" }
  | {
      readonly kind: "ready";
      readonly entries: ReadonlyArray<ThreadEntry>;
      readonly expectRevision: number;
    };

/**
 * Pairs the entries shown before an edit with the event the edit's command committed (`sequence`).
 * Undo puts back each changed entry that was active before; one the edit created has no copy, and
 * the server retires it. Any other update in between leaves nothing to undo.
 */
export function entriesUndo(
  before: ListThreadEntriesResult | null,
  updates: ReadonlyArray<SequencedEntriesUpdate>,
  sequence: number,
): EntriesUndo {
  const update = updates.find((held) => held.sequence === sequence);
  if (update === undefined) return { kind: "waiting" };
  if (before === null || before.revision !== update.state.revision - 1) return { kind: "none" };
  const previous = new Map(before.entries.map((entry) => [entry.id, entry]));
  const entries = update.entries.flatMap((entry) => previous.get(entry.id) ?? []);
  return entries.length === 0
    ? { kind: "none" }
    : { kind: "ready", entries, expectRevision: update.state.revision };
}

/**
 * What a topic leaves with the owner: "Question", "Publish" or both. Checks, commits and
 * follow-ups stay on the entry for agents and are not labelled: the owner hands those back.
 */
export function entryOwedLabel(open: ReadonlyArray<Pick<ThreadEntryOpenItem, "kind">>) {
  const labels = (["ask", "ship"] as const)
    .filter((kind) => open.some((item) => item.kind === kind))
    .map(threadCardOpenItemLabel);
  return labels.length === 0 ? null : labels.join(", ");
}

/** The items an Unpublished list shows under a topic. */
export function entryPublishItems<Item extends Pick<ThreadEntryOpenItem, "kind">>(
  open: ReadonlyArray<Item>,
): ReadonlyArray<Item> {
  return open.filter((item) => item.kind === "ship");
}

export interface EntryRow extends ThreadEntryListItem {
  readonly environmentId: EnvironmentId;
}

const newerFirst = (left: EntryRow, right: EntryRow) =>
  left.endedAt === right.endedAt
    ? left.id < right.id
      ? -1
      : left.id > right.id
        ? 1
        : left.environmentId.localeCompare(right.environmentId)
    : left.endedAt > right.endedAt
      ? -1
      : 1;

const belowCursor = (row: Pick<EntryRow, "endedAt" | "id">, cursor: ThreadEntryCursor) =>
  row.endedAt < cursor.endedAt || (row.endedAt === cursor.endedAt && row.id > cursor.entryId);

/**
 * Pages of `listEntries` from several environments as one list, newest first. An environment
 * with more to load holds back rows from the others below where it stopped, so the list is always
 * a correct prefix. A row met twice (its time moved between pages) is listed once.
 */
export function mergeEntryPages(
  environments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly pages: ReadonlyArray<ListEntriesResult>;
  }>,
): { readonly rows: ReadonlyArray<EntryRow>; readonly hasMore: boolean } {
  let cut: ThreadEntryCursor | null = null;
  const rows: EntryRow[] = [];
  const seen = new Set<string>();
  for (const { environmentId, pages } of environments) {
    for (const page of pages) {
      for (const entry of page.entries) {
        const key = `${environmentId}\n${entry.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push({ ...entry, environmentId });
      }
    }
    const next = pages.at(-1)?.next ?? null;
    if (
      next !== null &&
      (cut === null || belowCursor({ endedAt: cut.endedAt, id: cut.entryId }, next))
    ) {
      cut = next;
    }
  }
  const sorted = rows.sort(newerFirst);
  return {
    rows: cut === null ? sorted : sorted.filter((row) => !belowCursor(row, cut)),
    hasMore: cut !== null,
  };
}

/** The longest query `listEntries` takes. */
const ENTRY_QUERY_MAX = 100;
/** Rows per `listEntries` page: one "Show more" step. */
const ENTRY_PAGE_SIZE = 50;

// `stillOpen` narrows the list on servers that predate `openKind`.
const UNPUBLISHED_FILTER = { stillOpen: true, openKind: "ship" } as const;

/**
 * What each environment is asked for: every project, or a group's member projects there. An
 * environment holding none of the group's projects is asked nothing, since an absent list means
 * every project.
 */
export function entryListInputs(input: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  readonly members: ReadonlyArray<ScopedProjectRef> | null;
  /** Only topics waiting on a publish. */
  readonly unpublished: boolean;
  readonly query: string;
}): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly input: ListEntriesInput }> {
  const query = input.query.trim().slice(0, ENTRY_QUERY_MAX);
  return input.environmentIds.flatMap((environmentId) => {
    const projectIds =
      input.members === null
        ? null
        : input.members
            .filter((member) => member.environmentId === environmentId)
            .map((member) => member.projectId);
    if (projectIds !== null && projectIds.length === 0) return [];
    return [
      {
        environmentId,
        input: {
          ...(projectIds === null ? {} : { projectIds }),
          ...(input.unpublished ? UNPUBLISHED_FILTER : {}),
          ...(query === "" ? {} : { query }),
        },
      },
    ];
  });
}

/** Mark published's calls: one per environment that holds the group's projects. */
export function entryPublishTargets(
  members: ReadonlyArray<ScopedProjectRef>,
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly projectIds: ReadonlyArray<ProjectId>;
}> {
  return environmentIds.flatMap((environmentId) => {
    const projectIds = members
      .filter((member) => member.environmentId === environmentId)
      .map((member) => member.projectId);
    return projectIds.length === 0 ? [] : [{ environmentId, projectIds }];
  });
}

export interface EnvironmentEntryPages {
  readonly environmentId: EnvironmentId;
  readonly pages: ReadonlyArray<ListEntriesResult>;
  readonly pending: boolean;
  readonly error: string | null;
}

/** Rows under day labels by when each topic was last worked on. */
export function entryDayGroups(
  rows: ReadonlyArray<EntryRow>,
  nowMs: number,
): ReadonlyArray<{ readonly label: string; readonly rows: ReadonlyArray<EntryRow> }> {
  const groups: Array<{ label: string; rows: EntryRow[] }> = [];
  for (const row of rows) {
    const label = trailDayLabel(Date.parse(row.endedAt), nowMs);
    const last = groups.at(-1);
    if (last?.label === label) last.rows.push(row);
    else groups.push({ label, rows: [row] });
  }
  return groups;
}

/** Items waiting on a publish across these environments' projects; all projects when `scope` is null. */
export function unpublishedCount(
  counts: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly result: OpenItemCountsResult;
  }>,
  scope: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null,
): number {
  let total = 0;
  for (const { environmentId, result } of counts) {
    for (const project of result.projects) {
      const inScope =
        scope === null ||
        scope.some(
          (ref) => ref.environmentId === environmentId && ref.projectId === project.projectId,
        );
      if (inScope) total += project.counts.ship ?? 0;
    }
  }
  return total;
}

/** Uncommitted files and unpushed commits across these projects' checkouts. */
export function projectChangeCounts(
  counts: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly result: OpenItemCountsResult;
  }>,
  scope: ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly projectId: ProjectId }>,
): ProjectChangeCounts {
  let uncommittedFiles = 0;
  let unpushedCommits = 0;
  for (const { environmentId, result } of counts) {
    for (const project of result.projects) {
      if (project.changes === undefined) continue;
      const inScope = scope.some(
        (ref) => ref.environmentId === environmentId && ref.projectId === project.projectId,
      );
      if (!inScope) continue;
      uncommittedFiles += project.changes.uncommittedFiles;
      unpushedCommits += project.changes.unpushedCommits;
    }
  }
  return { uncommittedFiles, unpushedCommits };
}

export type ProjectChangeTimelineRow =
  | { readonly kind: "commit"; readonly commit: ProjectChangeCommit }
  | { readonly kind: "publish"; readonly at: string }
  /** A run of commits by other authors, which carry no topics. `sha` is its newest commit. */
  | {
      readonly kind: "others";
      readonly sha: string;
      readonly count: number;
      readonly authors: ReadonlyArray<string>;
    };

/**
 * A project's commits and publishes by local day, newest first. Another author's commits fold
 * into one row per unbroken run, so a pulled-in week of them does not bury the owner's own.
 */
export function projectChangeTimeline(
  changes: Pick<ProjectChangesResult, "commits" | "publishes">,
  now: number,
): Array<{ readonly label: string; readonly rows: Array<ProjectChangeTimelineRow> }> {
  const events = [
    ...changes.commits.map((commit) => ({ atMs: Date.parse(commit.committedAt), commit })),
    ...changes.publishes.map((at) => ({ atMs: Date.parse(at), publishedAt: at })),
  ].sort((left, right) => right.atMs - left.atMs);
  const days: Array<{ label: string; rows: Array<ProjectChangeTimelineRow> }> = [];
  for (const event of events) {
    const label = trailDayLabel(event.atMs, now);
    let day = days.at(-1);
    if (day?.label !== label) {
      day = { label, rows: [] };
      days.push(day);
    }
    if ("publishedAt" in event) {
      day.rows.push({ kind: "publish", at: event.publishedAt });
    } else if (event.commit.own) {
      day.rows.push({ kind: "commit", commit: event.commit });
    } else {
      const last = day.rows.at(-1);
      const authors = last?.kind === "others" ? last.authors : [];
      const row = {
        kind: "others" as const,
        sha: last?.kind === "others" ? last.sha : event.commit.sha,
        count: (last?.kind === "others" ? last.count : 0) + 1,
        authors: authors.includes(event.commit.author)
          ? authors
          : [...authors, event.commit.author],
      };
      if (last?.kind === "others") day.rows[day.rows.length - 1] = row;
      else day.rows.push(row);
    }
  }
  return days;
}

/** One stretch of a project's changelog: what a publish shipped, or what waits for the next. */
export interface ProjectChangeSection {
  readonly key: string;
  /** The publish that closed it; null for work not published yet. */
  readonly publishedAt: string | null;
  /** The owner's commits there; null when the stretch holds none of theirs. */
  readonly period: ProjectChangePeriod | null;
  /** Other authors' commits that landed in it. */
  readonly others: { readonly count: number; readonly authors: ReadonlyArray<string> } | null;
}

/**
 * The changelog's periods with every publish and other authors' commits put back in place,
 * newest first. A publish that shipped none of the owner's commits still gets its section, and
 * a commit belongs to the first publish at or after it, as the server cuts the periods.
 */
export function projectChangeSections(
  changes: Pick<ProjectChangesResult, "commits" | "publishes"> & {
    readonly periods: ReadonlyArray<ProjectChangePeriod>;
  },
): Array<ProjectChangeSection> {
  const theirs = changes.commits.flatMap((commit) =>
    commit.own ? [] : [{ atMs: Date.parse(commit.committedAt), author: commit.author }],
  );
  const othersIn = (afterMs: number, throughMs: number) => {
    const held = theirs.filter((commit) => commit.atMs > afterMs && commit.atMs <= throughMs);
    return held.length === 0
      ? null
      : { count: held.length, authors: [...new Set(held.map((commit) => commit.author))] };
  };
  const publishes = [...new Map(changes.publishes.map((at) => [Date.parse(at), at]))]
    .map(([atMs, at]) => ({ atMs, at }))
    .sort((left, right) => right.atMs - left.atMs);
  if (publishes.length === 0) {
    // Never published: the periods are weeks, each running until the next one's first commit.
    if (changes.periods.length === 0) {
      const others = othersIn(Number.NEGATIVE_INFINITY, Number.POSITIVE_INFINITY);
      return others === null ? [] : [{ key: "others", publishedAt: null, period: null, others }];
    }
    return changes.periods.map((period, index) => ({
      key: period.key,
      publishedAt: null,
      period,
      others: othersIn(
        index === changes.periods.length - 1
          ? Number.NEGATIVE_INFINITY
          : Date.parse(period.startedAt) - 1,
        index === 0
          ? Number.POSITIVE_INFINITY
          : Date.parse(changes.periods[index - 1]!.startedAt) - 1,
      ),
    }));
  }
  return [null, ...publishes].flatMap((publish, index, bounds) => {
    const period =
      changes.periods.find((candidate) =>
        candidate.publishedAt === null
          ? publish === null
          : Date.parse(candidate.publishedAt) === publish?.atMs,
      ) ?? null;
    const others = othersIn(
      bounds[index + 1]?.atMs ?? Number.NEGATIVE_INFINITY,
      publish?.atMs ?? Number.POSITIVE_INFINITY,
    );
    // Nothing waiting for the next publish is not a section; a publish always is.
    if (publish === null && period === null && others === null) return [];
    return [{ key: publish?.at ?? "open", publishedAt: publish?.at ?? null, period, others }];
  });
}

/**
 * Changes when the open items a shell list can show change: a new card, or an item cleared
 * (which keeps the card's time). Clears on settled threads outside the shell are not seen here.
 */
export function openItemsRefreshKey(
  threads: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "card">>,
): string {
  let latest = "";
  let open = 0;
  for (const thread of threads) {
    const card = thread.card;
    if (card === undefined || card === null) continue;
    if (card.at > latest) latest = card.at;
    open += card.open.length;
  }
  return `${latest}|${open}`;
}

/** The History page's reads and the Still open actions, per environment. */
export function createThreadEntryAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  // Bumped after every action here and when the History page opens, so lists and counts read again.
  const versionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`thread-entries:version:${environmentId}`)),
  );
  const refresh = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    registry.update(versionAtom(environmentId), (version) => version + 1);

  const entriesPage = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:entries-page",
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 0,
    refreshTrigger: ({ environmentId }) => versionAtom(environmentId),
    execute: (input: ListEntriesInput) => request(ORCHESTRATION_V2_WS_METHODS.listEntries, input),
  });

  const openItemCounts = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:open-item-counts",
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 0,
    refreshTrigger: ({ environmentId }) => versionAtom(environmentId),
    // `key` only names the shell state the counts were read for.
    execute: (_input: { readonly key: string }) =>
      request(ORCHESTRATION_V2_WS_METHODS.getOpenItemCounts, {}),
  });

  const projectChanges = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:project-changes",
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 0,
    refreshTrigger: ({ environmentId }) => versionAtom(environmentId),
    execute: (input: GetProjectChangesInput) =>
      request(ORCHESTRATION_V2_WS_METHODS.getProjectChanges, input),
  });

  // Each page starts where the one before it stopped, so pages are read one after another.
  const environmentPages = Atom.family((key: string) => {
    const { environmentId, input, pages } = JSON.parse(key) as {
      readonly environmentId: EnvironmentId;
      readonly input: ListEntriesInput;
      readonly pages: number;
    };
    return Atom.make((get): EnvironmentEntryPages => {
      const loaded: ListEntriesResult[] = [];
      let before: ThreadEntryCursor | undefined;
      let pending = false;
      for (let index = 0; index < pages; index += 1) {
        const result = get(
          entriesPage({
            environmentId,
            input: {
              ...input,
              ...(before === undefined ? {} : { before }),
              limit: ENTRY_PAGE_SIZE,
            },
          }),
        );
        pending ||= result.waiting;
        if (result._tag === "Failure") {
          return { environmentId, pages: loaded, pending, error: "Could not load topics." };
        }
        const value = AsyncResult.getOrElse(result, () => null);
        if (value === null) break;
        loaded.push(value);
        if (value.next === null) break;
        before = value.next;
      }
      return { environmentId, pages: loaded, pending, error: null };
    }).pipe(Atom.withLabel(`thread-entries:pages:${key}`));
  });

  /** Each target's first `pages` pages; read the list with `mergeEntryPages`. */
  const entryList = Atom.family((key: string) => {
    const targets = JSON.parse(key) as ReadonlyArray<string>;
    return Atom.make((get) => targets.map((target) => get(environmentPages(target)))).pipe(
      Atom.withLabel(`thread-entries:list:${key}`),
    );
  });
  const entryListAtom = (
    targets: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly input: ListEntriesInput;
      readonly pages: number;
    }>,
  ) => entryList(JSON.stringify(targets.map((target) => JSON.stringify(target))));

  const commandOptions = {
    onSuccess: (
      { environmentId }: { readonly environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.sync(() => refresh(registry, environmentId)),
  };
  return {
    refresh,
    entriesPage,
    entryListAtom,
    openItemCounts,
    projectChanges,
    markPublished: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:orchestration:mark-published",
      tag: ORCHESTRATION_V2_WS_METHODS.markPublished,
      ...commandOptions,
    }),
    undoPublished: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:orchestration:undo-published",
      tag: ORCHESTRATION_V2_WS_METHODS.undoPublished,
      ...commandOptions,
    }),
    summarizeProjectChanges: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:orchestration:summarize-project-changes",
      tag: ORCHESTRATION_V2_WS_METHODS.summarizeProjectChanges,
      ...commandOptions,
    }),
    resolveOpenItem: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:orchestration:resolve-open-item",
      tag: ORCHESTRATION_V2_WS_METHODS.resolveOpenItem,
      ...commandOptions,
    }),
  };
}
