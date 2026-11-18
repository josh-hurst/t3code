import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { ActivityIcon, AlarmClockIcon, HistoryIcon } from "lucide-react";
import { type ReactNode, useLayoutEffect } from "react";
import { cn } from "~/lib/utils";
import {
  animateSidebarLayoutChanges,
  sidebarMarkerId,
  type SidebarListMarker,
} from "../Sidebar.logic";
import { SIDEBAR_SORTABLE_DRAG_DISABLED } from "./SidebarThreadRow";

export function SortableSidebarMarker(props: {
  marker: SidebarListMarker;
  className?: string;
  children?: ReactNode;
  revealOverflow?: boolean;
  "data-testid"?: string;
}) {
  const { node, setNodeRef, transform, transition } = useSortable({
    id: sidebarMarkerId(props.marker),
    disabled: SIDEBAR_SORTABLE_DRAG_DISABLED,
    animateLayoutChanges: animateSidebarLayoutChanges,
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the projected drop box inside the scroll viewport as drag transforms move it
  useLayoutEffect(() => {
    if (props.revealOverflow && transform?.y !== undefined) {
      node.current?.firstElementChild?.scrollIntoView({ block: "nearest", inline: "nearest" });
    }
  }, [node, props.revealOverflow, transform?.y]);
  return (
    <li
      ref={setNodeRef}
      data-thread-selection-safe
      data-testid={props["data-testid"]}
      className={cn("list-none", props.className)}
      style={{
        transform: CSS.Translate.toString(transform),
        transition: props.marker.endsWith("-placeholder") ? "none" : transition,
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
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className="relative mx-0.5 -mb-px h-0"
      // Revealing on every drag scrolls the list out from under the pointer.
      revealOverflow={
        props.marker === "settled-placeholder" && props.showHint && props.isDropTarget
      }
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
      marker={props.marker}
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

const shelves = {
  "working-header": { id: "working", Icon: ActivityIcon },
  "snoozed-header": { id: "snoozed", Icon: AlarmClockIcon },
  "settled-header": { id: "settled", Icon: HistoryIcon },
} as const;

export function SidebarSectionHeader(props: {
  marker: keyof typeof shelves;
  label: string;
  /** A muted trailing count. */
  count: number;
  first: boolean;
  tide: boolean;
  dragging?: boolean;
  isDropTarget?: boolean;
  toggle: { expanded: boolean; onToggle: () => void };
  /** A control beside the label, outside the toggle, such as History's "All". */
  action?: ReactNode;
}) {
  const { id: shelf, Icon } = shelves[props.marker];
  const belowRecent = props.first && props.tide;
  const header = (
    <CollapsibleSectionHeader
      data-sidebar-row={`shelf:${shelf}`}
      onClick={props.toggle.onToggle}
      expanded={props.toggle.expanded}
      tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
      data-testid={`sidebar-${shelf}-shelf-toggle`}
      accessory={<span className="font-normal tabular-nums">{props.count}</span>}
    >
      {props.tide && (
        <Icon
          aria-hidden
          className="me-1.5 hidden size-3.5 align-[-0.15rem] group-data-[variant=frameless]:inline"
        />
      )}
      {props.label}
    </CollapsibleSectionHeader>
  );
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={cn(
        "relative mx-0.5 h-8",
        props.first && "mt-auto",
        belowRecent && shelf !== "settled" && "h-12 pt-4",
        belowRecent && "group-data-[variant=frameless]:h-16 group-data-[variant=frameless]:pt-8",
      )}
    >
      {belowRecent && (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-x-[calc(var(--sidebar-content-inset)+0.125rem)] top-6 hidden border-t border-sidebar-border/70 group-data-[variant=frameless]:block"
        />
      )}
      {props.action ? (
        <div className="flex h-8 items-center">
          <div className="min-w-0 flex-1">{header}</div>
          {props.action}
        </div>
      ) : (
        header
      )}
    </SortableSidebarMarker>
  );
}
