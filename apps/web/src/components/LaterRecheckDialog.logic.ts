import {
  THREAD_FOLLOW_UP_QUESTION_MAX,
  THREAD_FOLLOW_UP_REASON_MAX,
  type ThreadCardSummary,
} from "@t3tools/contracts";

/** The row's short reason: the question's first line, cut to fit. */
export function recheckReason(question: string): string {
  const firstLine = question.trim().split("\n")[0]!.trim();
  return firstLine.length <= THREAD_FOLLOW_UP_REASON_MAX
    ? firstLine
    : `${firstLine.slice(0, THREAD_FOLLOW_UP_REASON_MAX - 1).trimEnd()}…`;
}

/**
 * What the form opens with: the re-check already armed, else the card's first follow-up item.
 * A time already past is dropped, so the form falls back to its own default. An armed re-check
 * with no time waits for the next publish, and opens on that choice.
 */
export function recheckFormDefaults(input: {
  readonly armed: { readonly question: string; readonly dueAt: string | null } | null;
  readonly card: Pick<ThreadCardSummary, "open"> | null | undefined;
  readonly nowMs: number;
}): { readonly question: string; readonly dueAt: string | null; readonly afterPublish: boolean } {
  const item = input.card?.open.find((entry) => entry.kind === "followup");
  const question = (input.armed?.question ?? item?.text ?? "").slice(
    0,
    THREAD_FOLLOW_UP_QUESTION_MAX,
  );
  const dueAt = input.armed === null ? (item?.dueAt ?? null) : input.armed.dueAt;
  return {
    question,
    dueAt: dueAt !== null && Date.parse(dueAt) > input.nowMs ? dueAt : null,
    afterPublish: input.armed !== null && input.armed.dueAt === null,
  };
}
