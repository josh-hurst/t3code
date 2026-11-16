import { backfillRunning } from "@t3tools/client-runtime/state/thread-backfill";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { refreshEntries } from "../../state/threadEntries";
import { useAtomCommand } from "../../state/use-atom-command";
import { InlineButton } from "../ui/button";
import { type BackfillProjectOption, HistoryBackfillDialog } from "./HistoryBackfillDialog";
import { threadBackfillAtoms, useBackfillEnvironments } from "./historyBackfillState";

/** "Add older threads…", or the running job's progress with Cancel. */
export function HistoryBackfillFooter(props: {
  readonly environmentIds: ReadonlyArray<EnvironmentId>;
  /** Projects of the chosen chip, so the dialog starts on one of them. */
  readonly scope: ReadonlyArray<ScopedProjectRef> | null;
}) {
  const jobs = useBackfillEnvironments(props.environmentIds);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const [open, setOpen] = useState(false);
  const cancel = useAtomCommand(threadBackfillAtoms.cancel, "Cancel adding older threads");

  const progressKey = JSON.stringify(
    jobs.flatMap(({ environmentId, status }) =>
      status === null ? [] : [[environmentId, status.done, status.finishedAt]],
    ),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the topic lists again as a job files threads, since backfilled entries of settled threads reach no stream
  useEffect(() => {
    const progress = JSON.parse(progressKey) as ReadonlyArray<[EnvironmentId, number, unknown]>;
    if (progress.length > 0) refreshEntries(progress.map(([environmentId]) => environmentId));
  }, [progressKey]);

  const startable = new Set(jobs.flatMap((job) => (job.canStart ? [job.environmentId] : [])));
  const labelOf = new Map(
    environments.map((environment) => [environment.environmentId, environment.label]),
  );
  const options: ReadonlyArray<BackfillProjectOption> = projects
    .filter(
      (project) =>
        project.isScratch !== true && props.environmentIds.includes(project.environmentId),
    )
    .map((project) => ({
      environmentId: project.environmentId,
      projectId: project.id,
      label:
        props.environmentIds.length > 1
          ? `${project.title} · ${labelOf.get(project.environmentId) ?? "Server"}`
          : project.title,
    }));
  const initial =
    props.scope?.find((ref) => props.environmentIds.includes(ref.environmentId)) ?? null;

  const running = jobs.find((job) => backfillRunning(job.status));
  if (running?.status != null) {
    return (
      <p className="flex items-center gap-2">
        Adding older threads, {running.status.done} of {running.status.total}
        {running.canCancel ? (
          <InlineButton
            tone="muted"
            onClick={() => void cancel({ environmentId: running.environmentId, input: {} })}
          >
            Cancel
          </InlineButton>
        ) : null}
      </p>
    );
  }
  // The last job's result, until the server restarts; a stopped or partly failed job says so.
  const last = jobs.find(
    (job) => job.status !== null && (job.status.failed > 0 || job.status.done < job.status.total),
  )?.status;
  if (startable.size === 0 || options.length === 0) return null;
  return (
    <>
      {last != null ? (
        <p>
          Last run added {last.done - last.failed} of {last.total} older threads. The rest are left
          for the next start.
        </p>
      ) : null}
      <InlineButton tone="muted" onClick={() => setOpen(true)}>
        Add older threads…
      </InlineButton>
      {open ? (
        <HistoryBackfillDialog
          projects={options}
          initialKey={initial === null ? null : `${initial.environmentId}:${initial.projectId}`}
          canStart={(environmentId) => startable.has(environmentId)}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}
