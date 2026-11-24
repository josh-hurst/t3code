import { EnvironmentId, ProviderInstanceId, RunId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createInboxReturnTracker,
  sortInboxThreadsByReturn,
  sortWorkingThreadsBySend,
} from "./threadInbox.ts";

const environmentId = EnvironmentId.make("environment-1");

function thread(id: string, working: boolean) {
  return {
    id: ThreadId.make(id),
    environmentId,
    createdAt: "2026-06-01T00:00:00.000Z",
    unsettledAt: null,
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default" as const,
    runtime: working
      ? {
          status: "running" as const,
          activeRunId: null,
          providerInstanceId: ProviderInstanceId.make("codex"),
          providerName: "Codex",
          lastError: null,
          updatedAt: "2026-06-01T00:00:00.000Z",
        }
      : null,
  };
}

describe("createInboxReturnTracker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("stamps a thread immediately when it stops working, never on the first observation", () => {
    const tracker = createInboxReturnTracker();
    const first = tracker.observe([thread("a", true), thread("b", false)]);
    expect(first(thread("a", true))).toBeUndefined();
    expect(first(thread("b", false))).toBeUndefined();

    const second = tracker.observe([thread("a", false), thread("b", false)]);
    expect(second(thread("a", false))).toBe(10_000);
    expect(second(thread("b", false))).toBeUndefined();
    expect(tracker.returnedAt(thread("a", false))).toBe(10_000);
    expect(vi.getTimerCount()).toBe(0);
    // Earlier observations keep their snapshot, so lists built from them stay valid.
    expect(first(thread("a", false))).toBeUndefined();
  });

  it("orders returning threads by their observed return order", () => {
    const tracker = createInboxReturnTracker();
    const a = { ...thread("a", false), createdAt: "1970-01-01T00:00:00Z" };
    const b = { ...thread("b", false), createdAt: "1970-01-01T00:00:00Z" };
    tracker.observe([thread("a", true), thread("b", true)]);
    tracker.observe([a, thread("b", true)]);
    vi.advanceTimersByTime(500);
    const after = tracker.observe([a, b]);
    expect(after(a)).toBe(10_000);
    expect(after(b)).toBe(10_500);
    expect(sortInboxThreadsByReturn([a, b], after).map((entry) => entry.id)).toEqual(["b", "a"]);
  });

  it("clears tracked returns for removed threads and disabled shelves", () => {
    const tracker = createInboxReturnTracker();
    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    expect(tracker.returnedAt(thread("a", false))).toBe(10_000);
    tracker.observe([]);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();

    tracker.observe([thread("a", true)]);
    tracker.observe([thread("a", false)]);
    tracker.observe(null);
    expect(tracker.returnedAt(thread("a", false))).toBeUndefined();
  });
});

describe("sortWorkingThreadsBySend", () => {
  it("orders by the last message the user sent, not by later runs", () => {
    const sentFirst = {
      ...thread("sent-first", true),
      latestUserAuthoredMessageAt: "2026-06-01T01:00:00.000Z",
      latestRun: {
        runId: RunId.make("run:wake"),
        status: "running" as const,
        requestedAt: "2026-06-01T04:00:00.000Z",
        startedAt: "2026-06-01T04:00:00.000Z",
        completedAt: null,
        assistantMessageId: null,
      },
    };
    const sentLast = {
      ...thread("sent-last", true),
      latestUserAuthoredMessageAt: "2026-06-01T02:00:00.000Z",
    };
    const launched = { ...thread("launched", true), latestUserAuthoredMessageAt: null };
    expect(
      sortWorkingThreadsBySend([launched, sentFirst, sentLast]).map((thread) => thread.id),
    ).toEqual(["sent-last", "sent-first", "launched"]);
  });
});
