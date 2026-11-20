import { isElectron } from "../env";

// A thread, or `standby`: a pop-out pre-loaded while hidden, waiting for one.
const POPOUT_PATH = /^\/popout\/(standby|[^/]+\/[^/]+)\/?$/;

export function isThreadPopoutPath(pathname: string): boolean {
  return POPOUT_PATH.test(pathname);
}

function readInitialAppPath(): string {
  // Desktop uses hash history, so its route lives in the fragment.
  if (isElectron) return window.location.hash.replace(/^#/, "").split("?")[0] ?? "";
  return window.location.pathname;
}

/** Whether this renderer was opened as a thread pop-out; fixed for the life of the page. */
export const isThreadPopoutWindow =
  typeof window !== "undefined" && isThreadPopoutPath(readInitialAppPath());
