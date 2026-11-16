import * as Schema from "effect/Schema";

import { IsoDateTime, MessageId, RunId } from "./baseSchemas.ts";

export const THREAD_CARD_LINE_MAX = 72;
export const THREAD_CARD_TOPICS_MAX = 5;
export const THREAD_CARD_TOPIC_LENGTH_MAX = 32;
export const THREAD_CARD_OPEN_MAX = 6;
export const THREAD_CARD_OPEN_TEXT_MAX = 140;

export const ThreadCardOpenKind = Schema.Literals(["ask", "verify", "commit", "ship", "followup"]);
export type ThreadCardOpenKind = typeof ThreadCardOpenKind.Type;

export const ThreadCardOpenItem = Schema.Struct({
  kind: ThreadCardOpenKind,
  text: Schema.String.check(Schema.isMaxLength(THREAD_CARD_OPEN_TEXT_MAX)),
  dueAt: Schema.optional(IsoDateTime),
});
export type ThreadCardOpenItem = typeof ThreadCardOpenItem.Type;

/** What every client lists. Small on purpose: the shell is streamed to every client. */
export const ThreadCardSummary = Schema.Struct({
  line: Schema.String.check(Schema.isMaxLength(THREAD_CARD_LINE_MAX)),
  topics: Schema.Array(Schema.String.check(Schema.isMaxLength(THREAD_CARD_TOPIC_LENGTH_MAX))).check(
    Schema.isMaxLength(THREAD_CARD_TOPICS_MAX),
  ),
  open: Schema.Array(ThreadCardOpenItem).check(Schema.isMaxLength(THREAD_CARD_OPEN_MAX)),
  messageId: MessageId,
  at: IsoDateTime,
});
export type ThreadCardSummary = typeof ThreadCardSummary.Type;

export const ThreadCard = Schema.Struct({
  ...ThreadCardSummary.fields,
  runId: RunId,
});
export type ThreadCard = typeof ThreadCard.Type;

export const threadCardSummary = (card: ThreadCard): ThreadCardSummary => ({
  line: card.line,
  topics: card.topics,
  open: card.open,
  messageId: card.messageId,
  at: card.at,
});

/** Kind plus the text lower-cased with punctuation and repeated spaces removed. */
export const threadCardOpenItemKey = (item: Pick<ThreadCardOpenItem, "kind" | "text">): string =>
  `${item.kind}:${item.text
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()}`;

export const threadCardHasOpenAsk = (
  card: { readonly open: ReadonlyArray<{ readonly kind: string }> } | null | undefined,
): boolean => card?.open.some((item) => item.kind === "ask") === true;
