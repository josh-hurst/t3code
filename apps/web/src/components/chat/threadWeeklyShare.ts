import type {
  ProviderDriverKind,
  ServerProviderUsageWindow,
  UsageProviderKind,
  UsageSummary,
  UsageSummaryInput,
} from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";

const WEEK_MINUTES = 7 * 24 * 60;
const DAY_MS = 24 * 60 * 60_000;

// Providers whose limit windows and transcript history T3 can both read.
const USAGE_PROVIDER_BY_DRIVER: Partial<Record<string, UsageProviderKind>> = {
  claudeAgent: "claude",
  codex: "codex",
};

export function usageProviderForDriver(
  driver: ProviderDriverKind | null,
): UsageProviderKind | null {
  return driver === null ? null : (USAGE_PROVIDER_BY_DRIVER[driver] ?? null);
}

export function weeklyLimitWindow(
  windows: ReadonlyArray<ServerProviderUsageWindow> | undefined,
): ServerProviderUsageWindow | null {
  return windows?.find((window) => window.kind === "weekly") ?? null;
}

export function limitWindowStartMs(window: ServerProviderUsageWindow): number | null {
  if (window.resetsAt === undefined) return null;
  const minutes = window.windowDurationMins ?? (window.kind === "weekly" ? WEEK_MINUTES : null);
  return minutes === null ? null : Date.parse(window.resetsAt) - minutes * 60_000;
}

/** Whole local days from the window's start through today; the start day counts in full. */
export function usageDaysSince(startMs: number, now: Date): UsageSummaryInput {
  const today = makeWindow(1, now);
  const startDay = new Intl.DateTimeFormat("en-CA", {
    timeZone: today.timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(startMs));
  const days = Math.round(
    (Date.parse(`${today.untilDay}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / DAY_MS,
  );
  return makeWindow(Math.max(1, days + 1), now);
}

export function providerCostUsd(summary: UsageSummary, provider: UsageProviderKind): number {
  let total = 0;
  for (const bucket of summary.buckets) {
    if (bucket.provider === provider) total += bucket.costUsd;
  }
  return total;
}

/**
 * Limits report a percentage, not a budget, so the thread gets the part of that percentage its
 * cost is of everything the provider spent in the window. Never more than the window's total.
 */
export function weeklyLimitShare(input: {
  readonly usedPercent: number;
  readonly threadCostUsd: number;
  readonly totalCostUsd: number;
}): number | null {
  if (input.totalCostUsd <= 0 || input.threadCostUsd < 0) return null;
  return Math.min(
    input.usedPercent,
    (input.usedPercent * input.threadCostUsd) / input.totalCostUsd,
  );
}

export function formatLimitShare(percent: number): string {
  if (percent === 0) return "0%";
  if (percent < 1) return "<1%";
  return `≈${Math.round(percent)}%`;
}
