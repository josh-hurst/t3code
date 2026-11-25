import type { ThreadVisitLooking } from "@t3tools/client-runtime/state/thread-visits";

// Focus moving into a preview frame is still looking at the app.
export const isWindowLookedAt = () =>
  document.visibilityState === "visible" &&
  (document.hasFocus() || document.activeElement instanceof HTMLIFrameElement);

/** Calls `onChange` whenever the window may have started or stopped being looked at. */
export function subscribeWindowLooking(onChange: () => void): () => void {
  // A blur into a frame reports the frame as active only after the event.
  let timer: number | undefined;
  const onBlur = () => {
    timer = window.setTimeout(onChange, 0);
  };
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  window.addEventListener("blur", onBlur);
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
    window.removeEventListener("blur", onBlur);
  };
}

export const windowLooking: ThreadVisitLooking = {
  current: isWindowLookedAt,
  subscribe: subscribeWindowLooking,
};
