import { CollapsibleSectionHeader } from "../ui/collapsible-section-header";
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import {
  ActivityIcon,
  AlarmClockIcon,
  HistoryIcon,
  TimerIcon,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useLayoutEffect } from "react";
import { cn } from "~/lib/utils";
import { InlineButton } from "../ui/button";
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

/** Labels Recent's last rows, the ones the server expects to settle on their own. */
export function SidebarSettlingLabel(props: { label: string; count: number }) {
  return (
    <SortableSidebarMarker
      marker="settling-header"
      data-testid="sidebar-settling-header"
      className="mx-0.5"
    >
      <div className="flex h-7 items-end gap-1.5 px-2.5 pb-1 text-xs font-medium text-sidebar-muted-foreground">
        <TimerIcon aria-hidden className="size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{props.label}</span>
        <span className="font-normal tabular-nums">{props.count}</span>
      </div>
    </SortableSidebarMarker>
  );
}

/** Ends Recent after threads settled on their own while this window was not being looked at. */
export function SidebarSettledAwayNotice(props: {
  label: string;
  showLabel: string;
  undoLabel: string;
  onShow: () => void;
  onUndo: () => void;
}) {
  return (
    <SortableSidebarMarker
      marker="settled-away"
      data-testid="sidebar-settled-away"
      className="mx-0.5"
    >
      <div className="flex h-7 items-center gap-1.5 px-2.5 text-xs text-sidebar-muted-foreground">
        <HistoryIcon aria-hidden className="size-3.5 shrink-0" />
        <InlineButton
          tone="muted"
          className="min-w-0 flex-1"
          title={props.showLabel}
          onClick={props.onShow}
        >
          <span className="truncate">{props.label}</span>
        </InlineButton>
        <InlineButton onClick={props.onUndo}>{props.undoLabel}</InlineButton>
      </div>
    </SortableSidebarMarker>
  );
}

const shelves = {
  "working-header": { id: "working", Icon: ActivityIcon },
  "snoozed-header": { id: "snoozed", Icon: AlarmClockIcon },
  "settled-header": { id: "settled", Icon: HistoryIcon },
} as const;

/** A shelf header's place in the list: the first shelf sits at the bottom, under a rule. */
function shelfHeaderClassName(input: { first: boolean; tide: boolean; tall: boolean }) {
  const belowRecent = input.first && input.tide;
  return cn(
    "relative h-8",
    // With card rows the header's own padding plus this margin lands its text on the cards' inset.
    input.tide ? "mx-1" : "mx-0.5",
    input.first && "mt-auto",
    belowRecent && input.tall && "h-12 pt-4",
    belowRecent && "group-data-[variant=frameless]:h-16 group-data-[variant=frameless]:pt-8",
  );
}

function ShelfHeaderBody(props: {
  shelf: string;
  Icon: LucideIcon;
  label: string;
  count: number;
  first: boolean;
  tide: boolean;
  tone?: "muted" | "emphasized" | "accent";
  toggle: { expanded: boolean; onToggle: () => void };
  action?: ReactNode;
}) {
  const { Icon } = props;
  const header = (
    <CollapsibleSectionHeader
      data-sidebar-row={`shelf:${props.shelf}`}
      onClick={props.toggle.onToggle}
      expanded={props.toggle.expanded}
      tone={props.tone ?? "muted"}
      data-testid={`sidebar-${props.shelf}-shelf-toggle`}
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
    <>
      {props.first && props.tide && (
        <span
          aria-hidden
          className="pointer-events-none absolute -inset-x-[calc(var(--sidebar-content-inset)+0.25rem)] top-6 hidden border-t border-sidebar-border/70 group-data-[variant=frameless]:block"
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
    </>
  );
}

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
  return (
    <SortableSidebarMarker
      marker={props.marker}
      data-testid={`sidebar-${props.marker}`}
      className={shelfHeaderClassName({
        first: props.first,
        tide: props.tide,
        tall: shelf !== "settled",
      })}
    >
      <ShelfHeaderBody
        shelf={shelf}
        Icon={Icon}
        label={props.label}
        count={props.count}
        first={props.first}
        tide={props.tide}
        tone={props.isDropTarget ? "accent" : props.dragging ? "emphasized" : "muted"}
        toggle={props.toggle}
        action={props.action}
      />
    </SortableSidebarMarker>
  );
}
