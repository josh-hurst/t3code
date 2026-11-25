import { minuteTick } from "@t3tools/client-runtime/clock";
import { useSyncExternalStore } from "react";

export function useNowMinute(): string {
  return useSyncExternalStore(minuteTick.subscribe, minuteTick.getSnapshot, minuteTick.getSnapshot);
}

const subscribeNever = () => () => {};
const readNull = () => null;

/** The minute tick only while `active`, so a row that does not show it never re-renders on it. */
export function useNowMinuteWhile(active: boolean): string | null {
  const getSnapshot = active ? minuteTick.getSnapshot : readNull;
  return useSyncExternalStore(
    active ? minuteTick.subscribe : subscribeNever,
    getSnapshot,
    getSnapshot,
  );
}
