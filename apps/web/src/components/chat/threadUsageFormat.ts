import type { OrchestrationV2ThreadUsage } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { formatContextWindowTokens } from "~/lib/contextWindow";

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;
}

export function threadUsageRows(
  usage: OrchestrationV2ThreadUsage,
): ReadonlyArray<[string, string]> {
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return [
    ...(usage.costUsd === null ? [] : [["Cost", formatUsd(usage.costUsd)] as [string, string]]),
    ...(input > 0
      ? [["Cache hit", `${Math.round((usage.cacheReadTokens / input) * 100)}%`] as [string, string]]
      : []),
    ["Active", formatDuration(usage.activeMs)],
    ["Input", formatContextWindowTokens(usage.inputTokens)],
    ["Output", formatContextWindowTokens(usage.outputTokens)],
    ["Cache read", formatContextWindowTokens(usage.cacheReadTokens)],
    ["Cache write", formatContextWindowTokens(usage.cacheWriteTokens)],
  ];
}
