import type { EnvironmentId, ProjectId, ScopedProjectRef } from "@t3tools/contracts";

export interface HistorySearch {
  /** A sidebar project group's key. */
  readonly project?: string;
  readonly open?: "1";
  /** The chosen project's uncommitted, unpushed and unpublished work in place of the topics. */
  readonly view?: "changes";
  readonly q?: string;
}

/** The longest query `listEntries` takes. */
const HISTORY_QUERY_MAX = 100;

export function validateHistorySearch(raw: Record<string, unknown>): HistorySearch {
  const project = typeof raw.project === "string" ? raw.project.trim().slice(0, 500) : "";
  const q = typeof raw.q === "string" ? raw.q.slice(0, HISTORY_QUERY_MAX) : "";
  return {
    ...(project === "" ? {} : { project }),
    // The router reads `open=1` from a URL as a number.
    ...(raw.open === "1" || raw.open === 1 ? { open: "1" as const } : {}),
    ...(raw.view === "changes" ? { view: "changes" as const } : {}),
    ...(q.trim() === "" ? {} : { q }),
  };
}

/** Mark published's calls: one per environment that holds the group's projects. */
export function publishTargets(
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

/**
 * Chips for the projects the page has shown so far, in sidebar order, plus the chosen one, so a
 * chip never disappears while its rows are filtered away.
 */
export function historyChipKeys(input: {
  readonly orderedKeys: ReadonlyArray<string>;
  readonly seenKeys: ReadonlySet<string>;
  readonly chosenKey: string | null;
}): ReadonlyArray<string> {
  return input.orderedKeys.filter((key) => input.seenKeys.has(key) || key === input.chosenKey);
}
