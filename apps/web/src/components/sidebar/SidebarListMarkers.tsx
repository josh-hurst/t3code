import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ChevronDownIcon, FolderIcon, PlusIcon } from "lucide-react";
import { type ReactNode } from "react";
import { cn } from "~/lib/utils";
import { animateSidebarLayoutChanges, sidebarMarkerId } from "../Sidebar.logic";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { SIDEBAR_SORTABLE_DRAG_DISABLED, SIDEBAR_SORTABLE_DRAG_ENABLED } from "./SidebarThreadRow";

function SortableSidebarMarker(props: {
  id: string;
  placeholder?: boolean;
  draggable?: boolean;
  className?: string;
  children?: ReactNode;
  "data-testid"?: string;
}) {
  const { setNodeRef, transform, transition, listeners, isDragging } = useSortable({
    id: props.id,
    disabled: props.draggable ? SIDEBAR_SORTABLE_DRAG_ENABLED : SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  return (
    <li
      ref={setNodeRef}
      {...(props.draggable ? listeners : {})}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn(
        "list-none",
        props.className,
        isDragging && "relative z-20 rounded-md bg-sidebar shadow-sm",
      )}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.placeholder ? "none" : transition,
        visibility: transform?.scaleY === 0 ? "hidden" : undefined,
      }}
    >
      {props.children}
    </li>
  );
}

export function SidebarSectionPlaceholder(props: {
  marker: "active-placeholder" | "settled-placeholder";
  label: string;
  showHint: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      id={sidebarMarkerId(props.marker)}
      placeholder
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
    >
      {props.showHint ? (
        <div
          className={cn(
            "absolute inset-x-0 top-0 flex h-9 items-center justify-center rounded-md border border-dashed border-sidebar-foreground/25 text-xs text-sidebar-foreground/80",
            props.isDropTarget && "border-primary/40 bg-primary/5 text-primary",
          )}
        >
          {props.label}
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarDragBoundary(props: {
  marker: "pinned-header" | "pinned-divider";
  label: string;
  visible: boolean;
  isDropTarget: boolean;
}) {
  return (
    <SortableSidebarMarker
      id={sidebarMarkerId(props.marker)}
      data-testid={`sidebar-${props.marker}`}
      className="pointer-events-none relative mx-0.5 -mb-px h-0"
    >
      {props.visible ? (
        <div className="sidebar-drag-boundary-label absolute inset-x-2 top-1 flex h-4 items-center gap-2">
          <span
            className={cn(
              "shrink-0 text-xs font-medium",
              props.isDropTarget ? "text-primary" : "text-sidebar-foreground/80",
            )}
          >
            {props.label}
          </span>
          <span
            aria-hidden
            className={cn(
              "h-px flex-1",
              props.isDropTarget ? "bg-primary/50" : "bg-sidebar-foreground/25",
            )}
          />
        </div>
      ) : null}
    </SortableSidebarMarker>
  );
}

export function SidebarSectionHeader(props: {
  marker: "working-header" | "snoozed-header" | "settled-header";
  label: string;
  className?: string;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
}) {
  const shelf =
    props.marker === "working-header"
      ? "working"
      : props.marker === "snoozed-header"
        ? "snoozed"
        : "settled";
  const snoozed = shelf === "snoozed";
  return (
    <SortableSidebarMarker
      id={sidebarMarkerId(props.marker)}
      data-testid={`sidebar-${props.marker}`}
      className={cn("mx-0.5 h-8", props.className)}
    >
      <CollapsibleSectionHeader
        onClick={props.toggle.onToggle}
        expanded={props.toggle.expanded}
        tone={
          props.isDropTarget ? "accent" : props.dragging ? "emphasized" : snoozed ? "info" : "muted"
        }
        data-testid={`sidebar-${shelf}-shelf-toggle`}
      >
        {props.label}
      </CollapsibleSectionHeader>
    </SortableSidebarMarker>
  );
}

export function SidebarGroupHeader(props: {
  id: string;
  label: string;
  project: ProjectFaviconProject | null;
  folder?: boolean;
  section: {
    collapsed: boolean;
    count: number;
    onToggle: () => void;
    onContextMenu: (position: { x: number; y: number }) => void;
    // Null for folders, which hold threads from any project.
    onNewThread: (() => void) | null;
  };
}) {
  const { section } = props;
  const label = (
    <>
      {props.project ? (
        <ProjectFavicon project={props.project} className="size-4 shrink-0" />
      ) : props.folder ? (
        <FolderIcon aria-hidden className="size-3.5 shrink-0 text-sidebar-muted-foreground" />
      ) : null}
      <span className="min-w-0 truncate text-xs font-semibold text-sidebar-foreground">
        {props.label}
      </span>
    </>
  );
  const rowClassName = "flex h-7 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left";
  return (
    <SortableSidebarMarker
      id={props.id}
      draggable
      data-testid="sidebar-group-header"
      className="mx-0.5 flex h-11 items-end pb-0.5"
    >
      <div
        className="flex w-full min-w-0 items-center rounded-md hover:bg-sidebar-row-hover"
        onContextMenu={(event) => {
          event.preventDefault();
          section.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        <button
          type="button"
          aria-expanded={!section.collapsed}
          className={cn(
            rowClassName,
            "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70",
          )}
          onClick={section.onToggle}
        >
          {label}
          {section.collapsed ? (
            <span className="shrink-0 text-xs text-sidebar-muted-foreground tabular-nums">
              {section.count}
            </span>
          ) : null}
          <span aria-hidden className="h-px min-w-2 flex-1 bg-sidebar-border" />
          <ChevronDownIcon
            aria-hidden
            className={cn(
              "size-3 shrink-0 text-sidebar-muted-foreground",
              section.collapsed && "-rotate-90",
            )}
          />
        </button>
        {section.onNewThread === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  aria-label={`New thread in ${props.label}`}
                  className="me-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded-md text-sidebar-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
                  onClick={section.onNewThread}
                />
              }
            >
              <PlusIcon aria-hidden className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="top">New thread in {props.label}</TooltipPopup>
          </Tooltip>
        )}
      </div>
    </SortableSidebarMarker>
  );
}
