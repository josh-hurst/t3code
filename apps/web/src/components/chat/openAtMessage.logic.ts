import type { MessagesTimelineRow } from "./MessagesTimeline.logic";

export type OpenAtMessageStep =
  | { readonly kind: "scroll"; readonly index: number }
  | { readonly kind: "load" }
  | { readonly kind: "wait" }
  /** Not in the thread (rolled back, or never there): stay where the thread opened. */
  | { readonly kind: "give-up" };

/**
 * What opening a thread at a message does next with the rows loaded so far: scroll to it, read
 * the history up to it once, wait for that read, or give up.
 */
export function openAtMessageStep(input: {
  readonly rows: ReadonlyArray<MessagesTimelineRow>;
  readonly messageId: string;
  readonly hasMoreHistory: boolean;
  readonly loading: boolean;
  /** History was already asked for up to this message. */
  readonly requested: boolean;
}): OpenAtMessageStep {
  const index = input.rows.findIndex(
    (row) => row.kind === "message" && row.message.id === input.messageId,
  );
  if (index >= 0) return { kind: "scroll", index };
  if (input.loading) return { kind: "wait" };
  if (input.hasMoreHistory && !input.requested) return { kind: "load" };
  return { kind: "give-up" };
}
