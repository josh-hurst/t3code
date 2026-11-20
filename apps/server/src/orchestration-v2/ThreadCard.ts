import {
  type CommandId,
  type MessageId,
  type OrchestrationV2AppThread,
  type RunId,
  THREAD_CARD_TOPICS_MAX,
  type ThreadCard,
  type ThreadCardSummary,
  type ThreadId,
} from "@t3tools/contracts";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";

/** One effect per completed run: the id is the run's, so a repeated capture cannot add a second. */
export function threadCardGenerationEffect(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly runId: RunId;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:thread-card.generate:${input.runId}`,
    commandId: input.commandId,
    threadId: input.threadId,
    request: { type: "thread-card.generate", runId: input.runId },
  };
}

const topicKey = (topic: string) => topic.trim().toLowerCase();

/** The new card's topics first, then earlier ones while there is room. */
function mergeTopics(
  previous: ReadonlyArray<string>,
  next: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const merged: Array<string> = [];
  for (const topic of [...next, ...previous]) {
    const key = topicKey(topic);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    merged.push(topic);
    if (merged.length === THREAD_CARD_TOPICS_MAX) break;
  }
  return merged;
}

/**
 * Whether a new card means the title is out of date: nobody named the thread, no title is being
 * generated, and either the first title was a guess or the card names a subject the last one
 * did not. A first card alone never retitles, since the title it would replace is minutes old.
 */
export function cardCallsForRetitle(
  thread: Pick<
    OrchestrationV2AppThread,
    "card" | "titleEditedAt" | "titleRegeneration" | "titleNeedsRefinement"
  >,
  topics: ReadonlyArray<string>,
): boolean {
  if (thread.titleEditedAt != null || thread.titleRegeneration != null) return false;
  if (thread.titleNeedsRefinement === true) return true;
  if (thread.card == null) return false;
  const known = new Set(thread.card.topics.map(topicKey));
  return topics.some((topic) => !known.has(topicKey(topic)));
}

export function threadCardWithoutAsks(card: ThreadCard): ThreadCard {
  return { ...card, open: card.open.filter((item) => item.kind !== "ask") };
}

export function nextThreadCard(input: {
  readonly previous: ThreadCard | null;
  readonly runId: RunId;
  readonly messageId: MessageId;
  readonly line: ThreadCardSummary["line"];
  readonly topics: ThreadCardSummary["topics"];
  readonly open: ThreadCardSummary["open"];
  readonly at: string;
  /** The user has written since the reply, so its questions no longer wait on them. */
  readonly answered: boolean;
}): ThreadCard {
  const card: ThreadCard = {
    line: input.line,
    topics: mergeTopics(input.previous?.topics ?? [], input.topics),
    open: input.open,
    messageId: input.messageId,
    at: input.at,
    runId: input.runId,
  };
  return input.answered ? threadCardWithoutAsks(card) : card;
}
