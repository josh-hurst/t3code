import type * as React from "react";

export type VerticalListNavigationKey = "ArrowDown" | "ArrowUp";

export interface ListNavigationKeyEvent {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly altKey: boolean;
  readonly shiftKey: boolean;
  readonly isComposing?: boolean;
  readonly keyCode?: number;
}

/** Maps Ctrl+N / Ctrl+P to vertical arrow navigation, ignoring other modifiers and IME composition. */
export function resolveCtrlListNavigationKey(
  event: ListNavigationKeyEvent,
): VerticalListNavigationKey | null {
  if (
    event.isComposing ||
    event.keyCode === 229 ||
    !event.ctrlKey ||
    event.metaKey ||
    event.altKey ||
    event.shiftKey
  ) {
    return null;
  }
  if (event.key === "n" || event.key === "N") return "ArrowDown";
  if (event.key === "p" || event.key === "P") return "ArrowUp";
  return null;
}

/** Maps plain ArrowDown/ArrowUp or Ctrl+N/Ctrl+P to vertical list navigation. */
export function resolveVerticalListNavigationKey(
  event: ListNavigationKeyEvent,
): VerticalListNavigationKey | null {
  if (event.isComposing || event.keyCode === 229) return null;
  if (
    !event.ctrlKey &&
    !event.metaKey &&
    !event.altKey &&
    !event.shiftKey &&
    (event.key === "ArrowDown" || event.key === "ArrowUp")
  ) {
    return event.key;
  }
  return resolveCtrlListNavigationKey(event);
}

/**
 * Re-dispatches Ctrl+N / Ctrl+P as ArrowDown / ArrowUp on the event target so
 * Base UI list primitives (Combobox, Autocomplete/Command, Menu, Select) move
 * their highlight without each caller wiring its own key handler.
 */
export function forwardCtrlListNavigationKeyDown(event: React.KeyboardEvent<HTMLElement>): boolean {
  if (event.defaultPrevented) return false;
  const arrowKey = resolveCtrlListNavigationKey({
    key: event.key,
    ctrlKey: event.ctrlKey,
    metaKey: event.metaKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    isComposing: event.nativeEvent.isComposing,
    keyCode: event.keyCode,
  });
  if (arrowKey === null) return false;
  const target = event.target;
  if (!target || typeof target !== "object" || !("ownerDocument" in target)) return false;
  const view = (target as Node).ownerDocument?.defaultView;
  if (!view || !(target instanceof view.HTMLElement)) return false;
  (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
  event.preventDefault();
  event.stopPropagation();
  target.dispatchEvent(
    new view.KeyboardEvent("keydown", {
      key: arrowKey,
      code: arrowKey,
      bubbles: true,
      cancelable: true,
    }),
  );
  return true;
}
