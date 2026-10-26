import { useLayoutEffect, useState, type ReactNode, type RefObject } from "react";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { ScrollArea } from "../ui/scroll-area";
import { cn } from "../../lib/utils";
import { Popover, PopoverPopup, PopoverCreateHandle } from "../ui/popover";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import type { ThreadPanelPresentation } from "../../rightPanelLayout";
import { useChatCanvas } from "./ChatCanvasContext";
import {
  THREAD_DETAILS_CARD_GAP,
  resolveThreadDetailsCardDensity,
  resolveThreadDetailsCardLayout,
} from "./threadDetailsCardLayout";
import { observeResize } from "../../lib/observeResize";

const FOOTER_GAP = 8;

export function ThreadDetailsCard({
  threadRef,
  anchor,
  handle,
  onPresentationChange,
  children,
  footer,
}: {
  threadRef: ScopedThreadRef;
  anchor: RefObject<Element | null>;
  handle: ReturnType<typeof PopoverCreateHandle>;
  onPresentationChange: (presentation: ThreadPanelPresentation) => void;
  children: (density: "full" | "compact" | "essential") => ReactNode;
  /** A separate bubble under the card that moves with it. */
  footer?: ReactNode;
}) {
  const canvas = useChatCanvas();
  const preferredPlacement = canvas
    ? resolveThreadDetailsCardLayout({
        container: canvas.container,
        lane: canvas.lane,
        frame: null,
        topInset: canvas.detailsCardTopInset,
      })
    : null;
  const placement = canvas
    ? resolveThreadDetailsCardLayout({
        container: canvas.container,
        lane: canvas.lane,
        frame: canvas.layout.frame,
        overlapsDetailsCard: canvas.layout.overlapsDetailsCard,
        topInset: canvas.detailsCardTopInset,
      })
    : null;
  const mode = placement ? "inline" : "popover";
  const topInset = canvas?.detailsCardTopInset ?? 0;
  const inlineOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const popoverOpen = useRightPanelStore((state) =>
    selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const [contentElement, setContentElement] = useState<HTMLDivElement | null>(null);
  const measurementKey = `${threadRef.environmentId}:${threadRef.threadId}:${preferredPlacement?.width ?? "popup"}`;
  const [measurements, setMeasurements] = useState({
    key: measurementKey,
    heights: { full: 0, compact: 0 },
    fullContentHeight: 0,
  });
  const contentHeights =
    measurements.key === measurementKey ? measurements.heights : { full: 0, compact: 0 };
  const [footerElement, setFooterElement] = useState<HTMLDivElement | null>(null);
  const [footerHeight, setFooterHeight] = useState(0);
  useLayoutEffect(() => {
    if (!footerElement) return;
    const measure = () => setFooterHeight(footerElement.offsetHeight);
    measure();
    return observeResize(footerElement, measure);
  }, [footerElement]);
  // The bubble takes its height plus a gap from what the card can use.
  const footerSpace = footer && footerElement ? footerHeight + FOOTER_GAP : 0;
  const height = placement?.height ?? Math.max(0, (canvas?.container.height ?? 0) - 52);
  const density = resolveThreadDetailsCardDensity(height - footerSpace, contentHeights);
  const reportDetailsCard = canvas?.reportDetailsCard;
  const cardLeft = preferredPlacement?.x;
  const cardRight = preferredPlacement
    ? preferredPlacement.x + preferredPlacement.width
    : undefined;
  const cardBottom =
    preferredPlacement && measurements.key === measurementKey && measurements.fullContentHeight > 0
      ? preferredPlacement.y +
        Math.min(measurements.fullContentHeight + footerSpace, preferredPlacement.height)
      : undefined;
  useLayoutEffect(() => {
    reportDetailsCard?.(
      inlineOpen && cardLeft !== undefined && cardRight !== undefined && cardBottom !== undefined
        ? { left: cardLeft, right: cardRight, bottom: cardBottom }
        : null,
    );
  }, [reportDetailsCard, inlineOpen, cardLeft, cardRight, cardBottom]);
  useLayoutEffect(() => () => reportDetailsCard?.(null), [reportDetailsCard]);
  useLayoutEffect(() => {
    onPresentationChange(mode);
    if (mode === "inline" && popoverOpen)
      useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", false);
  }, [mode, onPresentationChange, threadRef, popoverOpen]);
  useLayoutEffect(() => {
    const element = contentElement;
    if (!element || density === "essential") return;
    const measure = () => {
      const frame = element.closest<HTMLElement>("[data-thread-details-card]");
      const next = element.offsetHeight + (frame ? frame.offsetHeight - frame.clientHeight : 0);
      // PR lists and lineage scroll as they expand. Counting them toward density would hide
      // the section and workspace controls when the user asks to see more rows.
      const lists = element.querySelectorAll<HTMLElement>(
        "[data-thread-relationships-panel], [data-thread-details-pr-list]",
      );
      const fittingHeight =
        next - Array.from(lists).reduce((sum, list) => sum + list.offsetHeight, 0);
      setMeasurements((current) => {
        const heights = current.key === measurementKey ? current.heights : { full: 0, compact: 0 };
        const fullContentHeight =
          density === "full"
            ? next
            : current.key === measurementKey
              ? current.fullContentHeight
              : 0;
        return current.key === measurementKey &&
          heights[density] === fittingHeight &&
          current.fullContentHeight === fullContentHeight
          ? current
          : {
              key: measurementKey,
              heights: { ...heights, [density]: fittingHeight },
              fullContentHeight,
            };
      });
    };
    measure();
    return observeResize(element, measure);
  }, [contentElement, density, measurementKey]);
  const mainCard = (
    <div
      className={cn(
        "dropdown-glass isolate contain-paint grid max-h-full min-h-0 grid-rows-[minmax(0,1fr)] overflow-hidden rounded-2xl",
        mode === "popover" &&
          "max-h-[min(calc(100dvh-6.5rem),calc(var(--available-height,100dvh)-1rem))]",
      )}
      style={placement ? { maxHeight: height } : undefined}
      data-thread-details-card
    >
      <ScrollArea scrollFade className="min-h-0">
        <div ref={setContentElement}>{children(density)}</div>
      </ScrollArea>
    </div>
  );
  const card = footer ? (
    <div
      className="flex max-h-full min-h-0 flex-col"
      style={{ gap: FOOTER_GAP, ...(placement ? { maxHeight: height } : {}) }}
    >
      {mainCard}
      <div
        ref={setFooterElement}
        className="dropdown-glass isolate contain-paint shrink-0 overflow-hidden rounded-3xl"
      >
        {footer}
      </div>
    </div>
  ) : (
    mainCard
  );
  return (
    <Popover
      handle={handle}
      open={mode === "popover" && popoverOpen}
      onOpenChange={(open, details) => {
        const target =
          details.reason === "focus-out"
            ? (details.event as FocusEvent).relatedTarget
            : details.reason === "outside-press"
              ? details.event.target
              : null;
        if (!open && target instanceof Element && target.closest("[data-thread-find-bar]")) {
          details.cancel();
          return;
        }
        useRightPanelStore.getState().setThreadPanelOpen(threadRef, "popover", open);
      }}
    >
      {placement ? (
        inlineOpen ? (
          <aside
            aria-label="Thread details"
            // Skip the return transition to avoid overlapping the rising preview.
            className={cn(
              "absolute z-20",
              topInset > 0 &&
                "transition-[top] duration-150 ease-out motion-reduce:transition-none",
            )}
            style={{
              right: placement.right,
              top: placement.y,
              width: placement.width,
              maxHeight: height,
            }}
            data-density={density}
            data-thread-details-panel="inline"
          >
            {card}
          </aside>
        ) : null
      ) : (
        <PopoverPopup
          anchor={anchor}
          align="end"
          // Account for the find panel's 8px card padding.
          alignOffset={THREAD_DETAILS_CARD_GAP - 8}
          collisionAvoidance={{ side: "shift", align: "shift", fallbackAxisSide: "none" }}
          side="bottom"
          sideOffset={topInset}
          variant="panel"
          padding="none"
        >
          <div data-density={density} data-thread-details-panel="popover">
            {card}
          </div>
        </PopoverPopup>
      )}
    </Popover>
  );
}
