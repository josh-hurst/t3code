import { useAtomValue } from "@effect/atom-react";
import {
  createThreadContentsAtoms,
  createThreadEntryAtoms,
  mergeEntryPages,
} from "@t3tools/client-runtime/state/thread-entries";
import type {
  EnvironmentId,
  ListEntriesInput,
  ListThreadEntriesResult,
  OpenItemCountsResult,
  ThreadId,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "./atom-registry";
import { useServerConfigs } from "./entities";
import { environmentServerConfigsAtom } from "./server";
import { useEnvironments } from "./environments";
import { environmentThreads } from "./threads";

export const threadEntryAtoms = createThreadEntryAtoms(connectionAtomRuntime);
const threadContents = createThreadContentsAtoms(
  connectionAtomRuntime,
  environmentThreads.stateAtom,
);

/**
 * Connected environments whose server keeps topics. Older servers without `threadEntries` get
 * no History screen, Contents row, open counts or Mark published.
 */
export function useEntriesEnvironmentIds(): ReadonlyArray<EnvironmentId> {
  const { environments } = useEnvironments();
  const configs = useServerConfigs();
  return environments
    .filter(
      (environment) =>
        environment.connection.phase === "connected" &&
        configs.get(environment.environmentId)?.threadEntries === true,
    )
    .map((environment) => environment.environmentId);
}

const anyKeepsEntries = (
  configs: ReadonlyMap<EnvironmentId, { readonly threadEntries?: boolean }>,
) => [...configs.values()].some((config) => config.threadEntries === true);

/** Whether any known server keeps topics; a boolean, so lists re-render only when it flips. */
export function useAnyEnvironmentKeepsEntries(): boolean {
  return useAtomValue(environmentServerConfigsAtom, anyKeepsEntries);
}

function useEnvironmentKeepsEntries(environmentId: EnvironmentId | null): boolean {
  const configs = useServerConfigs();
  return environmentId !== null && configs.get(environmentId)?.threadEntries === true;
}

const NO_THREAD_ENTRIES = Atom.make<ListThreadEntriesResult | null>(null).pipe(
  Atom.withLabel("mobile:thread-entries:none"),
);

/** A thread's topics, or null until loaded and wherever the server keeps none. */
export function useThreadEntries(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ListThreadEntriesResult | null {
  const keeps = useEnvironmentKeepsEntries(environmentId);
  return useAtomValue(
    keeps && environmentId !== null && threadId !== null
      ? threadContents.threadEntriesAtom(environmentId, threadId)
      : NO_THREAD_ENTRIES,
  );
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
  return {
    ...mergeEntryPages(environments),
    pending: environments.some((environment) => environment.pending),
    error: environments.find((environment) => environment.error !== null)?.error ?? null,
    /** Environments that have another page to read. */
    moreIn: environments.flatMap((environment) =>
      environment.pages.at(-1)?.next ? [environment.environmentId] : [],
    ),
  };
}

const countsAtom = Atom.family((key: string) => {
  const environmentIds = key === "" ? [] : (key.split("\n") as EnvironmentId[]);
  return Atom.make((get) =>
    environmentIds.flatMap((environmentId) => {
      const result = AsyncResult.getOrElse(
        get(threadEntryAtoms.openItemCounts({ environmentId, input: { key: "history" } })),
        () => null,
      );
      return result === null ? [] : [{ environmentId, result }];
    }),
  ).pipe(Atom.withLabel(`mobile:open-item-counts:${key}`));
});

/** Open item counts per environment, read again after every action and on refresh. */
export function useOpenItemCounts(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<{ readonly environmentId: EnvironmentId; readonly result: OpenItemCountsResult }> {
  return useAtomValue(countsAtom(environmentIds.join("\n")));
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
  ).pipe(Atom.withLabel(`mobile:entries-operable:${key}`));
});

/** Environments where this device may mark items done or published. */
export function useCanOperateEntries(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlySet<EnvironmentId> {
  return useAtomValue(operableAtom(environmentIds.join("\n")));
}

/** Reads every list and count of these environments again. */
export function refreshEntries(environmentIds: ReadonlyArray<EnvironmentId>) {
  for (const environmentId of environmentIds) {
    threadEntryAtoms.refresh(appAtomRegistry, environmentId);
  }
}
