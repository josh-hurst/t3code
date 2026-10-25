import { randomUUID } from "~/lib/utils";
import { useUiStateStore } from "../uiStateStore";
import { requestSidebarFolderName } from "./SidebarFolderNameDialog";
import type { SidebarFolderMenuState } from "./threadActionMenu.logic";

/** The thread menu's folder choices; folders only group the list while project sections are off. */
export function readSidebarFolderMenuState(
  threadKey: string,
  projectSectionsEnabled: boolean,
): SidebarFolderMenuState | null {
  if (projectSectionsEnabled) return null;
  const state = useUiStateStore.getState();
  return {
    items: state.sidebarFolders,
    currentFolderId: state.sidebarThreadFolderById[threadKey] ?? null,
  };
}

/** Handles a `folder:*` menu action for the given scoped thread keys. */
export async function runSidebarFolderAction(
  action: `folder:${string}`,
  threadKeys: readonly string[],
): Promise<void> {
  const store = useUiStateStore.getState();
  const target = action.slice("folder:".length);
  if (target === "none") {
    store.setSidebarThreadFolder(threadKeys, null);
    return;
  }
  if (target !== "new") {
    store.setSidebarThreadFolder(threadKeys, target);
    return;
  }
  const name = await requestSidebarFolderName({ title: "New folder", submitLabel: "Create" });
  if (name === null) return;
  const id = `folder-${randomUUID()}`;
  store.createSidebarFolder({ id, name });
  store.setSidebarThreadFolder(threadKeys, id);
}
