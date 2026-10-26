import { describe, expect, it } from "@effect/vitest";
import type { UsageAttribution, UsageRecord } from "@t3tools/provider-core/server/usage";

import { UsageDriversCollector } from "./usageDrivers.ts";

const HOUR = 60 * 60_000;

function call(input: {
  readonly at: number;
  readonly session: string;
  readonly context?: number;
  readonly attribution?: UsageAttribution;
}): UsageRecord {
  return {
    provider: "claude",
    timestampMs: input.at,
    model: "claude-opus-5-5",
    sessionId: input.session,
    totals: {
      uncachedInputTokens: 10,
      cachedInputTokens: (input.context ?? 1_000) - 10,
      cacheCreationTokens: 0,
      outputTokens: 5,
      reasoningTokens: 0,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: null,
    ...(input.attribution === undefined ? {} : { attribution: input.attribution }),
  };
}

describe("UsageDriversCollector", () => {
  it("weighs each measure by cost and ranks what calls were charged to", () => {
    const drivers = new UsageDriversCollector();
    // A 9-hour session whose subagent spends most of it, on large contexts.
    drivers.add(call({ at: 0, session: "long", context: 200_000 }), 1);
    drivers.add(
      call({ at: 9 * HOUR, session: "long", context: 160_000, attribution: { agent: "Explore" } }),
      3,
    );
    // A short session using an MCP server from a skill.
    drivers.add(
      call({
        at: 20 * HOUR,
        session: "short",
        attribution: { mcpServer: "Roblox_Studio", skill: "egg-analytics" },
      }),
      4,
    );
    // Calls that cost nothing do not count.
    drivers.add(call({ at: 20 * HOUR, session: "free" }), 0);

    expect(drivers.finish()).toEqual({
      costUsd: 8,
      largeContextShare: 0.5,
      subagentHeavyShare: 0.5,
      parallelShare: 0,
      longSessionShare: 0.5,
      sources: [
        { kind: "mcp", name: "Roblox_Studio", share: 0.5 },
        { kind: "skill", name: "egg-analytics", share: 0.5 },
        { kind: "subagent", name: "Explore", share: 0.375 },
      ],
    });
  });

  it("counts calls made while four or more sessions were active within five minutes", () => {
    const drivers = new UsageDriversCollector();
    for (const [index, session] of ["a", "b", "c", "d"].entries()) {
      drivers.add(call({ at: index * 60_000, session }), 1);
    }
    // Long after the others, so it runs alone.
    drivers.add(call({ at: 2 * HOUR, session: "a" }), 4);
    expect(drivers.finish().parallelShare).toBe(0.5);
  });
});
