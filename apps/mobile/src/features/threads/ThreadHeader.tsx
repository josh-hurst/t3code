import { contentsVisible, entryOwedLabel } from "@t3tools/client-runtime/state/thread-entries";

import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu, AppBarTitleMenu } from "../../components/ui/AppBar.types";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadEntries } from "../../state/threadEntries";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import type { ContentsThread } from "./ThreadContentsList";
import { requestThreadMessageJump } from "./threadMessageJump";

/** The thread's topics under its title: tap the title, pick one, and the feed scrolls to it. */
function useContentsTitleMenu(thread: ContentsThread | undefined): AppBarTitleMenu | undefined {
  const result = useThreadEntries(thread?.environmentId ?? null, thread?.threadId ?? null);
  if (thread === undefined || !contentsVisible(result?.entries)) return undefined;
  const key = scopedThreadKey(thread.environmentId, thread.threadId);
  return {
    title: "Contents",
    items: (result?.entries ?? []).map((entry) => ({
      id: entry.id,
      title: entry.title,
      subtitle: entryOwedLabel(entry.open) ?? entry.outcome ?? undefined,
      onPress: () => requestThreadMessageJump(key, entry.startMessageId),
    })),
  };
}

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  readonly contentsThread?: ContentsThread;
}) {
  const titleMenu = useContentsTitleMenu(props.contentsThread);
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      titleMenu={titleMenu}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}
