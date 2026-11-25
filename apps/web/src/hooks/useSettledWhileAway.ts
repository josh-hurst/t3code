import * as SettledAway from "@t3tools/client-runtime/state/settled-while-away";
import { useEffect } from "react";
import { create } from "zustand";

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

// Focus moving into a preview frame is still looking at the app.
const looking = () =>
  document.visibilityState === "visible" &&
  (document.hasFocus() || document.activeElement instanceof HTMLIFrameElement);

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
      const isLooking = looking();
      if (isLooking === wasLooking) return;
      wasLooking = isLooking;
      if (isLooking) {
        useSettledAway.setState((state) => SettledAway.settledAwayReturned(state, now));
      } else {
        writeLastLookedAt(now);
        useSettledAway.setState((state) => SettledAway.settledAwayLeft(state, now));
      }
    };
    // A blur into a frame reports the frame as active only after the event.
    const checkSoon = () => window.setTimeout(check, 0);
    const leave = () => {
      if (wasLooking) writeLastLookedAt(Date.now());
    };
    check();
    if (!wasLooking)
      useSettledAway.setState((state) => SettledAway.settledAwayLeft(state, Date.now()));
    document.addEventListener("visibilitychange", check);
    window.addEventListener("focus", check);
    window.addEventListener("blur", checkSoon);
    window.addEventListener("pagehide", leave);
    return () => {
      leave();
      document.removeEventListener("visibilitychange", check);
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", checkSoon);
      window.removeEventListener("pagehide", leave);
    };
  }, []);
}

export function dismissSettledAway() {
  useSettledAway.setState(SettledAway.settledAwayDismissed);
}
