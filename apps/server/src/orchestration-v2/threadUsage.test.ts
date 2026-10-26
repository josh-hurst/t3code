import {
  type ModelSelection,
  NodeId,
  type OrchestrationV2ProviderTurn,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";

import {
  summarizeThreadUsage as summarize,
  turnModelResolver,
  turnsFinishedSince,
} from "./threadUsage.ts";

const opus: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};
const summarizeThreadUsage = (turns: ReadonlyArray<OrchestrationV2ProviderTurn>) =>
  summarize(turns, () => opus).usage;

const turn = (
  ordinal: number,
  overrides: Partial<OrchestrationV2ProviderTurn>,
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(`turn-${ordinal}`),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  nodeId: NodeId.make("node"),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal,
  status: "completed",
  startedAt: DateTime.makeUnsafe(ordinal * 60_000),
  completedAt: DateTime.makeUnsafe(ordinal * 60_000 + 2_000),
  ...overrides,
});

describe("summarizeThreadUsage", () => {
  it("splits cache traffic out of input and adds up every finished turn", () => {
    expect(
      summarizeThreadUsage([
        turn(1, {
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: false,
            inputTokens: 1_100,
            outputTokens: 40,
            cachedInputTokens: 900,
            cacheCreationTokens: 150,
            costUsd: 0.1,
          },
        }),
        turn(2, {
          turnTokenUsage: {
            usageScope: "main_agent",
            usageStatus: "complete",
            hasSubagents: true,
            inputTokens: 2_000,
            outputTokens: 60,
            cachedInputTokens: 1_950,
            costUsd: 0.05,
          },
        }),
        // Still running: no usage yet and no time to count.
        turn(3, { status: "running", completedAt: null }),
      ]),
    ).toEqual({
      turns: 2,
      inputTokens: 50 + 50,
      outputTokens: 100,
      cacheReadTokens: 2_850,
      cacheWriteTokens: 150,
      costUsd: expect.closeTo(0.15, 9),
      activeMs: 4_000,
      partial: false,
    });
  });

  it("flags finished turns without usage, but not ones cancelled before they ran", () => {
    const summary = summarizeThreadUsage([
      turn(1, {
        status: "cancelled",
        turnTokenUsage: {
          usageScope: "main_agent",
          usageStatus: "unavailable",
          hasSubagents: false,
        },
      }),
    ]);
    expect(summary.partial).toBe(false);
    expect(summary.costUsd).toBeNull();

    expect(summarizeThreadUsage([turn(1, { status: "failed" })]).partial).toBe(true);
  });

  it("leaves turns without a reported cost to be priced on their run's model and speed", () => {
    const usage = {
      usageScope: "main_agent",
      usageStatus: "complete",
      hasSubagents: false,
      inputTokens: 1_000,
      outputTokens: 10,
      cachedInputTokens: 800,
    } as const;
    const fast: ModelSelection = { ...opus, options: [{ id: "fastMode", value: true }] };
    const modelOf = turnModelResolver({
      runs: [{ id: RunId.make("fast-run"), modelSelection: fast }],
      attempts: [{ id: RunAttemptId.make("fast-attempt"), runId: RunId.make("fast-run") }],
      fallback: opus,
    });
    const { usage: totals, uncosted } = summarize(
      [
        turn(1, { turnTokenUsage: usage }),
        turn(2, { turnTokenUsage: usage }),
        turn(3, { runAttemptId: RunAttemptId.make("fast-attempt"), turnTokenUsage: usage }),
        turn(4, { turnTokenUsage: { ...usage, costUsd: 0.2 } }),
      ],
      modelOf,
    );
    expect(totals.costUsd).toBe(0.2);
    expect(uncosted).toEqual([
      {
        model: "claude-opus-5-5",
        speed: "standard",
        totals: {
          uncachedInputTokens: 400,
          cachedInputTokens: 1_600,
          cacheCreationTokens: 0,
          outputTokens: 20,
          reasoningTokens: 0,
        },
      },
      {
        model: "claude-opus-5-5",
        speed: "fast",
        totals: {
          uncachedInputTokens: 200,
          cachedInputTokens: 800,
          cacheCreationTokens: 0,
          outputTokens: 10,
          reasoningTokens: 0,
        },
      },
    ]);
  });

  it("keeps only turns that finished inside a limit window", () => {
    // Turn n runs from n minutes for two seconds.
    const turns = [turn(1, {}), turn(2, {}), turn(3, { status: "running", completedAt: null })];
    expect(turnsFinishedSince(turns, 2 * 60_000).map((kept) => kept.ordinal)).toEqual([2]);
  });
});
