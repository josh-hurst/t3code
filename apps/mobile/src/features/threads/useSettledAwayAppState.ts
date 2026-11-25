import { useEffect } from "react";
import { AppState } from "react-native";

import { followAppStateForSettledAway } from "./settledWhileAway";

/** Feeds foreground and background changes to the settled notice; a second caller changes nothing. */
export function useSettledAwayAppState() {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the app's foreground state, which lives outside React
  useEffect(() => {
    followAppStateForSettledAway(AppState.currentState);
    const subscription = AppState.addEventListener("change", followAppStateForSettledAway);
    return () => subscription.remove();
  }, []);
}
