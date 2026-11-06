import { describe, expect, it } from "vite-plus/test";

import { buildReplySummaryPrompt, sanitizeReplySummary } from "./ReplySummary.ts";

describe("sanitizeReplySummary", () => {
  it.each([
    ['"Fixed flaky login test; 2 retries removed."', "Fixed flaky login test; 2 retries removed"],
    ["**Summary:** `vp test` passes after cache fix", "vp test passes after cache fix"],
    ["Merge PR 412 now?", "Merge PR 412 now?"],
    [
      "Blocked on missing STRIPE_KEY\nI could not run the webhook tests.",
      "Blocked on missing STRIPE_KEY",
    ],
    [
      "Added retry backoff to sync worker plus tests docs and a migration note for operators",
      "Added retry backoff to sync worker plus tests docs and",
    ],
    ["  ...  ", null],
  ])("%j becomes %j", (raw, expected) => {
    expect(sanitizeReplySummary(raw)).toBe(expected);
  });

  it("cuts long output at a word boundary", () => {
    const summary = sanitizeReplySummary(
      "Renamed useEnvironmentConnectionSupervisorRegistry to useSupervisorRegistry everywhere",
    );
    expect(summary).toBe("Renamed useEnvironmentConnectionSupervisorRegistry to");
    expect(summary!.length).toBeLessThanOrEqual(72);
  });
});

describe("buildReplySummaryPrompt", () => {
  it("keeps the end of a long reply, where outcomes and questions usually are", () => {
    const reply = `${"start ".repeat(1_000)}${"middle ".repeat(2_000)}Should I merge it?`;
    const prompt = buildReplySummaryPrompt(reply);
    expect(prompt).toContain("Should I merge it?");
    expect(prompt).toContain("[…]");
    expect(prompt.length).toBeLessThan(reply.length);
  });
});
