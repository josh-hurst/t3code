import {
  ORCHESTRATION_V2_WS_METHODS,
  type ContentsBackfillEstimateInput,
  type ContentsBackfillStatus,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Atom, type AtomRegistry } from "effect/reactivity";

import type * as EnvironmentRegistry from "../connection/registry.ts";
import { request } from "../rpc/client.ts";
import { createEnvironmentQueryAtomFamily, createEnvironmentRpcCommand } from "./runtime.ts";

/** How often a running job's progress is read; nothing streams it. */
const STATUS_POLL_MS = 2_000;

export const backfillRunning = (status: ContentsBackfillStatus | null | undefined) =>
  status != null && status.finishedAt === null;

/** The environment's backfill job, its estimates, and Start and Cancel. */
export function createThreadBackfillAtoms<R, ER>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry.EnvironmentRegistry | R, ER>,
) {
  // Bumped by Start and Cancel, so the status is read again and polls while the job runs.
  const versionAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make(0).pipe(Atom.keepAlive, Atom.withLabel(`thread-backfill:version:${environmentId}`)),
  );
  const refresh = (registry: AtomRegistry.AtomRegistry, environmentId: EnvironmentId) =>
    registry.update(versionAtom(environmentId), (version) => version + 1);

  const statusQuery = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:contents-backfill",
    staleTimeMs: 0,
    idleTtlMs: 0,
    refreshIntervalMs: STATUS_POLL_MS,
    isFinal: (status: ContentsBackfillStatus) => !backfillRunning(status),
    // `version` only names which read this is.
    execute: (_input: { readonly version: number }) =>
      request(ORCHESTRATION_V2_WS_METHODS.getContentsBackfill, {}),
  });
  const statusAtom = Atom.family((environmentId: EnvironmentId) =>
    Atom.make((get) =>
      get(statusQuery({ environmentId, input: { version: get(versionAtom(environmentId)) } })),
    ).pipe(Atom.withLabel(`thread-backfill:status:${environmentId}`)),
  );

  const estimate = createEnvironmentQueryAtomFamily(runtime, {
    label: "environment-data:orchestration:contents-backfill-estimate",
    staleTimeMs: Number.POSITIVE_INFINITY,
    idleTtlMs: 0,
    // `attempt` reads a fresh estimate once one has expired.
    execute: ({
      attempt: _attempt,
      ...input
    }: ContentsBackfillEstimateInput & { readonly attempt: number }) =>
      request(ORCHESTRATION_V2_WS_METHODS.estimateContentsBackfill, input),
  });

  const commandOptions = {
    onSuccess: (
      { environmentId }: { readonly environmentId: EnvironmentId },
      registry: AtomRegistry.AtomRegistry,
    ) => Effect.sync(() => refresh(registry, environmentId)),
  };
  return {
    statusAtom,
    estimate,
    start: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:orchestration:start-contents-backfill",
      tag: ORCHESTRATION_V2_WS_METHODS.startContentsBackfill,
      ...commandOptions,
    }),
    cancel: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:commands:orchestration:cancel-contents-backfill",
      tag: ORCHESTRATION_V2_WS_METHODS.cancelContentsBackfill,
      ...commandOptions,
    }),
  };
}
