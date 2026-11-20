import type { EnvironmentId } from "@t3tools/contracts";
import { type RefObject, useEffect, useEffectEvent, useSyncExternalStore } from "react";
import { getFocusedAppWindow } from "../../lib/appWindow";

import type { ThreadContextDropRef } from "./threadContextDrop.logic";

export const THREAD_CONTEXT_DROP_EVENT = "t3-thread-context-drop";
const PROJECT_CONTEXT_DROP_EVENT = "t3-project-context-drop";

/** A dragged project's folder on each environment that has it. */
export type ProjectContextRoots = ReadonlyArray<{
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string;
}>;

export function useThreadContextDrop(
  targetRef: RefObject<EventTarget | null>,
  environmentId: EnvironmentId,
  targetKey: string,
  onDrop: (refs: ReadonlyArray<ThreadContextDropRef>, isActive: () => boolean) => void,
) {
  const handleDrop = useEffectEvent(onDrop);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the target element to thread-context drop events and marks old drops inactive
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    let active = true;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ReadonlyArray<ThreadContextDropRef>>).detail, () => active);
    target.addEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    return () => {
      active = false;
      target.removeEventListener(THREAD_CONTEXT_DROP_EVENT, listener);
    };
  }, [
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- A new environment or target ends the previous listener, so isActive reports false to drops still in flight for it.
    environmentId,
    targetKey,
    targetRef,
  ]);
}

export function useProjectContextDrop(
  targetRef: RefObject<EventTarget | null>,
  onDrop: (roots: ProjectContextRoots) => void,
) {
  const handleDrop = useEffectEvent(onDrop);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes the target element to project-context drop events
  useEffect(() => {
    const target = targetRef.current;
    if (!target) return;
    const listener = (event: Event) =>
      handleDrop((event as CustomEvent<ProjectContextRoots>).detail);
    target.addEventListener(PROJECT_CONTEXT_DROP_EVENT, listener);
    return () => target.removeEventListener(PROJECT_CONTEXT_DROP_EVENT, listener);
  }, [targetRef]);
}

const DROP_TARGET_ATTRIBUTE = "data-thread-context-drop";
const DROP_OVER_ATTRIBUTE = "data-thread-context-over";

export interface ThreadContextDragGhost {
  readonly ownerDocument?: Document;
  readonly x: number;
  readonly y: number;
  readonly title: string;
  readonly count: number;
  readonly kind: "thread" | "project";
}

let ghost: ThreadContextDragGhost | null = null;
const listeners = new Set<() => void>();

function setGhost(next: ThreadContextDragGhost | null) {
  if (ghost === next) return;
  ghost = next;
  for (const listener of listeners) listener();
}

export function useThreadContextDragGhost(): ThreadContextDragGhost | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => ghost,
    () => null,
  );
}

let overTarget: HTMLElement | null = null;

function findDropTarget(point: { x: number; y: number }): HTMLElement | null {
  const document = getFocusedAppWindow().document;
  return (
    document
      .elementFromPoint(point.x, point.y)
      ?.closest<HTMLElement>(`[${DROP_TARGET_ATTRIBUTE}]`) ?? null
  );
}

export function moveThreadContextDrag(
  point: { x: number; y: number },
  label: { title: string; count: number; kind?: "thread" | "project" },
) {
  const target = findDropTarget(point);
  if (target !== overTarget) {
    overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
    target?.setAttribute(DROP_OVER_ATTRIBUTE, "true");
    overTarget = target;
  }
  const view = getFocusedAppWindow();
  setGhost({
    x: point.x,
    y: point.y,
    kind: "thread",
    ...label,
    ...(view === window ? {} : { ownerDocument: view.document }),
  });
}

export function endThreadContextDrag() {
  overTarget?.removeAttribute(DROP_OVER_ATTRIBUTE);
  overTarget = null;
  setGhost(null);
}

export function dropThreadContext(
  point: { x: number; y: number },
  threads: ReadonlyArray<ThreadContextDropRef>,
): boolean {
  const target = findDropTarget(point);
  if (!target || threads.length === 0) return false;
  target.dispatchEvent(new CustomEvent(THREAD_CONTEXT_DROP_EVENT, { detail: threads }));
  return true;
}

export function dropProjectContext(
  point: { x: number; y: number },
  roots: ProjectContextRoots,
): boolean {
  const target = findDropTarget(point);
  if (!target || roots.length === 0) return false;
  target.dispatchEvent(new CustomEvent(PROJECT_CONTEXT_DROP_EVENT, { detail: roots }));
  return true;
}

export function threadContextDropTargetProps() {
  return { [DROP_TARGET_ATTRIBUTE]: "true" } as const;
}
