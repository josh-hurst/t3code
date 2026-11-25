import * as SettledAway from "@t3tools/client-runtime/state/settled-while-away";
import { useSyncExternalStore } from "react";

// In memory only: a relaunch starts with no notice, while backgrounding keeps the process.
let state = SettledAway.settledAwayStart(null);
const listeners = new Set<() => void>();

function update(next: SettledAway.SettledAwayState) {
  if (next === state) return;
  state = next;
  for (const listener of listeners) listener();
}

/** Called by `useSettledAwayAppState` whenever the app moves between foreground and background. */
export function followAppStateForSettledAway(appState: string | null | undefined) {
  update(
    appState === "active"
      ? SettledAway.settledAwayReturned(state, Date.now())
      : SettledAway.settledAwayLeft(state, Date.now()),
  );
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Stretches the app spent in the background since the owner last acted on the settled notice. */
export function useSettledAwayStretches() {
  return useSyncExternalStore(subscribe, () => state.away);
}

export function dismissSettledAway() {
  update(SettledAway.settledAwayDismissed(state));
}
