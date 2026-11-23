import {
  ArrowLeftIcon,
  ChartNoAxesColumnIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  SettingsIcon,
} from "lucide-react";
import type { ReactNode } from "react";
import { T, useGT } from "gt-react";
import { memo, useState } from "react";
import { useLocation, useNavigate } from "@tanstack/react-router";

import { useAtomValue } from "@effect/atom-react";
import { useClientSettings, useEnvironmentIdentificationMode } from "../../hooks/useSettings";
import { shortcutLabelForCommand } from "../../keybindings";
import {
  navigateHistory,
  useCanNavigateHistory,
  type HistoryDirection,
} from "../../navigationHistory";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { cn } from "../../lib/utils";
import { useIssuesSupported, usePullRequestsSupported } from "../../state/environments";
import { ToolbarCapsule } from "../ToolbarCapsule";
import {
  resolveEnvironmentIdentificationPillLabel,
  resolveSidebarStageBackdropVariant,
  SidebarStageBackdrop,
  useEnvironmentStageLabel,
} from "../SidebarStageBackdrop";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuPopup } from "../ui/menu";
import {
  SidebarFooter,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarTrigger,
  useSidebar,
} from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { readPullRequestListPreferences } from "../pullRequest/pullRequestListPreferences";
import { readIssueListPreferences } from "../issue/issueListPreferences";
import { IssueGlyph } from "../issue/issuePresentation";
import { isSidebarUtilityPage, useNavigateToMainApp } from "./mainAppLocation";
import { SidebarChangesButton, type SidebarChangedProject } from "./SidebarChangesButton";
import { resolveSidebarFooterVisibility } from "./sidebarFooterItems";
import { SidebarFooterItemsMenuItems } from "./SidebarFooterItemsMenu";
import { SidebarThreadUndoNotice } from "./SidebarThreadUndoNotice";
import { SidebarProviderUpdatePill } from "./SidebarProviderUpdatePill";
import { SidebarUpdateArchitectureWarning, SidebarUpdatePill } from "./SidebarUpdatePill";
import { PullRequestGlyph } from "~/components/pullRequest/pullRequestIcons";
import { observeResize } from "~/lib/observeResize";

export const SidebarChromeHeader = memo(function SidebarChromeHeader({
  isElectron,
}: {
  isElectron: boolean;
}) {
  const stageLabel = useEnvironmentStageLabel();
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const gt = useGT();
  const backdropVariant = resolveSidebarStageBackdropVariant(
    stageLabel,
    environmentIdentificationMode,
  );
  const pillLabel =
    environmentIdentificationMode === "pill"
      ? resolveEnvironmentIdentificationPillLabel(stageLabel)
      : null;

  return (
    <div
      className={cn(
        "pointer-events-auto relative flex h-[var(--workspace-topbar-height)] shrink-0 flex-row items-center gap-2 pr-3 md:[[data-sidebar-floating=true]_&]:w-(--sidebar-chrome-width)",
        isElectron && "drag-region",
        !backdropVariant && "topbar-band",
      )}
    >
      {backdropVariant ? <SidebarStageBackdrop variant={backdropVariant} /> : null}
      <div className="relative top-[calc(var(--workspace-controls-top)-env(safe-area-inset-top))] z-10 ml-[calc(var(--workspace-controls-left)+1px-env(safe-area-inset-left))] flex shrink-0 items-center md:hidden">
        <SidebarTrigger
          variant={backdropVariant ? "media-navigation" : "ghost"}
          className="relative top-auto translate-y-0"
          aria-label={gt("Toggle main sidebar")}
        />
      </div>
      <div className="relative z-10 flex h-8 min-w-0 flex-1 flex-wrap content-start items-center gap-x-2 overflow-hidden py-0.5">
        <div className="ml-[var(--workspace-titlebar-content-left)] hidden shrink-0 items-center md:flex">
          {isElectron ? <HistoryNavigation onBackdrop={backdropVariant !== null} /> : null}
        </div>
        {pillLabel ? (
          <div className="ml-1 flex h-7 items-center">
            <Badge data-environment-identification="pill" size="sm" variant="secondary">
              {pillLabel}
            </Badge>
          </div>
        ) : null}
      </div>
    </div>
  );
});

/** Measures what the top strip must fit, which is the narrowest the sidebar may get. */
export function SidebarChromeWidthProbe({
  isElectron,
  onWidthChange,
}: {
  isElectron: boolean;
  onWidthChange: (width: number) => void;
}) {
  const observeWidth = (probe: HTMLDivElement) => {
    return observeResize(probe, ([entry]) => {
      if (entry) onWidthChange(entry.borderBoxSize[0]?.inlineSize ?? probe.offsetWidth);
    });
  };

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none invisible fixed top-0 left-0 flex w-max border-r border-transparent pr-3"
      ref={observeWidth}
    >
      <div className="ml-[var(--workspace-titlebar-content-left)] flex">
        {isElectron ? (
          <div className="w-[calc(2*var(--workspace-titlebar-control-size)+3px)]" />
        ) : null}
      </div>
    </div>
  );
}

function HistoryNavigation({ onBackdrop }: { onBackdrop: boolean }) {
  const back = <HistoryNavigationButton direction="back" onBackdrop={onBackdrop} />;
  const forward = <HistoryNavigationButton direction="forward" onBackdrop={onBackdrop} />;
  // Stage art carries its own contrast, so the buttons stay bare on top of it.
  if (onBackdrop) {
    return (
      <>
        {back}
        {forward}
      </>
    );
  }
  return (
    <ToolbarCapsule className="gap-0">
      {back}
      <span aria-hidden className="h-3.5 w-px shrink-0 bg-(--contrast-toolbar-border)" />
      {forward}
    </ToolbarCapsule>
  );
}

function HistoryNavigationButton({
  direction,
  onBackdrop,
}: {
  direction: HistoryDirection;
  onBackdrop: boolean;
}) {
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const enabled = useCanNavigateHistory(direction);
  const gt = useGT();
  const label = direction === "back" ? gt("Go back") : gt("Go forward");
  const shortcutLabel = shortcutLabelForCommand(
    keybindings,
    direction === "back" ? "navigation.back" : "navigation.forward",
  );
  const Icon = direction === "back" ? ChevronLeftIcon : ChevronRightIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className={cn(
              "[-webkit-app-region:no-drag]",
              onBackdrop && "relative top-auto translate-y-0",
            )}
            disabled={!enabled}
            onClick={() => navigateHistory(direction)}
            size="icon-sm-pill"
            variant={onBackdrop ? "media-navigation" : "ghost"}
          />
        }
      >
        <Icon className="size-4" />
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {label}
        {shortcutLabel ? ` (${shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

function SidebarUtilityItem({
  icon,
  label,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
}) {
  return (
    <SidebarMenuItem className="shrink-0">
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton aria-label={label} onClick={onClick} size="icon">
              {icon}
            </SidebarMenuButton>
          }
        />
        <TooltipPopup side="top">{label}</TooltipPopup>
      </Tooltip>
    </SidebarMenuItem>
  );
}

const SidebarUtilityMenu = memo(function SidebarUtilityMenu({
  changedProjects = [],
}: {
  changedProjects?: ReadonlyArray<SidebarChangedProject>;
}) {
  const navigate = useNavigate();
  const navigateToMainApp = useNavigateToMainApp();
  const gt = useGT();
  const { isMobile, setOpenMobile } = useSidebar();
  const isOnUtilityPage = useLocation({
    select: (location) => isSidebarUtilityPage(location.pathname),
  });
  const pullRequestsSupported = usePullRequestsSupported();
  const issuesSupported = useIssuesSupported();
  const visible = useClientSettings(resolveSidebarFooterVisibility);
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const closeMobileSidebar = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
  };
  const handlePullRequestsClick = () => {
    closeMobileSidebar();
    void navigate({
      to: "/pull-requests",
      search: readPullRequestListPreferences(),
    });
  };
  const handleIssuesClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/issues", search: readIssueListPreferences() });
  };
  const handleSettingsClick = () => {
    closeMobileSidebar();
    void navigate({ to: "/settings" });
  };

  const handleUsageClick = () => {
    if (isMobile) {
      setOpenMobile(false);
    }
    void navigate({ to: "/usage" });
  };

  const handleBackClick = () => {
    closeMobileSidebar();
    void navigateToMainApp();
  };

  return (
    <div
      className="in-data-[sidebar-rows=card]:px-1"
      onContextMenu={(event) => {
        // Popups opened from the footer bubble here through React; they keep their own menus.
        const target = event.target;
        if (isOnUtilityPage || !(target instanceof Node) || !event.currentTarget.contains(target))
          return;
        event.preventDefault();
        setMenuPosition({ x: event.clientX, y: event.clientY });
      }}
    >
      <SidebarMenu className="flex-row items-center">
        {isOnUtilityPage ? (
          <SidebarMenuItem className="min-w-0 flex-1">
            <SidebarMenuButton onClick={handleBackClick}>
              <ArrowLeftIcon />
              <span>
                <T>Back</T>
              </span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        ) : (
          <>
            <SidebarUtilityItem
              icon={<SettingsIcon />}
              label={gt("Settings")}
              onClick={handleSettingsClick}
            />
            {visible.pullRequests && pullRequestsSupported ? (
              <SidebarUtilityItem
                icon={<PullRequestGlyph.pullRequest />}
                label={gt("Pull requests")}
                onClick={handlePullRequestsClick}
              />
            ) : null}
            {visible.issues && issuesSupported ? (
              <SidebarUtilityItem
                icon={<IssueGlyph.issue />}
                label={gt("Issues", { $context: "sidebar link to the list of issues" })}
                onClick={handleIssuesClick}
              />
            ) : null}
            {visible.changes ? (
              <SidebarChangesButton projects={changedProjects} onNavigate={closeMobileSidebar} />
            ) : null}
            {visible.usage ? (
              <SidebarUtilityItem
                icon={<ChartNoAxesColumnIcon />}
                label={gt("Usage")}
                onClick={handleUsageClick}
              />
            ) : null}
          </>
        )}
        <SidebarThreadUndoNotice />
        <SidebarUpdatePill />
      </SidebarMenu>
      <Menu open={menuPosition !== null} onOpenChange={(open) => !open && setMenuPosition(null)}>
        <MenuPopup
          anchor={
            menuPosition
              ? {
                  getBoundingClientRect: () => new DOMRect(menuPosition.x, menuPosition.y, 0, 0),
                }
              : undefined
          }
          align="start"
          side="top"
        >
          <SidebarFooterItemsMenuItems />
        </MenuPopup>
      </Menu>
    </div>
  );
});

export const SidebarChromeFooter = memo(function SidebarChromeFooter({
  changedProjects = [],
}: {
  changedProjects?: ReadonlyArray<SidebarChangedProject> | undefined;
}) {
  return (
    <SidebarFooter>
      <SidebarProviderUpdatePill />
      <SidebarUpdateArchitectureWarning />
      <SidebarUtilityMenu changedProjects={changedProjects} />
    </SidebarFooter>
  );
});
