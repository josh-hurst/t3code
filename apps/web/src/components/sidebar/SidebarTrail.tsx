import { ChevronDownIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SortableSidebarMarker } from "./SidebarListMarkers";

export function SidebarTrailHeader(props: {
  count: number;
  groupByProject: boolean;
  // Null while no row it regroups is shown: the Trail's first rows always keep last-touch order.
  onToggleGroupByProject: (() => void) | null;
  // Null when nothing in the Trail can be cleared, such as only the open thread.
  onClear: (() => void) | null;
  clearShortcutLabel: string | null;
  dragging: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      marker="trail-header"
      data-testid="sidebar-trail-header"
      className="relative mx-0.5 h-8"
    >
      <div
        className={cn(
          "flex h-8 items-center gap-1 px-2 text-xs font-medium",
          props.isDropTarget
            ? "text-primary"
            : props.dragging
              ? "text-sidebar-foreground/80"
              : "text-sidebar-muted-foreground",
        )}
      >
        <span className="min-w-0 flex-1 truncate">Trail</span>
        {props.onToggleGroupByProject ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="micro"
                  variant="ghost-muted"
                  aria-label={
                    props.groupByProject
                      ? "Grouped by project. Group by day instead"
                      : "Grouped by day. Group by project instead"
                  }
                  onClick={props.onToggleGroupByProject}
                />
              }
            >
              {props.groupByProject ? "By project" : "By day"}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {props.groupByProject
                ? "Rows past the Trail's first eight, and History, are grouped by project. Click to group by day."
                : "Rows past the Trail's first eight, and History, are grouped by day. Click to group by project."}
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {props.onClear ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  size="micro"
                  variant="ghost-muted"
                  aria-label="Clear the Trail"
                  onClick={props.onClear}
                />
              }
            >
              Clear
            </TooltipTrigger>
            <TooltipPopup side="top">
              Settle every Trail thread except the open one into History
              {props.clearShortcutLabel ? ` (${props.clearShortcutLabel})` : ""}. Undo brings them
              all back.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        <span className="ms-1 font-normal tabular-nums">{props.count}</span>
      </div>
    </SortableSidebarMarker>
  );
}

/** "Next" on the Needs you panel's label: opens the next thread that needs you. */
export function SidebarNeedsYouNext(props: { shortcutLabel: string | null; onNext: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="micro"
            variant="ghost-muted"
            aria-label="Go to the next thread that needs you"
            onPointerDown={(event) => event.stopPropagation()}
            onClick={props.onNext}
          />
        }
      >
        Next
      </TooltipTrigger>
      <TooltipPopup side="top">
        Go to the next thread that needs you
        {props.shortcutLabel ? ` (${props.shortcutLabel})` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

export function SidebarTrailMore(props: {
  label: string;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <SortableSidebarMarker marker="trail-more" data-testid="sidebar-trail-more">
      <button
        type="button"
        data-sidebar-row="trail:more"
        aria-expanded={props.expanded}
        onClick={props.onToggle}
        className="flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-left text-sm text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
      >
        <ChevronDownIcon
          aria-hidden
          className={cn("size-4 shrink-0 transition-transform", props.expanded && "rotate-180")}
        />
        {props.expanded ? "Show less" : props.label}
      </button>
    </SortableSidebarMarker>
  );
}
