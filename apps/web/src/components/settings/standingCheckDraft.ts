import type { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { create } from "zustand";

/** A scheduled task the thread view asked the editor to open with, before it is saved. */
export interface StandingCheckDraft {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly prompt: string;
  /** Shown in the editor, such as that thread summaries are off. */
  readonly notice: string | null;
}

const useDraftStore = create<{ draft: StandingCheckDraft | null }>(() => ({ draft: null }));

export function usePendingStandingCheckDraft() {
  return useDraftStore((state) => state.draft);
}

/** The editor opens with this on its next render; null once it has. */
export function setPendingStandingCheckDraft(draft: StandingCheckDraft | null) {
  useDraftStore.setState({ draft });
}

export const STANDING_CHECK_PROMPT_SUFFIX =
  "Compare with your previous numbers in this thread. If something is wrong or needs a decision, end with a direct question.";
