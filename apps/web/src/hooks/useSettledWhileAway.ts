import * as SettledAway from "@t3tools/client-runtime/state/settled-while-away";
import { useEffect } from "react";
import { create } from "zustand";

import { isWindowLookedAt, subscribeWindowLooking } from "../lib/windowLooking";

const LAST_LOOKED_AT_KEY = "t3code:sidebar:last-looked-at";

function readLastLookedAt(): number | null {
  try {
    const value = Number(window.localStorage.getItem(LAST_LOOKED_AT_KEY));
    return Number.isFinite(value) && value > 0 ? value : null;
  } catch {
    return null;
  }
}

function writeLastLookedAt(atMs: number) {
  try {
    window.localStorage.setItem(LAST_LOOKED_AT_KEY, String(atMs));
  } catch {
    // Without storage the notice only covers absences while the app stays open.
  }
}

export const useSettledAway = create<SettledAway.SettledAwayState>(() =>
  SettledAway.settledAwayStart(typeof window === "undefined" ? null : readLastLookedAt()),
);

/**
 * Tracks when this window stops and starts being looked at, for the sidebar's settled notice.
 * A second mounted tracker is harmless: leaving and returning twice changes nothing.
 */
export function useSettledAwayTracking() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows window focus and visibility, which live outside React
  useEffect(() => {
    let wasLooking = false;
    const check = () => {
      const now = Date.now();
      const isLooking = isWindowLookedAt();
      if (isLooking === wasLooking) return;
      wasLooking = isLooking;
      if (isLooking) {
        useSettledAway.setState((state) => SettledAway.settledAwayReturned(state, now));
      } else {
        writeLastLookedAt(now);
        useSettledAway.setState((state) => SettledAway.settledAwayLeft(state, now));
      }
    };
    const leave = () => {
      if (wasLooking) writeLastLookedAt(Date.now());
    };
    check();
    if (!wasLooking)
      useSettledAway.setState((state) => SettledAway.settledAwayLeft(state, Date.now()));
    const unsubscribe = subscribeWindowLooking(check);
    window.addEventListener("pagehide", leave);
    return () => {
      leave();
      unsubscribe();
      window.removeEventListener("pagehide", leave);
    };
  }, []);
}

export function dismissSettledAway() {
  useSettledAway.setState(SettledAway.settledAwayDismissed);
}
