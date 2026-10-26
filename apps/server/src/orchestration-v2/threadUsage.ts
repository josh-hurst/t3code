import type {
  ModelSelection,
  OrchestrationV2ProviderTurn,
  OrchestrationV2RunAttempt,
  OrchestrationV2Run,
  OrchestrationV2ThreadUsage,
} from "@t3tools/contracts";
import { getModelSelectionBooleanOptionValue } from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

import type { TokenPriceInput } from "../usage/UsageService.ts";

const FINISHED: ReadonlySet<OrchestrationV2ProviderTurn["status"]> = new Set([
  "completed",
  "interrupted",
  "failed",
  "cancelled",
]);

export interface ThreadUsageSummary {
  readonly usage: OrchestrationV2ThreadUsage;
  /** Tokens of turns the provider reported no cost for, by model, still to be priced. */
  readonly uncosted: ReadonlyArray<TokenPriceInput>;
}

/** Each turn runs on its run's model; the thread's current model covers turns without a run. */
export function turnModelResolver(input: {
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "modelSelection">>;
  readonly attempts: ReadonlyArray<Pick<OrchestrationV2RunAttempt, "id" | "runId">>;
  readonly fallback: ModelSelection;
}): (turn: OrchestrationV2ProviderTurn) => ModelSelection {
  const runs = new Map(input.runs.map((run) => [run.id, run.modelSelection]));
  const attempts = new Map(input.attempts.map((attempt) => [attempt.id, attempt.runId]));
  return (turn) => {
    const runId = turn.runAttemptId === null ? undefined : attempts.get(turn.runAttemptId);
    return (runId === undefined ? undefined : runs.get(runId)) ?? input.fallback;
  };
}

export function summarizeThreadUsage(
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  modelOf: (turn: OrchestrationV2ProviderTurn) => ModelSelection,
): ThreadUsageSummary {
  let counted = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadTokens = 0;
  let cacheWriteTokens = 0;
  let reportedCostUsd: number | null = null;
  let activeMs = 0;
  let partial = false;
  const uncosted = new Map<string, TokenPriceInput>();
  for (const turn of turns) {
    if (!FINISHED.has(turn.status)) continue;
    if (turn.startedAt !== null && turn.completedAt !== null) {
      activeMs += Math.max(
        0,
        DateTime.toEpochMillis(turn.completedAt) - DateTime.toEpochMillis(turn.startedAt),
      );
    }
    const usage = turn.turnTokenUsage;
    if (usage?.costUsd !== undefined) reportedCostUsd = (reportedCostUsd ?? 0) + usage.costUsd;
    if (usage === undefined || usage.usageStatus === "unavailable") {
      // A turn cancelled before it reached the provider spent nothing.
      if (turn.status !== "cancelled") partial = true;
      continue;
    }
    if (usage.usageStatus === "partial") partial = true;
    counted += 1;
    const cacheRead = usage.cachedInputTokens ?? 0;
    const cacheWrite = usage.cacheCreationTokens ?? 0;
    const uncachedInput = Math.max(0, (usage.inputTokens ?? 0) - cacheRead - cacheWrite);
    const output = usage.outputTokens ?? 0;
    cacheReadTokens += cacheRead;
    cacheWriteTokens += cacheWrite;
    inputTokens += uncachedInput;
    outputTokens += output;
    if (usage.costUsd !== undefined) continue;
    const selection = modelOf(turn);
    const speed = getModelSelectionBooleanOptionValue(selection, "fastMode") ? "fast" : "standard";
    const key = `${selection.model}\u0000${speed}`;
    const totals = uncosted.get(key)?.totals;
    uncosted.set(key, {
      model: selection.model,
      speed,
      totals: {
        uncachedInputTokens: (totals?.uncachedInputTokens ?? 0) + uncachedInput,
        cachedInputTokens: (totals?.cachedInputTokens ?? 0) + cacheRead,
        cacheCreationTokens: (totals?.cacheCreationTokens ?? 0) + cacheWrite,
        outputTokens: (totals?.outputTokens ?? 0) + output,
        reasoningTokens: (totals?.reasoningTokens ?? 0) + (usage.reasoningTokens ?? 0),
      },
    });
  }
  return {
    usage: {
      turns: counted,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      costUsd: reportedCostUsd,
      activeMs: Math.round(activeMs),
      partial,
    },
    uncosted: [...uncosted.values()],
  };
}
