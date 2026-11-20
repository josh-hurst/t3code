import { contentsVisible, entryOwedLabel } from "@t3tools/client-runtime/state/thread-entries";
import { useGT, useMessages } from "gt-react-native";
import { Platform } from "react-native";

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
import { useDeviceType } from "../../native/native-layout-metrics";

/** The thread's topics under its title: tap the title, pick one, and the feed scrolls to it. */
function useContentsTitleMenu(thread: ContentsThread | undefined): AppBarTitleMenu | undefined {
  const gt = useGT();
  const result = useThreadEntries(thread?.environmentId ?? null, thread?.threadId ?? null);
  if (thread === undefined || !contentsVisible(result?.entries)) return undefined;
  const key = scopedThreadKey(thread.environmentId, thread.threadId);
  return {
    title: gt("Contents"),
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
  const gt = useGT();
  const m = useMessages();
  const titleMenu = useContentsTitleMenu(props.contentsThread);
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const deviceType = useDeviceType();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, m);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const filesAction: AppBarAction | null = props.hasThreadCwd
    ? {
        accessibilityLabel: filesVisible ? gt("Close files") : gt("Open files"),
        icon: "folder",
        selected: filesVisible,
        disabled: !props.gitControls.canOpenFiles,
        separateBackground: false,
        onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
      }
    : null;
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);
  // A phone gathers Files, Git and Terminal under one "…", like UIKit does for a crowded bar.
  const moreMenu: AppBarMenu | null =
    Platform.OS === "ios" && deviceType === "phone" && (filesAction !== null || menus.length > 0)
      ? {
          title: gt("More actions"),
          icon: "ellipsis",
          items: [
            ...(filesAction
              ? [
                  {
                    id: "files",
                    title: filesVisible ? gt("Close Files") : gt("Files"),
                    icon: "folder",
                    disabled: filesAction.disabled,
                    onPress: filesAction.onPress,
                  },
                ]
              : []),
            ...menus.map((menu) => ({
              id: menu.title,
              title: menu === gitMenu ? gt("Git") : menu.title,
              icon: typeof menu.icon === "string" ? menu.icon : menu.icon.ios,
              items: menu.items,
            })),
          ],
        }
      : null;

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
              accessibilityLabel: gt("Return to chat"),
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={moreMenu || !filesAction ? [] : [filesAction]}
      menus={moreMenu ? [moreMenu] : menus}
      hideBottomBorder
    />
  );
}
