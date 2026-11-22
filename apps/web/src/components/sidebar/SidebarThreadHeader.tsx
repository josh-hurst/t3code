import { useGT } from "gt-react";
import { BellDotIcon, SearchIcon, SquarePenIcon, XIcon } from "lucide-react";
import {
  type ComponentProps,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject,
  useState,
} from "react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { SidebarInput, SidebarMenuButton } from "../ui/sidebar";
import { SidebarBrand } from "./SidebarBrand";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export interface SidebarThreadHeaderProps {
  hasProjects: boolean;
  projectScope: ReactNode;
  // Threads that need you in projects the current scope leaves out.
  needsYouElsewhere: number;
  // The new layout names the projects the list is scoped to on a row of its own; null otherwise.
  focusedProjects: string | null;
  onShowAllProjects: () => void;
  onNewThread: (event: ReactMouseEvent) => void;
  newThreadDisabled: boolean;
  newThreadShortcutLabel: string | null | undefined;
  newThreadInProjectShortcutLabel: string | null | undefined;
  showNewThreadInProjectHint: boolean;
  searchInputRef: RefObject<HTMLInputElement | null>;
  searchQuery: string;
  onSearchQueryChange: (value: string) => void;
  onSearchKeyDown: (event: ReactKeyboardEvent<HTMLInputElement>) => void;
  isSearching: boolean;
  // While a query is typed, the header's buttons step aside so the query is not clipped.
  queryTakesRow: boolean;
  searchResultCount: number;
  activeSearchResultIndex: number;
  onClearSearch: () => void;
}

export function SidebarThreadHeader({
  hasProjects,
  projectScope,
  needsYouElsewhere,
  focusedProjects,
  onShowAllProjects,
  onNewThread,
  newThreadDisabled,
  newThreadShortcutLabel,
  newThreadInProjectShortcutLabel,
  showNewThreadInProjectHint,
  searchInputRef,
  searchQuery,
  onSearchQueryChange,
  onSearchKeyDown,
  isSearching,
  queryTakesRow,
  searchResultCount,
  activeSearchResultIndex,
  onClearSearch,
}: SidebarThreadHeaderProps) {
  const gt = useGT();
  const [searchFocused, setSearchFocused] = useState(false);
  // Search rests as an icon beside the wordmark and takes the row once it is in use.
  const searchOpen = isSearching || searchFocused;
  const resultsVisible = isSearching && searchResultCount > 0;
  // Shrinking results can remove the active option; never leave aria-activedescendant pointing at it.
  const activeResultExists = resultsVisible && activeSearchResultIndex < searchResultCount;
  const newThreadLabel = newThreadShortcutLabel
    ? gt("New thread ({shortcut})", { shortcut: newThreadShortcutLabel })
    : gt("New thread");

  const newThreadTooltip = showNewThreadInProjectHint ? (
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

  return (
    // New thread stands apart: the gap above it matches the group's own padding below it.
    <div className="flex flex-col gap-(--sidebar-content-inset)">
      <div className="flex h-8 items-center gap-1 pe-1.5">
        {searchOpen ? null : <SidebarBrand className="flex-1" />}
        {/* A label, so a click on the collapsed icon focuses the field and opens it. */}
        <label
          className={cn(
            "flex h-7 min-w-0 items-center rounded-md text-sm font-medium text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-within:bg-sidebar-row-hover focus-within:text-sidebar-foreground focus-within:ring-1 focus-within:ring-inset focus-within:ring-ring/70",
            searchOpen ? "flex-1 gap-2 px-2" : "w-7 shrink-0 cursor-pointer justify-center",
          )}
          // Pressing the icon or padding would blur the field first, closing the row mid-click.
          onMouseDown={(event) => {
            if (event.target === searchInputRef.current) return;
            event.preventDefault();
            searchInputRef.current?.focus();
          }}
          onFocus={() => setSearchFocused(true)}
          onBlur={(event) => {
            if (!event.currentTarget.contains(event.relatedTarget)) setSearchFocused(false);
          }}
        >
          <SearchIcon className="size-4 shrink-0 text-(--sidebar-icon-color)" />
          <SidebarInput
            ref={searchInputRef}
            nativeInput
            type="search"
            value={searchQuery}
            onChange={(event) => onSearchQueryChange(event.currentTarget.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={gt("Search", { $context: "search field placeholder" })}
            aria-label={gt("Search threads")}
            role="combobox"
            aria-autocomplete="list"
            aria-expanded={resultsVisible}
            aria-controls={resultsVisible ? "sidebar-thread-search-results" : undefined}
            aria-activedescendant={
              activeResultExists
                ? `sidebar-thread-search-result-${activeSearchResultIndex}`
                : undefined
            }
            className={cn("min-w-0", searchOpen ? "flex-1" : "w-0 flex-none overflow-hidden")}
          />
          {isSearching ? (
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0"
              aria-label={gt("Clear thread search")}
              onClick={() => {
                onClearSearch();
                searchInputRef.current?.focus();
              }}
            >
              <XIcon className="size-3" />
            </Button>
          ) : null}
        </label>
        {hasProjects ? (
          <div className={cn("flex shrink-0 items-center gap-1", queryTakesRow && "hidden")}>
            {needsYouElsewhere > 0 && focusedProjects === null ? (
              <Button
                type="button"
                size="xs"
                variant="ghost-muted"
                title="Show all projects"
                onClick={onShowAllProjects}
              >
                {needsYouElsewhere} elsewhere
              </Button>
            ) : null}
            {projectScope}
          </div>
        ) : null}
      </div>
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarMenuButton
              type="button"
              aria-label={gt("New thread")}
              disabled={newThreadDisabled}
              onClick={onNewThread}
            />
          }
        >
          <SquarePenIcon />
          <span className="truncate">{gt("New thread")}</span>
        </TooltipTrigger>
        <TooltipPopup side="right">{newThreadTooltip}</TooltipPopup>
      </Tooltip>
      {focusedProjects !== null ? (
        <SidebarFocusStrip
          projects={focusedProjects}
          needsYouElsewhere={needsYouElsewhere}
          onShowAllProjects={onShowAllProjects}
        />
      ) : null}
    </div>
  );
}

function SidebarFocusStrip(props: {
  projects: string;
  needsYouElsewhere: number;
  onShowAllProjects: () => void;
}) {
  const elsewhereLabel = `${props.needsYouElsewhere} ${props.needsYouElsewhere === 1 ? "thread needs" : "threads need"} you in other projects. Show all projects`;
  return (
    <div className="flex h-7 min-w-0 items-center gap-0.5 ps-2 pe-1 text-xs text-sidebar-muted-foreground">
      <span className="min-w-0 truncate">
        Only <span className="font-medium text-sidebar-foreground">{props.projects}</span>
      </span>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              type="button"
              size="icon-micro"
              variant="ghost-muted"
              className="shrink-0"
              aria-label="Show all projects"
              onClick={props.onShowAllProjects}
            />
          }
        >
          <XIcon />
        </TooltipTrigger>
        <TooltipPopup side="top">Show all projects</TooltipPopup>
      </Tooltip>
      <span className="flex-1" />
      {props.needsYouElsewhere > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                aria-label={elsewhereLabel}
                onClick={props.onShowAllProjects}
                className="inline-flex h-5 shrink-0 cursor-pointer items-center gap-1 rounded-sm px-0.5 font-medium text-primary hover:bg-sidebar-row-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
              />
            }
          >
            {/* The Needs you bell and colour say what the count is. */}
            <BellDotIcon aria-hidden className="size-3.5" />
            {props.needsYouElsewhere} elsewhere
          </TooltipTrigger>
          <TooltipPopup side="top">{elsewhereLabel}</TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export function SidebarHeaderIconButton({
  label,
  tooltip = label,
  className,
  children,
  ...rest
}: {
  label: string;
  tooltip?: ReactNode;
  className?: string | undefined;
  children?: ReactNode;
} & Omit<
  ComponentProps<typeof SidebarMenuButton>,
  "children" | "className" | "tooltip" | "isActive" | "aria-label"
>) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <SidebarMenuButton
            size="icon"
            type="button"
            aria-label={label}
            {...rest}
            className={cn("relative size-7 shrink-0", className)}
          />
        }
      >
        {children}
        <span
          aria-hidden
          className="pointer-events-none absolute left-1/2 top-1/2 size-[max(100%,3rem)] -translate-1/2 pointer-fine:hidden"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
