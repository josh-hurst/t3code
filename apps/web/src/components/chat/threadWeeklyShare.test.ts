import { describe, expect, it } from "vite-plus/test";

import { formatLimitShare, limitWindowStartMs, weeklyLimitShare } from "./threadWeeklyShare";

describe("weekly limit share", () => {
  it("starts the window its length before it resets, assuming a week when no length is given", () => {
    const resetsAt = "2026-10-31T20:00:00.000Z";
    expect(
      limitWindowStartMs({ id: "w", kind: "weekly", label: "Weekly", usedPercent: 37, resetsAt }),
    ).toBe(Date.parse("2026-10-24T20:00:00.000Z"));
    expect(
      limitWindowStartMs({
        id: "s",
        kind: "session",
        label: "Session",
        usedPercent: 31,
        resetsAt,
        windowDurationMins: 300,
      }),
    ).toBe(Date.parse("2026-10-31T15:00:00.000Z"));
    expect(
      limitWindowStartMs({ id: "o", kind: "other", label: "Other", usedPercent: 1, resetsAt }),
    ).toBeNull();
  });

  it("gives the thread its cost's part of the percentage used, never more than all of it", () => {
    expect(weeklyLimitShare({ usedPercent: 40, threadCostUsd: 5, totalCostUsd: 50 })).toBe(4);
    expect(weeklyLimitShare({ usedPercent: 40, threadCostUsd: 80, totalCostUsd: 50 })).toBe(40);
    expect(weeklyLimitShare({ usedPercent: 40, threadCostUsd: 5, totalCostUsd: 0 })).toBeNull();
    expect([0, 0.4, 3.6].map(formatLimitShare)).toEqual(["0%", "<1%", "≈4%"]);
  });
});
