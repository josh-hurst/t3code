import { useAtomValue } from "@effect/atom-react";
import { createThreadBackfillAtoms } from "@t3tools/client-runtime/state/thread-backfill";
import type { ContentsBackfillStatus, EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../../connection/runtime";

export const threadBackfillAtoms = createThreadBackfillAtoms(connectionAtomRuntime);

export interface BackfillEnvironment {
  readonly environmentId: EnvironmentId;
  readonly status: ContentsBackfillStatus;
  readonly canStart: boolean;
  readonly canCancel: boolean;
}

const jobsAtom = Atom.family((key: string) => {
  const environmentIds = key === "" ? [] : (key.split("\n") as EnvironmentId[]);
  return Atom.make((get) =>
    environmentIds.map((environmentId): BackfillEnvironment => ({
      environmentId,
      status: AsyncResult.getOrElse(get(threadBackfillAtoms.statusAtom(environmentId)), () => null),
      canStart: get(threadBackfillAtoms.start.permissionAtom(environmentId)),
      canCancel: get(threadBackfillAtoms.cancel.permissionAtom(environmentId)),
    })),
  ).pipe(Atom.withLabel(`web:contents-backfill:${key}`));
});

/** Each environment's backfill job and what this client may do there. */
export function useBackfillEnvironments(
  environmentIds: ReadonlyArray<EnvironmentId>,
): ReadonlyArray<BackfillEnvironment> {
  return useAtomValue(jobsAtom(environmentIds.join("\n")));
}
