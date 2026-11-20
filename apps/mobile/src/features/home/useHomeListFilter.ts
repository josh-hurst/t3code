import { useMessages } from "gt-react-native";
import { useMemo } from "react";

import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import { useProjects } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";
import { buildHomeListFilterMenuItems, homeListFilterEnvironments } from "./home-list-filter-menu";
import { useHomeListOptions } from "./home-list-options";
import {
  buildHomeProjectScopes,
  resolveHomeProjectFilterScope,
  sortHomeProjectScopes,
} from "./homeThreadList";

const NO_THREADS: ReadonlyArray<EnvironmentThreadShell> = [];

/**
 * The thread list's environment and project filter, shared by the list and its bar's filter menu.
 * Projects list most recently active first; without threads they fall back to project activity.
 */
export function useHomeListFilter(threads = NO_THREADS) {
  const m = useMessages();
  const projects = useProjects();
  const { environments: workspaceEnvironments } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const environments = homeListFilterEnvironments(workspaceEnvironments);
  const availableEnvironmentIds = useMemo(
    () => new Set(environments.map((environment) => environment.environmentId)),
    [environments],
  );
  const {
    options: listOptions,
    setSelectedEnvironmentId,
    setSelectedProjectKey,
  } = useHomeListOptions(availableEnvironmentIds);
  const selectedEnvironmentId = listOptions.selectedEnvironmentId;
  const projectScopes = useMemo(
    () =>
      buildHomeProjectScopes(
        {
          projects,
          environmentId: selectedEnvironmentId,
          projectGroupingMode: listOptions.projectGroupingMode,
        },
        m,
      ),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId, m],
  );
  const projectFilterOptions = useMemo(
    () =>
      pickableProjectGroups(
        sortHomeProjectScopes({
          scopes: projectScopes,
          threads,
          pendingTasks: [],
          projectSortOrder: "updated_at",
        }),
      ).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes, threads],
  );
  const selectedProjectKey =
    resolveHomeProjectFilterScope(projectScopes, projects, listOptions)?.key ?? null;
  const selectedEnvironmentLabel =
    environments.find((environment) => environment.environmentId === selectedEnvironmentId)
      ?.label ?? null;
  const selectedProjectLabel =
    projectFilterOptions.find((project) => project.key === selectedProjectKey)?.label ?? null;

  return {
    projects,
    savedConnectionsById,
    environments,
    listOptions,
    selectedEnvironmentId,
    selectedProjectKey,
    setSelectedEnvironmentId,
    setSelectedProjectKey,
    /** Names of the active filters, in the order the menu lists them. */
    activeLabels: [selectedEnvironmentLabel, selectedProjectLabel].filter(
      (label): label is string => label !== null,
    ),
    menuItems: buildHomeListFilterMenuItems(
      {
        environments,
        projects: projectFilterOptions,
        selectedEnvironmentId,
        selectedProjectKey,
        onEnvironmentChange: setSelectedEnvironmentId,
        onProjectChange: setSelectedProjectKey,
      },
      m,
    ),
  };
}
