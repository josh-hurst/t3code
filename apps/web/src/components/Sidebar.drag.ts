import { closestCenter, type CollisionDetection, type Modifier } from "@dnd-kit/core";
import { verticalListSortingStrategy, type SortingStrategy } from "@dnd-kit/sortable";
import {
  resolveSidebarDropTarget,
  sidebarListItemId,
  sidebarMarkerId,
  type SidebarListItem,
  type SidebarListMarker,
  type SidebarSection,
} from "./Sidebar.logic";

const stationary = { x: 0, y: 0, scaleX: 1, scaleY: 1 };
const hidden = { ...stationary, scaleY: 0 };
type ThreadItem = Extract<SidebarListItem, { kind: "thread" }>;
type Layout = Parameters<SortingStrategy>[0];
const isShelfHeader = (item: SidebarListItem | undefined) =>
  item?.kind === "marker" &&
  (item.marker === "working-header" ||
    item.marker === "snoozed-header" ||
    item.marker === "settled-header");
// A day or project label, or the Needs you panel's label, drawn inside a row's own node.
const ROW_LABEL_HEIGHT = 24;
const isMarker = (item: SidebarListItem | undefined, marker: SidebarListMarker) =>
  item?.kind === "marker" && item.marker === marker;

export function restrictBelowSidebarLabel(
  { transform, containerNodeRect, draggingNodeRect }: Parameters<Modifier>[0],
  offset: number,
) {
  if (!containerNodeRect || !draggingNodeRect) return transform;
  const minimumY = containerNodeRect.top + offset - draggingNodeRect.top;
  return transform.y < minimumY ? { ...transform, y: minimumY } : transform;
}

export function createSidebarCollisionDetection(
  isValidTarget: (id: string) => boolean,
  options: {
    items?: readonly SidebarListItem[];
    activationY?: number | null;
  } = {},
): CollisionDetection {
  const validity = new Map<string, boolean>();
  const sections = new Map<string, SidebarSection | null>();
  let previousPointerY = options.activationY;
  let boundarySection: "pinned" | "active" | undefined;
  return (args) => {
    let collisions = closestCenter(args);
    const pointer = args.pointerCoordinates;
    const items = options.items;
    const source = items?.find((item) => item.kind === "thread" && item.key === args.active.id);
    const boundary = args.droppableContainers
      .find((container) => container.id === sidebarMarkerId("pinned-divider"))
      ?.node.current?.querySelector(".sidebar-drag-boundary-label")
      ?.getBoundingClientRect();
    if (items && boundary && source?.kind === "thread" && pointer) {
      boundarySection ??= source.section === "pinned" ? "pinned" : "active";
      // Only pointer movement changes sections; opening the destination moves rows under stationary gestures.
      const previousY = previousPointerY ?? pointer.y;
      previousPointerY = pointer.y;
      if (pointer.x >= boundary.left && pointer.x <= boundary.right) {
        if (pointer.y < previousY && pointer.y <= boundary.bottom) boundarySection = "pinned";
        else if (pointer.y > previousY && pointer.y >= boundary.top) boundarySection = "active";
        const nextHeader = (
          ["working-header", "snoozed-header", "trail-header", "settled-header"] as const
        )
          .map((marker) =>
            args.droppableContainers.find((container) => container.id === sidebarMarkerId(marker)),
          )
          .find((container) => container !== undefined);
        const activeBottom = nextHeader?.node.current?.getBoundingClientRect().top;
        if (boundarySection === "pinned" || (activeBottom != null && pointer.y < activeBottom)) {
          const target = collisions.find((collision) => {
            const id = String(collision.id);
            if (!sections.has(id)) {
              sections.set(
                id,
                resolveSidebarDropTarget(items, String(args.active.id), id)?.section ?? null,
              );
            }
            return sections.get(id) === boundarySection;
          });
          if (target)
            collisions = [target, ...collisions.filter((collision) => collision !== target)];
        }
      }
    }
    const nearest = collisions[0];
    if (!nearest || nearest.id === args.active.id) {
      return collisions;
    }
    const id = String(nearest.id);
    const valid = validity.get(id) ?? isValidTarget(id);
    validity.set(id, valid);
    return valid ? collisions : collisions.filter((collision) => collision.id === args.active.id);
  };
}

/** A project folder in the boring sidebar: its header's sortable id and its rendered rows'. */
export type SidebarFolderBlock = {
  readonly id: string;
  readonly rowIds: readonly string[];
  // Pinned folders always come first, so a folder moves only among its own kind.
  readonly pinned?: boolean;
};

function sidebarFolderBlockSpans(
  blocks: readonly SidebarFolderBlock[],
  rectOf: (id: string) => { top: number; height: number } | null | undefined,
) {
  const spans = blocks.map((block) => {
    const header = rectOf(block.id);
    const last = block.rowIds.length > 0 ? rectOf(block.rowIds.at(-1)!) : header;
    if (!header || !last) return null;
    return {
      top: header.top,
      headerHeight: header.height,
      height: last.top + last.height - header.top,
    };
  });
  if (spans.some((span) => span === null)) return null;
  const measured = spans as Array<NonNullable<(typeof spans)[number]>>;
  const gap = measured.length > 1 ? measured[1]!.top - (measured[0]!.top + measured[0]!.height) : 0;
  return { spans: measured, gap };
}

/**
 * Rows land among their own folder's rows. A dragged folder header shrinks to its
 * own height and moves through the other folders, which travel whole; it lands
 * before the first folder whose center lies below its center. Anything else in
 * the list has no target.
 */
export function createSidebarFolderCollisionDetection(
  blocks: readonly SidebarFolderBlock[],
): CollisionDetection {
  return (args) => {
    const { active, collisionRect, droppableRects } = args;
    const activeIndex = blocks.findIndex((block) => block.id === active.id);
    if (activeIndex === -1) {
      const block = blocks.find((candidate) => candidate.rowIds.includes(String(active.id)));
      if (block === undefined) return [];
      const rows = new Set(block.rowIds);
      return closestCenter({
        ...args,
        droppableContainers: args.droppableContainers.filter((container) =>
          rows.has(String(container.id)),
        ),
      });
    }
    const layout = sidebarFolderBlockSpans(blocks, (id) => droppableRects.get(id));
    if (layout === null) return [];
    const center = collisionRect.top + collisionRect.height / 2;
    let top = layout.spans[0]!.top;
    let insertAt = 0;
    for (const [index, span] of layout.spans.entries()) {
      if (index === activeIndex) continue;
      if (center > top + span.height / 2) insertAt += 1;
      top += span.height + layout.gap;
    }
    const pinned = blocks[activeIndex]!.pinned === true;
    const first = blocks.findIndex((block) => (block.pinned === true) === pinned);
    const last = blocks.findLastIndex((block) => (block.pinned === true) === pinned);
    return [{ id: blocks[Math.min(Math.max(insertAt, first), last)]!.id }];
  };
}

/**
 * Sorts the boring sidebar's folders and the rows inside them, which share one
 * flat list. Rows move within their folder; a dragged folder's rows hide while
 * the other folders shift around its header.
 */
export function createSidebarFolderSortingStrategy(
  blocks: readonly SidebarFolderBlock[],
): SortingStrategy {
  const blockIndexById = new Map<string, number>();
  for (const [index, block] of blocks.entries()) {
    blockIndexById.set(block.id, index);
    for (const rowId of block.rowIds) blockIndexById.set(rowId, index);
  }
  const ids = blocks.flatMap((block) => [block.id, ...block.rowIds]);
  const indexById = new Map(ids.map((id, index) => [id, index]));
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] = [];

  function project({ rects, activeIndex, overIndex }: Layout) {
    const activeBlock = blockIndexById.get(ids[activeIndex] ?? "");
    const overBlock = blockIndexById.get(ids[overIndex] ?? "");
    const layout = sidebarFolderBlockSpans(blocks, (id) => rects[indexById.get(id) ?? -1]);
    if (activeBlock === undefined || overBlock === undefined || layout === null) return [];
    const order = blocks.map((_, index) => index).filter((index) => index !== activeBlock);
    order.splice(overBlock, 0, activeBlock);
    const result = ids.map(() => stationary);
    let top = layout.spans[0]!.top;
    for (const blockIndex of order) {
      const span = layout.spans[blockIndex]!;
      const block = blocks[blockIndex]!;
      const moved = blockIndex === activeBlock;
      const y = top - span.top;
      for (const id of [block.id, ...block.rowIds]) {
        result[indexById.get(id)!] = moved ? hidden : { ...stationary, y };
      }
      top += (moved ? span.headerHeight : span.height) + layout.gap;
    }
    result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (!blocks.some((block) => block.id === ids[args.activeIndex])) {
      return verticalListSortingStrategy(args);
    }
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms[args.index] ?? stationary;
  };
}

export function createSidebarSortingStrategy(input: {
  items: readonly SidebarListItem[];
  enabled?: boolean;
  settledOrder: readonly string[];
  activeOrder?: readonly string[];
  // With a Trail header: the active rows drawn above the shelves and below it once the
  // dragged row lands in the active section. Left out, the rows keep their current sides.
  activeZones?: { readonly needsYou: readonly string[]; readonly trail: readonly string[] };
  // The rows the settled shelf would draw, in drawn order.
  arrangeSettled?: (keys: readonly string[]) => readonly string[];
  settledExpanded: boolean;
  settledVisibleCount?: number;
  routeThreadKey?: string | null;
  snoozedThreadCount?: number;
  cardHeight?: number;
  slimHeight?: number;
  boundaryLabelHeight?: number;
  // Rows whose measured height includes a label drawn above them.
  rowHasLabel?: (key: string) => boolean;
}): SortingStrategy {
  if (input.enabled === false) return () => stationary;
  const { items } = input;
  const indices = new Map(items.map((item, index) => [sidebarListItemId(item), index]));
  const trailHeaderIndex = items.findIndex((item) => isMarker(item, "trail-header"));
  const hasTrail = trailHeaderIndex !== -1;
  let previous: Pick<Layout, "rects" | "activeIndex" | "overIndex"> | undefined;
  let transforms: ReturnType<SortingStrategy>[] | null = [];

  function project({ rects, activeIndex, overIndex }: Layout) {
    const active = items[activeIndex];
    const over = items[overIndex] ?? active;
    if (active?.kind !== "thread" || !over || !rects[0]) return [];
    const target = resolveSidebarDropTarget(items, active.key, sidebarListItemId(over));
    if (!target) return [];
    const groups: Record<SidebarSection, ThreadItem[]> = {
      pinned: [],
      active: [],
      working: [],
      snoozed: [],
      settled: [],
    };
    let cardHeight = input.cardHeight;
    let slimHeight = input.slimHeight;
    let headerScale: number | undefined;
    // Extra lines only make a slim row taller, so the shortest one is a plain row.
    const shortest = (current: number | undefined, height: number | undefined) =>
      !height ? current : current === undefined ? height : Math.min(current, height);
    const zones = (hasTrail ? input.activeZones : { needsYou: [], trail: [] }) ?? {
      needsYou: items.flatMap((item, index) =>
        item.kind === "thread" && item.section === "active" && index < trailHeaderIndex
          ? [item.key]
          : [],
      ),
      trail: items.flatMap((item, index) =>
        item.kind === "thread" &&
        (item.key === active.key || (item.section === "active" && index > trailHeaderIndex))
          ? [item.key]
          : [],
      ),
    };
    const trailKeys = new Set(zones.trail);
    const needsYouKeys = new Set(zones.needsYou);
    // Trail rows are slim; every other pinned, active and working row is a card.
    const isCardRow = (item: ThreadItem) =>
      item.section === "pinned" ||
      item.section === "working" ||
      (item.section === "active" && (!trailKeys.has(item.key) || needsYouKeys.has(item.key)));
    for (const [index, item] of items.entries()) {
      if (item.kind === "marker") {
        if (isShelfHeader(item)) {
          const height = rects[index]?.height;
          if (height) headerScale ??= height / 32;
        }
        continue;
      }
      if (
        item.section === "pinned" ||
        item.section === "working" ||
        (item.section === "active" && (!hasTrail || index < trailHeaderIndex))
      )
        cardHeight ??= rects[index]?.height;
      // Below a Trail no row is a plain one-line row to sample, so placeholders use the default.
      else if (!hasTrail && input.slimHeight === undefined) {
        slimHeight = shortest(slimHeight, rects[index]?.height);
      }
      if (item.key !== active.key) groups[item.section].push(item);
    }
    // Rows below a Trail differ in height by content, so only the shelf headers give the scale there.
    const scale = hasTrail
      ? (headerScale ?? 1)
      : slimHeight !== undefined
        ? slimHeight / 36
        : (headerScale ?? (cardHeight ?? 82) / 82);
    cardHeight ??= 82 * scale;
    slimHeight ??= 36 * scale;
    const labelHeight = (input.boundaryLabelHeight ?? 0) * scale;
    const startsAsCard =
      active.section === "pinned" ||
      active.section === "working" ||
      (active.section === "active" && (!hasTrail || activeIndex < trailHeaderIndex));
    const group = groups[target.section];
    const order =
      target.section === "pinned"
        ? target.pinnedOrder
        : target.section === "settled"
          ? input.settledOrder
          : (input.activeOrder ?? target.activeOrder);
    const ranks = new Map(order.map((key, index) => [key, index]));
    const rank = ranks.get(active.key) ?? Number.POSITIVE_INFINITY;
    const index = group.findIndex(
      (item) => (ranks.get(item.key) ?? Number.POSITIVE_INFINITY) > rank,
    );
    group.splice(index < 0 ? group.length : index, 0, { ...active, section: target.section });
    const settledOrder = (
      input.settledOrder.length > 0 ? input.settledOrder : groups.settled.map((item) => item.key)
    ).filter((key) => key !== active.key || target.section === "settled");
    const visible = input.settledExpanded
      ? settledOrder.slice(0, input.settledVisibleCount ?? settledOrder.length)
      : [];
    const routeKey = input.routeThreadKey;
    if (routeKey && settledOrder.includes(routeKey) && !visible.includes(routeKey)) {
      visible.push(routeKey);
    }
    groups.settled = (input.arrangeSettled?.(visible) ?? visible).map((key) => ({
      kind: "thread",
      key,
      section: "settled",
    }));
    const projected: SidebarListItem[] = [];
    const marker = (name: SidebarListMarker) => projected.push({ kind: "marker", marker: name });
    const section = (name: "active" | "settled") => {
      if (groups[name].length > 0) projected.push(...groups[name]);
      else marker(`${name}-placeholder`);
    };
    marker("pinned-header");
    projected.push(...groups.pinned);
    marker("pinned-divider");
    if (hasTrail) {
      projected.push(...groups.active.filter((item) => needsYouKeys.has(item.key)));
    } else section("active");
    if (items.some((item) => item.kind === "marker" && item.marker === "working-header")) {
      marker("working-header");
      projected.push(...groups.working);
    }
    if (
      groups.snoozed.length > 0 ||
      ((active.section !== "snoozed" || (input.snoozedThreadCount ?? 0) > 1) &&
        items.some((item) => item.kind === "marker" && item.marker === "snoozed-header"))
    ) {
      marker("snoozed-header");
      projected.push(...groups.snoozed);
    }
    if (hasTrail) {
      marker("trail-header");
      // A row past the Trail's cap lands under its expander, so it leaves the list.
      const trail = groups.active.filter(
        (item) => trailKeys.has(item.key) && !needsYouKeys.has(item.key),
      );
      if (trail.length > 0) projected.push(...trail);
      else marker("active-placeholder");
      if (items.some((item) => isMarker(item, "trail-more"))) marker("trail-more");
    }
    marker("settled-header");
    section("settled");
    const heights = projected.map((item) => {
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      const fallback =
        item.kind !== "thread" ? slimHeight : isCardRow(item) ? cardHeight : slimHeight;
      const moved = item.kind === "thread" && item.key === active.key;
      // Below a Trail every row shares one anatomy, so the dragged row keeps its own height
      // wherever it lands; so does a slim row that stays slim.
      if (moved && rect && (hasTrail || (!isCardRow(item) && !startsAsCard))) {
        return rect.height - (input.rowHasLabel?.(item.key) ? ROW_LABEL_HEIGHT * scale : 0);
      }
      return item.kind === "marker" &&
        (item.marker === "pinned-header" || item.marker === "pinned-divider")
        ? labelHeight
        : item.kind === "marker" && item.marker.endsWith("placeholder")
          ? slimHeight
          : moved
            ? fallback
            : (rect?.height ?? fallback);
    });
    // Only History is pushed to the bottom below a Trail; otherwise the first shelf is.
    const isBottomAnchor = (item: SidebarListItem | undefined) =>
      hasTrail ? isMarker(item, "settled-header") : isShelfHeader(item);
    const firstShelf = items.findIndex(isBottomAnchor);
    const shelfRect = rects[firstShelf];
    const beforeShelf = rects[firstShelf - 1];
    const lastRect = rects.at(-1);
    let shelfSpace =
      shelfRect && beforeShelf && lastRect && shelfRect.top > beforeShelf.bottom + 1
        ? Math.max(
            0,
            lastRect.bottom - rects[0].top - heights.reduce((sum, height) => sum + height + 1, -1),
          )
        : 0;
    const result = items.map(() => hidden);
    let top = rects[0].top;
    for (const [projectedIndex, item] of projected.entries()) {
      if (isBottomAnchor(item)) {
        top += shelfSpace;
        shelfSpace = 0;
      }
      const index = indices.get(sidebarListItemId(item));
      const rect = index === undefined ? undefined : rects[index];
      if (index !== undefined && rect) result[index] = { ...stationary, y: top - rect.top };
      top += heights[projectedIndex]! + 1;
    }
    result[activeIndex] = stationary;
    return result;
  }

  return (args) => {
    if (
      previous?.rects !== args.rects ||
      previous.activeIndex !== args.activeIndex ||
      previous.overIndex !== args.overIndex
    ) {
      previous = args;
      transforms = project(args);
    }
    return transforms === null
      ? verticalListSortingStrategy(args)
      : (transforms[args.index] ?? stationary);
  };
}
