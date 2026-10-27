import type { OrchestrationV2ThreadUsage } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";

import { formatContextWindowTokens } from "~/lib/contextWindow";

export function formatUsd(amount: number): string {
  return `$${amount.toFixed(amount > 0 && amount < 0.01 ? 4 : 2)}`;
}

type UsageRow = readonly [label: string, value: string];

export function threadSpendRows(usage: OrchestrationV2ThreadUsage): ReadonlyArray<UsageRow> {
  return [
    ...(usage.costUsd === null ? [] : [["Cost", formatUsd(usage.costUsd)] as const]),
    ["Active", formatDuration(usage.activeMs)],
  ];
}

export function threadTokenRows(usage: OrchestrationV2ThreadUsage): ReadonlyArray<UsageRow> {
  const input = usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens;
  return [
    ["Input", formatContextWindowTokens(usage.inputTokens)],
    ["Output", formatContextWindowTokens(usage.outputTokens)],
    ["Cache read", formatContextWindowTokens(usage.cacheReadTokens)],
    ["Cache write", formatContextWindowTokens(usage.cacheWriteTokens)],
    ...(input > 0
      ? [["Cache hit", `${Math.round((usage.cacheReadTokens / input) * 100)}%`] as const]
      : []),
  ];
}

export function threadUsageRows(usage: OrchestrationV2ThreadUsage): ReadonlyArray<UsageRow> {
  return [...threadSpendRows(usage), ...threadTokenRows(usage)];
}
