import { DndContext, useDraggable, type DragEndEvent } from "@dnd-kit/core";
import { restrictToParentElement } from "@dnd-kit/modifiers";
import { CSS } from "@dnd-kit/utilities";
import * as Schema from "effect/Schema";
import { GripVerticalIcon, PinIcon } from "lucide-react";
import { useRef, type ReactNode } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { useSidebar } from "../ui/sidebar";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

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

const boundsModifiers = [restrictToParentElement];

export function ThreadSidebarWindow(props: WindowProps) {
  const boundsRef = useRef<HTMLDivElement>(null);
  const { isMobile, open } = useSidebar();
  if (isMobile) return props.children;

  const finishMove = ({ active, delta }: DragEndEvent) => {
    const start = active.rect.current.initial;
    const bounds = boundsRef.current?.getBoundingClientRect();
    if (!open || !start || !bounds || (delta.x === 0 && delta.y === 0)) return;
    props.onPositionChange({
      x: Math.round(start.left + delta.x - bounds.left),
      y: Math.round(start.top + delta.y - bounds.top),
    });
  };

  return (
    <div
      ref={boundsRef}
      className="pointer-events-none absolute bottom-3 left-[calc(env(safe-area-inset-left)+0.75rem)] top-[calc(var(--workspace-topbar-height)+0.75rem)] w-[calc(100dvw-env(safe-area-inset-left)-env(safe-area-inset-right)-1.5rem)] [container-type:size] group-data-[collapsible=offcanvas]:invisible group-data-[collapsible=offcanvas]:opacity-0 [[data-panel-animations=true]_&]:transition-[opacity,visibility] [[data-panel-animations=true]_&]:duration-(--panel-animation-duration)"
    >
      <DndContext autoScroll={false} modifiers={boundsModifiers} onDragEnd={finishMove}>
        <WindowFrame {...props} />
      </DndContext>
    </div>
  );
}

function WindowFrame({ children, position, onPositionChange }: WindowProps) {
  const { attributes, isDragging, listeners, setActivatorNodeRef, setNodeRef, transform } =
    useDraggable({ id: "Threads window" });
  const pinLabel = position ? "Pin sidebar beside chat" : "Float sidebar over chat";

  return (
    <div
      ref={setNodeRef}
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
      <div className="flex shrink-0 items-center gap-1 px-2 pt-1.5">
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
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                aria-label="Pin sidebar beside chat"
                aria-pressed={position === null}
                size="icon-sm"
                variant="ghost-muted"
                onClick={() => onPositionChange(position ? null : { x: 0, y: 0 })}
              />
            }
          >
            <PinIcon fill={position ? "none" : "currentColor"} />
          </TooltipTrigger>
          <TooltipPopup side="bottom">{pinLabel}</TooltipPopup>
        </Tooltip>
      </div>
      {children}
    </div>
  );
}
