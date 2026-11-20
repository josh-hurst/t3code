import { DndContext, useDraggable, type DragEndEvent } from "@dnd-kit/core";
import { CSS, getEventCoordinates } from "@dnd-kit/utilities";
import * as Schema from "effect/Schema";
import { ExternalLinkIcon, GripVerticalIcon, PinIcon } from "lucide-react";
import { useRef, useState, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import { DetachedSidebarWindow } from "./DetachedSidebarWindow";

const WindowPosition = Schema.NullOr(Schema.Struct({ x: Schema.Finite, y: Schema.Finite }));
type WindowPosition = typeof WindowPosition.Type;

export function useThreadSidebarPosition() {
  return useLocalStorage("chat_thread_sidebar_position", null, WindowPosition);
}

interface WindowProps {
  readonly children: ReactNode;
  readonly position: WindowPosition;
  readonly onPositionChange: (position: WindowPosition) => void;
}

export function ThreadSidebarWindow(props: WindowProps) {
  const { isMobile } = useSidebar();
  if (isMobile) return props.children;
  return <DesktopSidebarWindow {...props} />;
}

function DesktopSidebarWindow(props: WindowProps) {
  const boundsRef = useRef<HTMLDivElement>(null);
  const { open } = useSidebar();
  const [detached, setDetached] = useState<Window | null>(null);
  if (detached && (!open || props.position === null)) setDetached(null);

  const detach = (rect: { left: number; top: number; width: number; height: number }) => {
    const view = window.open(
      "about:blank",
      `t3code-threads-${Math.random().toString(36).slice(2)}`,
      `popup,width=${Math.round(rect.width)},height=${Math.round(rect.height)},left=${Math.round(window.screenX + rect.left)},top=${Math.round(window.screenY + rect.top)}`,
    );
    if (!view) {
      toastManager.add({
        type: "error",
        title: "Could not open the sidebar window",
        description: "Allow popups for this site, then use the sidebar's open-window button.",
      });
      return false;
    }
    setDetached(view);
    return true;
  };

  const finishMove = ({ active, delta, activatorEvent }: DragEndEvent) => {
    const start = active.rect.current.initial;
    const bounds = boundsRef.current?.getBoundingClientRect();
    if (!open || !start || !bounds || (delta.x === 0 && delta.y === 0)) return;
    const pointer = getEventCoordinates(activatorEvent);
    const x = (pointer?.x ?? start.left + start.width / 2) + delta.x;
    const y = (pointer?.y ?? start.top + 16) + delta.y;
    if (
      props.position &&
      (x < 0 || x > window.innerWidth || y < 0 || y > window.innerHeight) &&
      detach({
        width: start.width,
        height: start.height,
        left: start.left + delta.x,
        top: start.top + delta.y,
      })
    )
      return;
    props.onPositionChange({
      x: Math.round(start.left + delta.x - bounds.left),
      y: Math.round(start.top + delta.y - bounds.top),
    });
  };

  if (detached && open && props.position !== null) {
    return (
      <DetachedSidebarWindow view={detached} onClose={() => setDetached(null)}>
        <WindowHeader
          floating
          onPin={() => {
            props.onPositionChange(null);
            setDetached(null);
          }}
        />
        {props.children}
      </DetachedSidebarWindow>
    );
  }

  return (
    <div
      ref={boundsRef}
      className="pointer-events-none absolute bottom-3 left-[calc(env(safe-area-inset-left)+0.75rem)] top-[calc(var(--workspace-topbar-height)+0.75rem)] w-[calc(100dvw-env(safe-area-inset-left)-env(safe-area-inset-right)-1.5rem)] [container-type:size] group-data-[collapsible=offcanvas]:invisible group-data-[collapsible=offcanvas]:opacity-0 [[data-panel-animations=true]_&]:transition-[opacity,visibility] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration)"
    >
      <DndContext autoScroll={false} onDragEnd={finishMove}>
        <WindowFrame {...props} onDetach={detach} />
      </DndContext>
    </div>
  );
}

function WindowFrame({
  children,
  position,
  onPositionChange,
  onDetach,
}: WindowProps & {
  readonly onDetach: (rect: DOMRect) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform } =
    useDraggable({ id: "Threads window" });

  return (
    <div
      ref={(node) => {
        frameRef.current = node;
        setNodeRef(node);
      }}
      data-sidebar-window={position ? "floating" : "pinned"}
      className={cn(
        "pointer-events-auto absolute top-0 left-0 flex max-h-full w-[calc(var(--sidebar-width)-0.75rem)] max-w-full flex-col rounded-2xl border border-sidebar-border bg-sidebar surface-grain text-sidebar-foreground dark:bg-(--surface-raised)",
        position || isDragging ? "shadow-xl/14 dark:shadow-xl/40" : "shadow-md/8 dark:shadow-md/30",
      )}
      style={{
        translate: `clamp(0px, ${position?.x ?? 0}px, 100cqw - 100%) clamp(0px, ${position?.y ?? 0}px, 100cqh - 100%)`,
        transform: CSS.Translate.toString(transform),
      }}
    >
      <WindowHeader
        floating={position !== null}
        onPin={() => onPositionChange(position ? null : { x: 0, y: 0 })}
        onDetach={
          position
            ? () => {
                const rect = frameRef.current?.getBoundingClientRect();
                if (rect) onDetach(rect);
              }
            : undefined
        }
      >
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          {...listeners}
          aria-label="Move Threads window"
          className="flex h-8 min-w-0 flex-1 cursor-grab touch-none select-none items-center gap-1.5 rounded-md px-1 text-left text-sm font-semibold tracking-tight outline-none active:cursor-grabbing focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          <GripVerticalIcon aria-hidden className="size-3.5 text-sidebar-muted-foreground/60" />
          Threads
        </button>
      </WindowHeader>
      {children}
    </div>
  );
}

function WindowHeader({
  floating,
  onPin,
  onDetach,
  children,
}: {
  readonly floating: boolean;
  readonly onPin: () => void;
  readonly onDetach?: (() => void) | undefined;
  readonly children?: ReactNode;
}) {
  const pinLabel = floating ? "Pin sidebar beside chat" : "Float sidebar over chat";
  return (
    <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5">
      {children ?? (
        <span className="flex h-8 flex-1 items-center px-1 text-sm font-semibold">Threads</span>
      )}
      {onDetach ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Open sidebar in a separate window"
                size="icon-sm"
                variant="ghost-muted"
                onClick={onDetach}
              />
            }
          >
            <ExternalLinkIcon />
          </TooltipTrigger>
          <TooltipPopup side="bottom">Open sidebar in a separate window</TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              aria-label="Pin sidebar beside chat"
              aria-pressed={!floating}
              size="icon-sm"
              variant="ghost-muted"
              onClick={onPin}
            />
          }
        >
          <PinIcon fill={floating ? "none" : "currentColor"} />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{pinLabel}</TooltipPopup>
      </Tooltip>
    </div>
  );
}
