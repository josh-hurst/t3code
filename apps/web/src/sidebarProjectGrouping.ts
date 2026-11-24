import type {
  EnvironmentId,
  ScopedProjectRef,
  SidebarProjectGroupingMode,
} from "@t3tools/contracts";
import {
  buildProjectGroups,
  derivePhysicalProjectKey,
  isPickableProjectMember,
  resolveScratchProjectScopeKey,
  selectGroupDefaultProject,
  type ProjectGroupingSettings,
} from "@t3tools/client-runtime/state/project-grouping";
import { msg } from "gt-react";

import { m, type MessageResolver } from "./i18n/messages";
import type { Project } from "./types";

export const PROJECT_GROUPING_MODE_LABELS: Record<SidebarProjectGroupingMode, string> = {
  repository: msg("Group by repository", { $context: "sidebar project grouping mode" }),
  repository_path: msg("Group by repository path", { $context: "sidebar project grouping mode" }),
  separate: msg("Keep separate", { $context: "sidebar project grouping mode" }),
};

export function withProjectGroupingOverride(
  overrides: Readonly<Record<string, SidebarProjectGroupingMode>> | undefined,
  overrideKey: string,
  selection: SidebarProjectGroupingMode | "inherit",
): Record<string, SidebarProjectGroupingMode> {
  const next = { ...overrides };
  if (selection === "inherit") delete next[overrideKey];
  else next[overrideKey] = selection;
  return next;
}

export type EnvironmentPresence = "local-only" | "remote-only" | "mixed";

export interface SidebarProjectGroupMember extends Project {
  physicalProjectKey: string;
  environmentLabel: string | null;
}

export interface SidebarProjectSnapshot extends Project {
  projectKey: string;
  displayName: string;
  groupedProjectCount: number;
  environmentPresence: EnvironmentPresence;
  allRemoteMembersAreDesktopLocal: boolean;
  allRemoteMembersAreWsl: boolean;
  memberProjects: readonly SidebarProjectGroupMember[];
  memberProjectRefs: readonly ScopedProjectRef[];
  remoteEnvironmentLabels: readonly string[];
  pinned: boolean;
  archived: boolean;
}

export function projectGroupsSpanEnvironments(
  groups: ReadonlyArray<Pick<SidebarProjectSnapshot, "memberProjects">>,
): boolean {
  const environmentIds = new Set<EnvironmentId>();
  for (const group of groups) {
    for (const member of group.memberProjects) {
      environmentIds.add(member.environmentId);
      if (environmentIds.size > 1) return true;
    }
  }
  return false;
}

export interface SidebarProjectPickerEntry {
  group: SidebarProjectSnapshot;
  targetProject: SidebarProjectGroupMember;
  isPreferred: boolean;
}

export function getSidebarProjectSettingsKey(
  group: SidebarProjectSnapshot,
  settings: ProjectGroupingSettings,
  projects: ReadonlyArray<Project>,
  projectRef?: ScopedProjectRef,
): string {
  if (!group.isScratch) return group.projectKey;
  const project =
    group.memberProjects.find(
      (member) =>
        member.environmentId === projectRef?.environmentId && member.id === projectRef.projectId,
    ) ??
    group.memberProjects.find((member) => member.environmentId === projectRef?.environmentId) ??
    group;
  return (
    buildPhysicalToLogicalProjectKeyMap({ projects, settings, primaryEnvironmentId: null }).get(
      derivePhysicalProjectKey(project),
    ) ?? group.projectKey
  );
}

export function resolveSidebarProjectScopeKey(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly key: string | null;
  readonly settings?: ProjectGroupingSettings;
  readonly canClearMissingScope?: boolean;
}): string | null {
  if (input.key === null) return null;
  const group =
    input.groups.find((candidate) => candidate.projectKey === input.key) ??
    input.groups.find(
      (candidate) =>
        candidate.isScratch &&
        resolveScratchProjectScopeKey(input.key, candidate.memberProjects, input.settings) ===
          candidate.projectKey,
    );
  return group?.projectKey ?? (input.canClearMissingScope ? null : input.key);
}

export function resolveSidebarProjectScopeKeys(input: {
  readonly groups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly keys: ReadonlyArray<string>;
  readonly settings?: ProjectGroupingSettings;
  readonly canClearMissingScope?: boolean;
}): string[] {
  return [
    ...new Set(input.keys.flatMap((key) => resolveSidebarProjectScopeKey({ ...input, key }) ?? [])),
  ];
}

export function buildPhysicalToLogicalProjectKeyMap(input: {
  projects: ReadonlyArray<Project>;
  settings: ProjectGroupingSettings;
  primaryEnvironmentId: EnvironmentId | null;
}): Map<string, string> {
  const mapping = new Map<string, string>();
  const groups = buildProjectGroups({
    projects: input.projects,
    settings: input.settings,
    preferredEnvironmentId: input.primaryEnvironmentId,
  });
  for (const group of groups) {
    for (const member of group.members) {
      mapping.set(member.physicalProjectKey, group.key);
    }
  }
  return mapping;
}

export function buildSidebarProjectSnapshots(
  input: {
    projects: ReadonlyArray<Project>;
    settings: ProjectGroupingSettings;
    groupScratchProjects?: boolean;
    primaryEnvironmentId: EnvironmentId | null;
    resolveEnvironmentLabel: (environmentId: EnvironmentId) => string | null;
    isDesktopLocalEnvironment?: (environmentId: EnvironmentId) => boolean;
    isWslEnvironment?: (environmentId: EnvironmentId) => boolean;
  },
  resolve: MessageResolver = m,
): SidebarProjectSnapshot[] {
  return buildProjectGroups(
    {
      projects: input.projects,
      groupScratchProjects: input.groupScratchProjects ?? false,
      settings: input.settings,
      preferredEnvironmentId: input.primaryEnvironmentId,
    },
    resolve,
  ).map((group): SidebarProjectSnapshot => {
    const members = group.members.map(
      ({ physicalProjectKey, project }): SidebarProjectGroupMember => ({
        ...project,
        physicalProjectKey,
        environmentLabel: input.resolveEnvironmentLabel(project.environmentId),
      }),
    );
    const representative =
      members.find(
        (member) =>
          member.environmentId === group.representative.environmentId &&
          member.id === group.representative.id,
      ) ?? members[0]!;

    const hasLocal =
      input.primaryEnvironmentId !== null &&
      members.some((member) => member.environmentId === input.primaryEnvironmentId);
    const hasRemote =
      input.primaryEnvironmentId !== null
        ? members.some((member) => member.environmentId !== input.primaryEnvironmentId)
        : false;
    const remoteMembers = members.filter(
      (member) =>
        input.primaryEnvironmentId !== null && member.environmentId !== input.primaryEnvironmentId,
    );
    const remoteEnvironmentLabels = remoteMembers
      .flatMap((member) => (member.environmentLabel ? [member.environmentLabel] : []))
      .filter((label, index, labels) => labels.indexOf(label) === index);
    const isDesktopLocal = input.isDesktopLocalEnvironment ?? (() => false);
    const isWsl = input.isWslEnvironment ?? (() => false);
    const allRemoteMembersAreDesktopLocal =
      remoteMembers.length > 0 &&
      remoteMembers.every((member) => isDesktopLocal(member.environmentId));
    const allRemoteMembersAreWsl =
      remoteMembers.length > 0 && remoteMembers.every((member) => isWsl(member.environmentId));

    return {
      ...representative,
      projectKey: group.key,
      displayName: group.label,
      groupedProjectCount: members.length,
      environmentPresence:
        hasLocal && hasRemote ? "mixed" : hasRemote ? "remote-only" : "local-only",
      allRemoteMembersAreDesktopLocal,
      allRemoteMembersAreWsl,
      memberProjects: members,
      memberProjectRefs: group.memberProjectRefs,
      remoteEnvironmentLabels,
      pinned: group.pinned,
      archived: group.archived,
    };
  });
}

export function buildSidebarProjectPickerEntries(input: {
  groups: ReadonlyArray<SidebarProjectSnapshot>;
  preferredProjectRef: ScopedProjectRef | null;
}) {
  const preferredProjectRef = input.preferredProjectRef;
  const entries = input.groups.flatMap((group): SidebarProjectPickerEntry[] => {
    const members = group.memberProjects.filter(isPickableProjectMember);
    const isPreferred = preferredProjectRef
      ? group.memberProjectRefs.some(
          (projectRef) =>
            projectRef.environmentId === preferredProjectRef.environmentId &&
            projectRef.projectId === preferredProjectRef.projectId,
        )
      : false;
    const preferredProject = preferredProjectRef
      ? (members.find(
          (project) =>
            project.environmentId === preferredProjectRef.environmentId &&
            project.id === preferredProjectRef.projectId,
        ) ??
        selectGroupDefaultProject(
          members.filter((project) => project.environmentId === preferredProjectRef.environmentId),
        ))
      : null;
    const targetProject =
      preferredProject ??
      members.find(
        (project) => project.environmentId === group.environmentId && project.id === group.id,
      ) ??
      members[0];
    if (!targetProject) return [];

    return [{ group, targetProject, isPreferred }];
  });
  // The current project leads, even ahead of pinned projects.
  const preferred = entries.find((entry) => entry.isPreferred);
  if (!preferred) return entries;
  return [preferred, ...entries.filter((entry) => entry !== preferred)];
}

interface RecentThreadInput {
  readonly environmentId: EnvironmentId;
  readonly projectId: string;
  readonly createdAt: string;
  readonly lineage: { readonly parentThreadId: string | null };
}

/**
 * Orders new-thread picker entries by how many of the latest `recentThreadCount` top-level
 * threads each project started. Pinned projects stay first; ties keep the incoming order.
 */
export function rankNewThreadProjectEntries<
  TEntry extends {
    readonly group: Pick<SidebarProjectSnapshot, "projectKey" | "memberProjectRefs" | "pinned">;
  },
>(
  entries: ReadonlyArray<TEntry>,
  threads: ReadonlyArray<RecentThreadInput>,
  recentThreadCount: number,
): TEntry[] {
  const groupKeyByProjectRef = new Map<string, string>();
  for (const { group } of entries) {
    for (const ref of group.memberProjectRefs) {
      groupKeyByProjectRef.set(`${ref.environmentId}\0${ref.projectId}`, group.projectKey);
    }
  }
  const recent = threads
    .filter((thread) => thread.lineage.parentThreadId === null)
    .toSorted((left, right) =>
      left.createdAt === right.createdAt ? 0 : left.createdAt < right.createdAt ? 1 : -1,
    )
    .slice(0, Math.max(0, recentThreadCount));
  const useCount = new Map<string, number>();
  for (const thread of recent) {
    const key = groupKeyByProjectRef.get(`${thread.environmentId}\0${thread.projectId}`);
    if (key !== undefined) useCount.set(key, (useCount.get(key) ?? 0) + 1);
  }
  return entries
    .map((entry, index) => ({ entry, index, uses: useCount.get(entry.group.projectKey) ?? 0 }))
    .toSorted(
      (left, right) =>
        Number(right.entry.group.pinned) - Number(left.entry.group.pinned) ||
        right.uses - left.uses ||
        left.index - right.index,
    )
    .map(({ entry }) => entry);
}
