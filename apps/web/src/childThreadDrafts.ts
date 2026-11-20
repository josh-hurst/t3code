import type { ThreadId } from "@t3tools/contracts";

// Kept in memory only: a child draft reloaded before its first send becomes an ordinary thread.
const parentByDraftThreadId = new Map<ThreadId, ThreadId>();

/** Each new-thread open sets this, so a reused draft opened plainly stops being a child. */
export function setChildThreadDraftParent(
  draftThreadId: ThreadId,
  parentThreadId: ThreadId | null,
) {
  if (parentThreadId === null) parentByDraftThreadId.delete(draftThreadId);
  else parentByDraftThreadId.set(draftThreadId, parentThreadId);
}

export function takeChildThreadDraftParent(draftThreadId: ThreadId): ThreadId | undefined {
  const parent = parentByDraftThreadId.get(draftThreadId);
  parentByDraftThreadId.delete(draftThreadId);
  return parent;
}
