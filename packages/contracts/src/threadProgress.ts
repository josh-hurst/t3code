import * as Schema from "effect/Schema";

import { IsoDateTime, NodeId, RunId } from "./baseSchemas.ts";

export const THREAD_PROGRESS_LINE_MAX = 72;
export const THREAD_PROGRESS_AGENT_LINE_MAX = 110;
export const THREAD_PROGRESS_AGENTS_MAX = 12;

export const ThreadProgressAgent = Schema.Struct({
  subagentId: NodeId,
  line: Schema.String.check(Schema.isMaxLength(THREAD_PROGRESS_AGENT_LINE_MAX)),
});
export type ThreadProgressAgent = typeof ThreadProgressAgent.Type;

/** What every client lists. Small on purpose: the shell is streamed to every client. */
export const ThreadProgressSummary = Schema.Struct({
  line: Schema.String.check(Schema.isMaxLength(THREAD_PROGRESS_LINE_MAX)),
  runId: RunId,
  at: IsoDateTime,
});
export type ThreadProgressSummary = typeof ThreadProgressSummary.Type;

export const ThreadProgress = Schema.Struct({
  ...ThreadProgressSummary.fields,
  agents: Schema.Array(ThreadProgressAgent).check(Schema.isMaxLength(THREAD_PROGRESS_AGENTS_MAX)),
});
export type ThreadProgress = typeof ThreadProgress.Type;

export const threadProgressSummary = (progress: ThreadProgress): ThreadProgressSummary => ({
  line: progress.line,
  runId: progress.runId,
  at: progress.at,
});

/** True only when `progress` belongs to the thread's current (active or latest) run. */
export const threadProgressIsCurrent = (
  progress: Pick<ThreadProgressSummary, "runId"> | null | undefined,
  runs: { readonly activeRunId: RunId | null; readonly latestRunId: RunId | null },
): boolean => {
  if (progress == null) return false;
  const currentRunId = runs.activeRunId ?? runs.latestRunId;
  return currentRunId !== null && progress.runId === currentRunId;
};
