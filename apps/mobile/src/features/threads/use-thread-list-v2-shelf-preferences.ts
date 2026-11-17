import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { useMemo } from "react";

import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";

/** The shelf flags as the list uses them: the self-filing list forces Working on and folders off. */
export function useThreadListV2ShelfPreferences() {
  const preferencesResult = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const loaded = AsyncResult.isSuccess(preferencesResult);
  // Unset means the self-filing list, so it is also what shows before preferences load.
  const tide = !(loaded && preferencesResult.value.classicThreadList === true);
  // Each layout keeps its own Later/Snoozed state, so switching back restores the classic shelf.
  // Later starts collapsed in both layouts: what lands there should not need a look.
  const snoozedShelfExpanded = tide
    ? loaded && preferencesResult.value.threadListLaterExpanded === true
    : loaded && preferencesResult.value.threadListSnoozedShelfExpanded === true;
  const settledShelfExpanded =
    loaded && preferencesResult.value.threadListSettledShelfExpanded === true;
  const workingShelfEnabled =
    tide || (loaded && preferencesResult.value.workingShelfEnabled !== false);
  // The self-filing list shows Working open until it is collapsed, as the web sidebar does.
  const workingShelfExpanded = tide
    ? !loaded || preferencesResult.value.threadListWorkingShelfExpanded !== false
    : loaded && preferencesResult.value.threadListWorkingShelfExpanded === true;
  const trailExpanded = loaded && preferencesResult.value.threadListTrailExpanded === true;
  const projectFoldersEnabled =
    !tide && loaded && preferencesResult.value.projectFoldersEnabled === true;
  const collapsedProjectGroups = loaded
    ? preferencesResult.value.collapsedProjectGroups
    : undefined;
  const collapsedFolderKeys = useMemo(
    () => new Set(collapsedProjectGroups ?? []),
    [collapsedProjectGroups],
  );

  // Transforms read optimistic state so same-frame presses toggle twice.
  const toggleSnoozedShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) =>
        current.classicThreadList === true
          ? { threadListSnoozedShelfExpanded: current.threadListSnoozedShelfExpanded !== true }
          : { threadListLaterExpanded: current.threadListLaterExpanded !== true },
    });
  };
  const toggleSettledShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListSettledShelfExpanded: current.threadListSettledShelfExpanded !== true,
      }),
    });
  };
  const toggleWorkingShelf = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListWorkingShelfExpanded:
          current.classicThreadList === true
            ? current.threadListWorkingShelfExpanded !== true
            : current.threadListWorkingShelfExpanded === false,
      }),
    });
  };
  const toggleTrail = () => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => ({
        threadListTrailExpanded: current.threadListTrailExpanded !== true,
      }),
    });
  };

  const toggleFolder = (key: string) => {
    if (!loaded) return;
    savePreferences({
      transform: (current) => {
        const collapsed = current.collapsedProjectGroups ?? [];
        return {
          collapsedProjectGroups: collapsed.includes(key)
            ? collapsed.filter((candidate) => candidate !== key)
            : [...collapsed, key],
        };
      },
    });
  };

  return {
    loaded,
    tide,
    collapsedFolderKeys,
    projectFoldersEnabled,
    settledShelfExpanded,
    snoozedShelfExpanded,
    trailExpanded,
    workingShelfEnabled,
    workingShelfExpanded,
    toggleSettledShelf,
    toggleSnoozedShelf,
    toggleFolder,
    toggleTrail,
    toggleWorkingShelf,
  } as const;
}
