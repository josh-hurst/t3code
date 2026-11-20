import {
  THREAD_POPOUT_FRAME_PREFIX,
  THREAD_POPOUT_STANDBY_FRAME_PREFIX,
  type ScopedThreadRef,
} from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { isElectron } from "../env";
import type { AppRouter } from "../router";
import { buildThreadRouteParams } from "../threadRoutes";

const NAVIGATE_MESSAGE = "t3code:popout-navigate";

const POPOUT_FEATURES = "popup,width=640,height=820";
const STANDBY_DELAY_MS = 1500;

const popouts = new Set<Window>();
let standby: Window | null = null;
let windowCount = 0;

const threadKey = (environmentId: string, threadId: string) => `${environmentId}/${threadId}`;

/** The thread a pop-out shows now; it can switch threads after opening. */
function popoutThreadKey(view: Window): string | null {
  try {
    if (view.closed) return null;
    // Desktop uses hash history, so a window's route lives in its fragment.
    const path = isElectron
      ? (view.location.hash.replace(/^#/, "").split("?")[0] ?? "")
      : view.location.pathname;
    const match = /^(?:\/popout)?\/([^/]+)\/([^/]+)\/?$/.exec(path);
    if (match === null || match[1] === "popout" || match[1] === "draft") return null;
    return threadKey(decodeURIComponent(match[1]!), decodeURIComponent(match[2]!));
  } catch {
    return null;
  }
}

function findThreadPopout(threadRef: ScopedThreadRef): Window | null {
  const key = threadKey(threadRef.environmentId, threadRef.threadId);
  for (const view of popouts) {
    if (view.closed) popouts.delete(view);
    else if (popoutThreadKey(view) === key) return view;
  }
  return null;
}

/**
 * Desktop keeps one pop-out loaded and hidden once pop-outs are in use, so the next one shows
 * at once instead of booting a renderer. The main process shows it when its route reaches a thread.
 */
function warmStandbyPopout(router: AppRouter): void {
  if (!isElectron || (standby !== null && !standby.closed)) return;
  if (windowCount === 0) window.addEventListener("pagehide", () => standby?.close());
  windowCount += 1;
  standby = window.open(
    router.history.createHref(router.buildLocation({ to: "/popout/standby" }).href),
    `${THREAD_POPOUT_STANDBY_FRAME_PREFIX}${windowCount}`,
    POPOUT_FEATURES,
  );
}

function takeStandbyPopout(threadHref: string): Window | null {
  const view = standby;
  standby = null;
  if (view === null || view.closed) return null;
  // Same-document navigation: the pre-loaded app routes to the thread without reloading.
  view.location.hash = threadHref;
  return view;
}

/** Opens `threadRef` in its own floating window, or focuses the one already open. */
function openThreadPopout(router: AppRouter, threadRef: ScopedThreadRef): boolean {
  const existing = findThreadPopout(threadRef);
  if (existing !== null) {
    existing.focus();
    return true;
  }
  const location = router.buildLocation({
    to: "/popout/$environmentId/$threadId",
    params: buildThreadRouteParams(threadRef),
  });
  // Each window gets its own name: reusing one would navigate a pop-out that switched threads.
  const view =
    takeStandbyPopout(location.href) ??
    window.open(
      router.history.createHref(location.href),
      `${THREAD_POPOUT_FRAME_PREFIX}${++windowCount}`,
      POPOUT_FEATURES,
    );
  if (view === null) return false;
  popouts.add(view);
  // After the pop-out it just opened has had time to load.
  setTimeout(() => warmStandbyPopout(router), STANDBY_DELAY_MS);
  return true;
}

/** Whether a pop-out this window opened shows the thread and has focus. */
export function isThreadPopoutFocused(threadRef: ScopedThreadRef): boolean {
  const view = findThreadPopout(threadRef);
  try {
    return view !== null && view.document.hasFocus();
  } catch {
    return false;
  }
}

/** The thread menu's "Open in new window": a blocked pop-up says why nothing opened. */
export function popOutThread(router: AppRouter, threadRef: ScopedThreadRef): void {
  if (openThreadPopout(router, threadRef)) return;
  toastManager.add({
    type: "error",
    title: "Could not open a new window",
    description: "Allow pop-ups for this site to open threads in their own window.",
  });
}

/** Shows the pop-out's thread in the main window and closes the pop-out. */
export function returnThreadToMainWindow(router: AppRouter, threadRef: ScopedThreadRef): void {
  const location = router.buildLocation({
    to: "/$environmentId/$threadId",
    params: buildThreadRouteParams(threadRef),
  });
  if (navigateMainWindow(location.href)) {
    window.close();
    return;
  }
  // With no main window left, the pop-out's root turns this window into one.
  void router.navigate({ href: location.href });
}

/**
 * Hands an app location to the window that opened this pop-out and brings it forward.
 * Returns false when there is no opener left to take it.
 */
export function navigateMainWindow(href: string): boolean {
  const opener = window.opener as Window | null;
  if (opener === null || opener.closed) return false;
  // Custom desktop schemes report an opaque origin, so the receiver checks it instead.
  opener.postMessage({ type: NAVIGATE_MESSAGE, href }, "*");
  return true;
}

/** Lets pop-outs send their navigations (another thread, Settings) to this window. */
export function startThreadPopoutNavigationRelay(router: AppRouter): void {
  window.addEventListener("message", (event) => {
    if (event.origin !== window.location.origin) return;
    const data: unknown = event.data;
    if (
      typeof data !== "object" ||
      data === null ||
      !("type" in data) ||
      data.type !== NAVIGATE_MESSAGE ||
      !("href" in data) ||
      typeof data.href !== "string" ||
      !data.href.startsWith("/") ||
      // Pop-out routes render nothing in the main window.
      data.href.startsWith("/popout/")
    ) {
      return;
    }
    void router.navigate({ href: data.href });
    if (window.desktopBridge) void window.desktopBridge.revealWindow().catch(() => undefined);
    else window.focus();
  });
}
