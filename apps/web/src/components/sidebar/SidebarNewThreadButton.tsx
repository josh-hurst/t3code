import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { isScratchProject } from "@t3tools/client-runtime/state/projects";
import type {
  EnvironmentId,
  EnvironmentMachineKind,
  ResolvedKeybindingsConfig,
} from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { FolderPlusIcon, MessageSquareDashedIcon, SquarePenIcon } from "lucide-react";
import { useRef, useState } from "react";

import { openCommandPalette } from "~/commandPaletteBus";
import type { useHandleNewThread } from "~/hooks/useHandleNewThread";
import { useOrderWhileOpen } from "~/hooks/useOrderWhileOpen";
import { useScratchProject } from "~/hooks/useScratchProject";
import { shortcutLabelForCommand } from "~/keybindings";
import { resolveThreadActionProjectRef, startNewThreadFromContext } from "~/lib/chatThreadActions";
import {
  buildSidebarProjectPickerEntries,
  type SidebarProjectSnapshot,
} from "~/sidebarProjectGrouping";
import { DraftProjectName } from "../chat/DraftProjectName";
import { newThreadNoProjectIndex } from "../CommandPalette.logic";
import { ProjectEnvironmentBadge } from "../ProjectEnvironmentBadge";
import { ProjectFavicon } from "../ProjectFavicon";
import { isProjectPinShortcut, ProjectPinButton } from "../ProjectPinButton";
import {
  resolveScopedNewThreadProjectRef,
  shouldCreateNewThreadInCurrentProject,
} from "../Sidebar.logic";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxSearchInput,
  ComboboxTrigger,
  useComboboxFilter,
} from "../ui/combobox";
import { SidebarMenuButton, useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const ADD_PROJECT_VALUE = "add-project";
const NO_PROJECT_VALUE = "no-project";

interface PickerItem {
  readonly value: string;
  readonly label: string;
}

export interface SidebarNewThreadButtonProps {
  readonly projectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly scopeGroups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly scopedProjectGroups: ReadonlyArray<SidebarProjectSnapshot>;
  readonly boringSidebarEnabled: boolean;
  readonly tide: boolean;
  readonly disabled: boolean;
  readonly newThreadContext: ReturnType<typeof useHandleNewThread>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly environmentMachineById: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
  readonly showProjectEnvironments: boolean;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly canPinProject: (group: SidebarProjectSnapshot) => boolean;
  readonly toggleProjectGroupPin: (group: SidebarProjectSnapshot) => void;
  readonly onAddProject: () => void;
}

export function SidebarNewThreadButton({
  projectGroups,
  scopeGroups,
  scopedProjectGroups,
  boringSidebarEnabled,
  tide,
  disabled,
  newThreadContext,
  primaryEnvironmentId,
  environmentMachineById,
  showProjectEnvironments,
  keybindings,
  canPinProject,
  toggleProjectGroupPin,
  onAddProject,
}: SidebarNewThreadButtonProps) {
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  const { scratchEnvironmentId, scratchWorkspaceRootFor, startScratchThread } = useScratchProject();
  const [pickerOpen, setPickerOpen] = useState(false);
  const [pickerQuery, setPickerQuery] = useState("");
  const pickerFilter = useComboboxFilter();
  const highlightedPickerValueRef = useRef<string | null>(null);

  const contextualProjectRef = resolveThreadActionProjectRef({
    activeDraftThread: newThreadContext.activeDraftThread,
    activeThread: newThreadContext.activeThread ?? undefined,
    defaultProjectRef: newThreadContext.defaultProjectRef,
    handleNewThread: newThreadContext.handleNewThread,
  });
  const projectPickerEntries = buildSidebarProjectPickerEntries({
    groups: scopeGroups,
    preferredProjectRef: contextualProjectRef,
  });
  const menuEntries = projectPickerEntries.filter(
    ({ targetProject }) =>
      !isScratchProject(targetProject, scratchWorkspaceRootFor(targetProject.environmentId)),
  );
  const projectEntryByKey = new Map(
    menuEntries.map((entry) => [entry.group.projectKey, entry] as const),
  );
  const scratchTargetEnvironmentId = scratchEnvironmentId(
    contextualProjectRef?.environmentId ?? null,
  );

  const rawPickerItems: PickerItem[] = menuEntries.map(({ group }) => ({
    value: group.projectKey,
    label: group.displayName,
  }));
  if (scratchTargetEnvironmentId !== null) {
    const noProjectIndex = newThreadNoProjectIndex(
      projectPickerEntries.map(({ group, targetProject, isPreferred }) => ({
        isScratch: isScratchProject(
          targetProject,
          scratchWorkspaceRootFor(targetProject.environmentId),
        ),
        pinned: group.pinned,
        isPreferred,
      })),
    );
    rawPickerItems.splice(noProjectIndex, 0, {
      value: NO_PROJECT_VALUE,
      label: gt("No project"),
    });
  }
  rawPickerItems.push({ value: ADD_PROJECT_VALUE, label: gt("Add project") });

  // Pinning from a row keeps rows in place while the picker is open.
  const pickerItems = useOrderWhileOpen(rawPickerItems, (item) => item.value, pickerOpen);
  const pickerSearch = pickerQuery.trim();
  const filteredPickerItems =
    pickerSearch.length === 0
      ? pickerItems
      : pickerItems.filter((item) => {
          if (item.value === ADD_PROJECT_VALUE) return false;
          if (item.value === NO_PROJECT_VALUE) {
            return [item.label, "no project", "without project", "none"].some((term) =>
              pickerFilter.contains(term, pickerSearch),
            );
          }
          if (pickerFilter.contains(item.label, pickerSearch)) return true;
          const entry = projectEntryByKey.get(item.value);
          if (!entry) return false;
          return entry.group.memberProjects.some(
            (member) =>
              pickerFilter.contains(member.title, pickerSearch) ||
              pickerFilter.contains(member.workspaceRoot, pickerSearch) ||
              (member.environmentLabel !== null &&
                pickerFilter.contains(member.environmentLabel, pickerSearch)),
          );
        });

  const directScopedProjectRef = resolveScopedNewThreadProjectRef({
    shiftKey: false,
    // The folder sidebar's header button always opens the picker.
    scopedProjectGroups: boringSidebarEnabled && !tide ? [] : scopedProjectGroups,
    viewed: newThreadContext.activeThread ?? newThreadContext.activeDraftThread,
  });
  const createsDirectly =
    directScopedProjectRef !== null ||
    shouldCreateNewThreadInCurrentProject(false, scopeGroups.length, projectGroups.length);
  const newThreadShortcutLabel =
    shortcutLabelForCommand(keybindings, "chat.new") ??
    (createsDirectly ? shortcutLabelForCommand(keybindings, "chat.newLocal") : undefined);
  const newThreadInProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newLocal");
  const noProjectShortcutLabel = shortcutLabelForCommand(keybindings, "chat.newWithoutProject");

  const newThreadLabel = newThreadShortcutLabel
    ? gt("New thread ({shortcut})", { shortcut: newThreadShortcutLabel })
    : gt("New thread");

  const newThreadTooltip = !createsDirectly ? (
    <span className="flex flex-col gap-0.5">
      <span>{newThreadLabel}</span>
      <span className="text-muted-foreground">
        {newThreadInProjectShortcutLabel
          ? gt("New thread in current project: Shift+click ({shortcut})", {
              shortcut: newThreadInProjectShortcutLabel,
            })
          : gt("New thread in current project: Shift+click")}
      </span>
    </span>
  ) : (
    newThreadLabel
  );

  const startDirectNewThread = (shiftKey: boolean) => {
    const scopedProjectRef = resolveScopedNewThreadProjectRef({
      shiftKey,
      // The folder sidebar's header button always opens the picker.
      scopedProjectGroups: boringSidebarEnabled && !tide ? [] : scopedProjectGroups,
      viewed: newThreadContext.activeThread ?? newThreadContext.activeDraftThread,
    });
    if (scopedProjectRef) {
      if (isMobile) setOpenMobile(false);
      void newThreadContext.handleNewThread(scopedProjectRef);
      return;
    }
    // With no current or open project, such as when every project is archived, pick one.
    void startNewThreadFromContext({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    }).then((started) => {
      if (started) {
        if (isMobile) setOpenMobile(false);
      } else if (createsDirectly) {
        openCommandPalette({ open: "new-thread-in" });
      } else {
        setPickerOpen(true);
        setPickerQuery("");
      }
    });
  };

  if (createsDirectly) {
    return (
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              type="button"
              aria-label={gt("New thread")}
              disabled={disabled}
              onClick={(event) => startDirectNewThread(event.shiftKey)}
            />
          }
        >
          <SquarePenIcon />
          <span className="truncate">{gt("New thread")}</span>
        </TooltipTrigger>
        <TooltipPopup side="right">{newThreadTooltip}</TooltipPopup>
      </Tooltip>
    );
  }

  return (
    <Combobox<PickerItem>
      items={pickerItems}
      filteredItems={filteredPickerItems}
      autoHighlight
      itemToStringLabel={(item) => item.label}
      isItemEqualToValue={(a, b) => a.value === b.value}
      open={pickerOpen}
      onItemHighlighted={(item) => {
        highlightedPickerValueRef.current = item?.value ?? null;
      }}
      onOpenChange={(open, eventDetails) => {
        if (eventDetails.isCanceled) return;
        if (open) {
          const shiftKey =
            eventDetails.event !== undefined &&
            "shiftKey" in eventDetails.event &&
            Boolean(eventDetails.event.shiftKey);
          if (shiftKey) {
            eventDetails.cancel();
            startDirectNewThread(true);
            return;
          }
        }
        setPickerOpen(open);
        setPickerQuery("");
      }}
      value={null}
      onValueChange={(item) => {
        // Ignore closed-trigger typeahead so typing while focused cannot launch a thread.
        if (!item || !pickerOpen) return;
        setPickerOpen(false);
        setPickerQuery("");
        if (isMobile) setOpenMobile(false);
        if (item.value === ADD_PROJECT_VALUE) {
          onAddProject();
          return;
        }
        if (item.value === NO_PROJECT_VALUE) {
          if (scratchTargetEnvironmentId !== null) {
            void startScratchThread(scratchTargetEnvironmentId);
          }
          return;
        }
        const entry = projectEntryByKey.get(item.value);
        if (!entry) return;
        void newThreadContext.handleNewThread(
          scopeProjectRef(entry.targetProject.environmentId, entry.targetProject.id),
        );
      }}
    >
      <Tooltip disabled={pickerOpen}>
        <TooltipTrigger
          render={
            <ComboboxTrigger
              render={
                <SidebarMenuButton
                  type="button"
                  aria-label={gt("New thread")}
                  disabled={disabled}
                />
              }
            />
          }
        >
          <SquarePenIcon />
          <span className="truncate">{gt("New thread")}</span>
        </TooltipTrigger>
        <TooltipPopup side="right">{newThreadTooltip}</TooltipPopup>
      </Tooltip>
      {/* Refocusing the trigger after a pointer close shows its focus ring and opens its tooltip. */}
      <ComboboxPopup
        align="start"
        collisionAvoidance={{ side: "flip", align: "shift" }}
        className="w-[min(18rem,var(--available-width))] overflow-hidden"
        finalFocus={(closeType) => closeType === "keyboard"}
      >
        <ComboboxSearchInput
          aria-label={gt("Search projects")}
          placeholder={gt("Search projects...")}
          value={pickerQuery}
          onChange={(event) => setPickerQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.defaultPrevented || event.nativeEvent.isComposing || event.keyCode === 229) {
              return;
            }
            const highlighted = highlightedPickerValueRef.current;
            const group = highlighted ? projectEntryByKey.get(highlighted)?.group : undefined;
            if (!group || !canPinProject(group) || !isProjectPinShortcut(event, keybindings)) {
              return;
            }
            event.preventDefault();
            event.stopPropagation();
            toggleProjectGroupPin(group);
          }}
        />
        <ComboboxEmpty>
          <T>No matching projects.</T>
        </ComboboxEmpty>
        <ComboboxList>
          {(item: PickerItem) => {
            const entry = projectEntryByKey.get(item.value);
            return (
              <ComboboxItem key={item.value} hideIndicator value={item}>
                {item.value === ADD_PROJECT_VALUE ? (
                  <FolderPlusIcon className="size-4 shrink-0" />
                ) : item.value === NO_PROJECT_VALUE ? (
                  <MessageSquareDashedIcon className="size-4 shrink-0" />
                ) : entry ? (
                  <ProjectFavicon project={entry.group} className="size-4 shrink-0" />
                ) : null}
                {entry ? (
                  <Tooltip>
                    <TooltipTrigger render={<span className="min-w-0 flex-1 text-sm" />}>
                      <DraftProjectName value={item.label} />
                    </TooltipTrigger>
                    <TooltipPopup side="top">{item.label}</TooltipPopup>
                  </Tooltip>
                ) : (
                  <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
                )}
                {item.value === NO_PROJECT_VALUE && noProjectShortcutLabel ? (
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {noProjectShortcutLabel}
                  </span>
                ) : null}
                {entry && canPinProject(entry.group) ? (
                  <ProjectPinButton
                    name={entry.group.displayName}
                    pinned={entry.group.pinned}
                    shortcutLabel={shortcutLabelForCommand(keybindings, "thread.pin")}
                    onToggle={() => toggleProjectGroupPin(entry.group)}
                  />
                ) : null}
                {entry && showProjectEnvironments ? (
                  <ProjectEnvironmentBadge
                    group={entry.group}
                    primaryEnvironmentId={primaryEnvironmentId}
                    machineByEnvironmentId={environmentMachineById}
                  />
                ) : null}
              </ComboboxItem>
            );
          }}
        </ComboboxList>
      </ComboboxPopup>
    </Combobox>
  );
}
