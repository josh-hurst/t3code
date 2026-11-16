import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import {
  createThreadEntryAtoms,
  type EntryRow,
  mergeEntryPages,
  openItemsRefreshKey,
  openItemTotals,
} from "@t3tools/client-runtime/state/thread-entries";
import type {
  EnvironmentId,
  ListEntriesInput,
  ListThreadEntriesResult,
  OpenItemCountsResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useServerConfigs, useQuietThreadShells } from "./entities";
import { useEnvironments } from "./environments";
import { environmentServerConfigsAtom } from "./server";
import { useDebouncedValue } from "./queries";
import { threadContents } from "./threads";

export const threadEntryAtoms = createThreadEntryAtoms(connectionAtomRuntime);

/**
 * Connected environments whose server lists topics. Older and remote servers without
 * `threadEntries` get none of the History page, the open counts or Mark published.
 */
export function useEntriesEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  const ids = environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        configs.get(environment.environmentId)?.threadEntries === true,
    )
    .map((environment) => environment.environmentId);
  return ids;
}

const OPEN_COUNTS_DEBOUNCE_MS = 1_000;

const countsAtom = Atom.family((key: string) => {
  const [environmentIds, refreshKey] = JSON.parse(key) as [ReadonlyArray<EnvironmentId>, string];
  return Atom.make((get) =>
    environmentIds.flatMap((environmentId) => {
      const result = AsyncResult.getOrElse(
        get(threadEntryAtoms.openItemCounts({ environmentId, input: { key: refreshKey } })),
        () => null,
      );
      return result === null ? [] : [{ environmentId, result }];
    }),
  ).pipe(Atom.withLabel(`web:open-item-counts:${key}`));
});

const NO_COUNTS_VALUE: ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly result: OpenItemCountsResult;
}> = [];
const NO_COUNTS = Atom.make<
  ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly result: OpenItemCountsResult }>
>(NO_COUNTS_VALUE).pipe(Atom.withLabel("web:open-item-counts:none"));

/**
 * Open items in scope (a project group's member projects, or everything when null), read again
 * when a card is written or an item cleared in a listed thread, and after every action here.
 */
export function useOpenItemTotals(
  scope: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }> | null,
  enabled = true,
) {
  const environmentIds = useEntriesEnvironmentIds();
  const refreshKey = useDebouncedValue(
    openItemsRefreshKey(useQuietThreadShells()),
    OPEN_COUNTS_DEBOUNCE_MS,
  );
  const active = enabled && environmentIds.length > 0;
  const read = useAtomValue(
    active ? countsAtom(JSON.stringify([environmentIds, refreshKey])) : NO_COUNTS,
  );
  // A new key reads afresh; the last answer shows meanwhile, so the count never blinks to 0.
  const [held, setHeld] = useState(read);
  if (read.length > 0 && read !== held) setHeld(read);
  const counts = !active ? NO_COUNTS_VALUE : read.length > 0 ? read : held;
  return { available: active, ...openItemTotals(counts, scope) };
}

/** Pages of topics from each target environment, merged newest first. */
export function useEntryList(
  targets: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly input: ListEntriesInput;
  }>,
  pagesOf: (environmentId: EnvironmentId) => number,
) {
  const environments = useAtomValue(
    threadEntryAtoms.entryListAtom(
      targets.map((target) => ({ ...target, pages: pagesOf(target.environmentId) })),
    ),
  );
  const merged = mergeEntryPages(environments);
  return {
    ...merged,
    pending: environments.some((environment) => environment.pending),
    error: environments.find((environment) => environment.error !== null)?.error ?? null,
    /** Environments that have another page to read. */
    moreIn: environments.flatMap((environment) =>
      environment.pages.at(-1)?.next ? [environment.environmentId] : [],
    ),
  };
}

/** Reads again every list and count of these environments, as after an action. */
export function refreshEntries(environmentIds: ReadonlyArray<EnvironmentId>) {
  for (const environmentId of environmentIds) {
    threadEntryAtoms.refresh(appAtomRegistry, environmentId);
  }
}

const operableAtom = Atom.family((key: string) => {
  const environmentIds = key === "" ? [] : (key.split("\n") as EnvironmentId[]);
  return Atom.make(
    (get) =>
      new Set(
        environmentIds.filter((environmentId) =>
          get(threadEntryAtoms.resolveOpenItem.permissionAtom(environmentId)),
        ),
      ),
  ).pipe(Atom.withLabel(`web:entries-operable:${key}`));
});

/** Environments where this client may mark items done or published. */
export function useCanOperateEntries(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlySet<EnvironmentId> {
  return useAtomValue(operableAtom(environmentIds.join("\n")));
}

/** For key handlers outside React: whether any known server lists topics. */
export function readEntriesAvailable(): boolean {
  for (const config of appAtomRegistry.get(environmentServerConfigsAtom).values()) {
    if (config.threadEntries === true) return true;
  }
  return false;
}

/** Topics a palette search shows per environment. */
const PALETTE_TOPIC_LIMIT = 5;

const topicSearchAtom = Atom.family((key: string) => {
  const [environmentIds, query] = JSON.parse(key) as [ReadonlyArray<EnvironmentId>, string];
  return Atom.make((get) =>
    environmentIds.flatMap((environmentId) => {
      const page = AsyncResult.getOrElse(
        get(
          threadEntryAtoms.entriesPage({
            environmentId,
            input: { query: query.slice(0, 100), limit: PALETTE_TOPIC_LIMIT },
          }),
        ),
        () => null,
      );
      return (page?.entries ?? []).map((entry) => ({ ...entry, environmentId }));
    }),
  ).pipe(Atom.withLabel(`web:topic-search:${key}`));
});

const NO_TOPICS = Atom.make<ReadonlyArray<EntryRow>>([]).pipe(
  Atom.withLabel("web:topic-search:none"),
);

/** Topics whose title and outcome hold every word of a settled palette query. */
export function useTopicSearch(query: string): ReadonlyArray<EntryRow> {
  const environmentIds = useEntriesEnvironmentIds();
  const trimmed = query.trim();
  return useAtomValue(
    environmentIds.length === 0 || trimmed.length < 2
      ? NO_TOPICS
      : topicSearchAtom(JSON.stringify([environmentIds, trimmed])),
  );
}

/** Whether this environment's server lists topics, and so can mark a project published. */
export function readEnvironmentHasEntries(environmentId: EnvironmentId): boolean {
  return (
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.threadEntries === true
  );
}

const NO_THREAD_ENTRIES = Atom.make<ListThreadEntriesResult | null>(null).pipe(
  Atom.withLabel("web:thread-entries:none"),
);

/**
 * A server thread's topics, or null until loaded and wherever the server keeps none. Pass a null
 * thread for drafts and guest views: reading the topics subscribes to the thread.
 */
export function useThreadEntries<A = ListThreadEntriesResult | null>(
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  select?: (entries: ListThreadEntriesResult | null) => A,
): A {
  const keeps = useAtomValue(
    environmentServerConfigsAtom,
    (configs) => configs.get(environmentId)?.threadEntries === true,
  );
  const atom =
    keeps && threadId !== null
      ? threadContents.threadEntriesAtom(environmentId, threadId)
      : NO_THREAD_ENTRIES;
  return useAtomValue(atom, select ?? ((entries) => entries as A));
}
