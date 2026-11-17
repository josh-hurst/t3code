import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { useMemo } from "react";

import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";

import { useProjects } from "../../state/entities";
import { useSavedRemoteConnections } from "../../state/use-remote-environment-registry";
import { useWorkspaceState } from "../../state/workspace";
import { buildHomeListFilterMenuItems } from "./home-list-filter-menu";
import { useHomeListOptions } from "./home-list-options";
import { buildHomeProjectScopes, resolveHomeProjectFilterScope } from "./homeThreadList";

/** The thread list's environment and project filter, shared by the list and its bar's filter menu. */
export function useHomeListFilter() {
  const projects = useProjects();
  const { environments: workspaceEnvironments } = useWorkspaceState();
  const { savedConnectionsById } = useSavedRemoteConnections();
  const connectionStateByEnvironmentId = new Map(
    workspaceEnvironments.map(
      (environment) => [environment.environmentId, environment.connectionState] as const,
    ),
  );
  const environments = Arr.sort(
    Object.values(savedConnectionsById).map((connection) => ({
      environmentId: connection.environmentId,
      label: connection.environmentLabel,
      connectionState: connectionStateByEnvironmentId.get(connection.environmentId) ?? "available",
    })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
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
      buildHomeProjectScopes({
        projects,
        environmentId: selectedEnvironmentId,
        projectGroupingMode: listOptions.projectGroupingMode,
      }),
    [listOptions.projectGroupingMode, projects, selectedEnvironmentId],
  );
  const projectFilterOptions = useMemo(
    () =>
      pickableProjectGroups(projectScopes).map((scope) => ({
        key: scope.key,
        label: scope.title,
      })),
    [projectScopes],
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
    menuItems: buildHomeListFilterMenuItems({
      environments,
      projects: projectFilterOptions,
      selectedEnvironmentId,
      selectedProjectKey,
      onEnvironmentChange: setSelectedEnvironmentId,
      onProjectChange: setSelectedProjectKey,
    }),
  };
}
