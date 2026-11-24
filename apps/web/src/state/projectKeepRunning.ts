import { useAtomValue } from "@effect/atom-react";
import { parseScopedProjectKey, scopedProjectKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, ProjectKeepRunningStatus, ScopedProjectRef } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { projectEnvironment } from "./projects";
import { environmentServerConfigsAtom } from "./server";

const EMPTY_STATUSES: ReadonlyArray<ProjectKeepRunningStatus> = [];
const EMPTY_STATUS_MAP: ReadonlyMap<string, ProjectKeepRunningStatus> = new Map();
const EMPTY_STATUS_MAP_ATOM = Atom.make<ReadonlyMap<string, ProjectKeepRunningStatus>>(
  EMPTY_STATUS_MAP,
).pipe(Atom.withLabel("web-project-keep-running:empty"));

const environmentProjectKeepRunningAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<ProjectKeepRunningStatus> => {
    if (!get(environmentServerConfigsAtom).has(environmentId)) return EMPTY_STATUSES;
    const result = get(projectEnvironment.keepRunningStatuses({ environmentId, input: {} }));
    return AsyncResult.getOrElse(result, () => EMPTY_STATUSES);
  }).pipe(Atom.withLabel(`web-project-keep-running:${environmentId}`)),
);

const projectKeepRunningMapAtom = Atom.family((key: string) => {
  const ref = parseScopedProjectKey(key);
  return Atom.make((get): ReadonlyMap<string, ProjectKeepRunningStatus> => {
    if (ref === null) return EMPTY_STATUS_MAP;
    const statuses = get(environmentProjectKeepRunningAtom(ref.environmentId));
    const map = new Map<string, ProjectKeepRunningStatus>();
    for (const status of statuses) {
      if (status.projectId === ref.projectId) {
        map.set(status.scriptId, status);
      }
    }
    return map.size === 0 ? EMPTY_STATUS_MAP : map;
  }).pipe(Atom.withLabel(`web-project-keep-running-map:${key}`));
});

export function useProjectKeepRunningStatuses(
  ref: ScopedProjectRef | null,
): ReadonlyMap<string, ProjectKeepRunningStatus> {
  return useAtomValue(
    ref === null ? EMPTY_STATUS_MAP_ATOM : projectKeepRunningMapAtom(scopedProjectKey(ref)),
  );
}
