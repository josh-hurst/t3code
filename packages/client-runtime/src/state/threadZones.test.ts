// @effect-diagnostics globalDate:off -- Tests exercise local calendar day boundaries.
import {
  EnvironmentId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ThreadCardOpenKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { presentThreadShell, type EnvironmentThreadShell } from "./models.ts";
import { v2ThreadShell } from "./orchestrationV2TestFixtures.ts";
import {
  sortNeedsYouThreads,
  sortTrailThreads,
  splitTrail,
  threadNeedsYou,
  threadCardOwedLabel,
  threadCardRowLine,
  threadLaterLabel,
  threadRowLineText,
  threadRowProjectName,
  threadStatusKind,
  threadStatusWord,
  trailDayLabel,
  trailMoreLabel,
  type ThreadStatusKind,
} from "./threadZones.ts";

const environmentId = EnvironmentId.make("env");
const T0 = "2026-06-20T10:00:00.000Z";
const T1 = "2026-06-20T11:00:00.000Z";
const T2 = "2026-06-20T12:00:00.000Z";
const T3 = "2026-06-20T13:00:00.000Z";

function shell(
  id: string,
  raw: Partial<OrchestrationV2ThreadShell> = {},
  overrides: Partial<EnvironmentThreadShell> = {},
): EnvironmentThreadShell {
  return {
    ...presentThreadShell(environmentId, { ...v2ThreadShell, id: ThreadId.make(id), ...raw }),
    ...overrides,
  };
}

const runtime = (status: NonNullable<EnvironmentThreadShell["runtime"]>["status"]) => ({
  status,
  activeRunId: null,
  providerInstanceId: v2ThreadShell.providerInstanceId,
  providerName: null,
  lastError: null,
  updatedAt: T0,
});

const run = (status: "completed" | "failed", completedAt: string) => ({
  runId: RunId.make("run"),
  status,
  requestedAt: null,
  startedAt: null,
  completedAt,
  assistantMessageId: null,
});

const card = (...kinds: ThreadCardOpenKind[]) => ({
  line: "Line",
  topics: [],
  open: kinds.map((kind) => ({ kind, text: kind })),
  messageId: MessageId.make("message"),
  at: T0,
});

describe("threadNeedsYou", () => {
  // Visited at T1: a run that finished at T2 is unseen, one at T0 is seen.
  const seen = { lastVisitedAt: T1 };
  it.each<[string, Partial<EnvironmentThreadShell>, ThreadStatusKind | null, boolean, boolean]>([
    ["idle", {}, null, false, false],
    ["approval", { hasPendingApprovals: true }, "approval", true, true],
    ["subagent approval", { pendingSubagentRequest: "approval" }, "approval", true, true],
    ["question", { hasPendingUserInput: true }, "input", true, true],
    ["guest", { pendingGuestMessageCount: 1 }, "guest", true, true],
    ["working", { runtime: runtime("running") }, "working", false, false],
    ["connecting", { runtime: runtime("starting") }, "connecting", false, false],
    [
      "waiting on a thread",
      { runtime: runtime("running"), blockedOnThreadWait: true },
      "waiting",
      false,
      false,
    ],
    ["unseen failure", { latestRun: run("failed", T2) }, "failed", true, true],
    [
      "plan ready",
      { interactionMode: "plan", hasActionableProposedPlan: true, latestRun: run("completed", T0) },
      "plan",
      true,
      true,
    ],
    ["unseen completion", { latestRun: run("completed", T2) }, "completed", false, true],
    [
      "seen with an open ask",
      { latestRun: run("completed", T0), card: card("ask") },
      "question",
      true,
      true,
    ],
    [
      "unseen completion with an open ask",
      { latestRun: run("completed", T2), card: card("ask") },
      "completed",
      true,
      true,
    ],
    [
      "seen with only verify and commit",
      { latestRun: run("completed", T0), card: card("verify", "commit") },
      null,
      false,
      false,
    ],
  ])("%s", (_name, overrides, kind, withoutCompleted, withCompleted) => {
    const thread = { ...shell("t"), ...seen, ...overrides };
    expect(threadStatusKind(thread)).toBe(kind);
    expect(threadNeedsYou(thread, { includeCompleted: false })).toBe(withoutCompleted);
    expect(threadNeedsYou(thread, { includeCompleted: true })).toBe(withCompleted);
  });
});

describe("threadCardRowLine", () => {
  it("shows the open question while the thread needs you, else the outcome", () => {
    const asking = card("verify", "ask");
    expect(threadCardRowLine(asking, { needsYou: true })).toBe("ask");
    expect(threadCardRowLine(asking, { needsYou: false })).toBe("Line");
    expect(threadCardRowLine(card("verify"), { needsYou: true })).toBe("Line");
    expect(threadCardRowLine(null, { needsYou: true })).toBeNull();
  });

  it("puts what the provider asks ahead of the card while the thread needs you", () => {
    const request = { description: "Run: rm -rf build" };
    expect(threadCardRowLine(card("ask"), { needsYou: true, request })).toBe("Run: rm -rf build");
    expect(threadCardRowLine(null, { needsYou: true, request })).toBe("Run: rm -rf build");
    expect(threadCardRowLine(card("ask"), { needsYou: true, request: {} })).toBe("ask");
    expect(threadCardRowLine(card("ask"), { needsYou: false, request })).toBe("Line");
  });
});

describe("threadStatusWord", () => {
  it.each<[ThreadStatusKind, boolean, string]>([
    ["approval", false, "Approval"],
    ["input", false, "Question"],
    ["input", true, "Input"],
    ["guest", false, "Request"],
    ["failed", false, "Failed"],
    ["plan", false, "Plan ready"],
    ["completed", false, "Done"],
    ["question", false, "Question"],
    ["working", false, "Working"],
  ])("%s (secret or link request %j) reads %j", (kind, userOnlyRequest, expected) => {
    expect(threadStatusWord(kind, { userOnlyRequest })).toBe(expected);
  });
});

describe("threadCardOwedLabel", () => {
  it.each<[ThreadCardOpenKind[], string | null]>([
    [[], null],
    [["ask"], null],
    [["verify"], "Check"],
    [["ask", "ship"], "Publish"],
    [["ship", "ship", "verify"], "Publish, Check"],
    [["commit", "followup", "ship"], "Commit, Follow up"],
  ])("%j owes %j", (kinds, expected) => {
    expect(threadCardOwedLabel(card(...kinds))).toBe(expected);
  });
});

describe("threadRowLineText", () => {
  it("puts what is owed before the outcome, so truncation cuts the outcome", () => {
    expect(threadRowLineText({ owed: "Check", line: "Fixed feed" })).toBe("Check · Fixed feed");
    expect(threadRowLineText({ owed: null, line: "Fixed feed" })).toBe("Fixed feed");
    expect(threadRowLineText({ owed: null, line: null })).toBeNull();
  });
});

describe("threadRowProjectName", () => {
  it.each<[string | null, boolean, boolean, string | null]>([
    ["block-warfare", false, false, "block-warfare"],
    ["block-warfare", true, false, null],
    ["block-warfare", false, true, null],
    ["  ", false, false, null],
    [null, false, false, null],
  ])(
    "%j, one project %j, under a label %j → %j",
    (name, singleProject, underProjectLabel, expected) => {
      expect(threadRowProjectName(name, { singleProject, underProjectLabel })).toBe(expected);
    },
  );
});

describe("threadLaterLabel", () => {
  it("names the wake time while the thread is still in Later", () => {
    const snoozed = (
      snoozedUntil: string | null,
      overrides: Partial<EnvironmentThreadShell> = {},
    ) => shell("snoozed", {}, { snoozedAt: T0, snoozedUntil, ...overrides });
    expect(threadLaterLabel(snoozed(T3), { now: T0 })).toBe("Later · in 3h");
    expect(threadLaterLabel(snoozed(T0), { now: T1 })).toBeNull();
    expect(threadLaterLabel(snoozed(null), { now: T0 })).toBeNull();
    // An approval wakes it early, so it is in Needs you, not Later.
    expect(threadLaterLabel(snoozed(T3, { hasPendingApprovals: true }), { now: T0 })).toBeNull();
  });
});

describe("sortNeedsYouThreads", () => {
  it("puts the longest wait first and breaks ties by id", () => {
    const question = shell(
      "question",
      {
        pendingRuntimeRequest: {
          id: RuntimeRequestId.make("q"),
          kind: "user_input",
          createdAt: DateTime.makeUnsafe(T2),
        },
      },
      { latestRun: run("completed", T3) },
    );
    const approval = shell("approval", {
      pendingRuntimeRequest: {
        id: RuntimeRequestId.make("a"),
        kind: "command",
        createdAt: DateTime.makeUnsafe(T1),
      },
    });
    const finishedB = shell("finished-b", {}, { latestRun: run("completed", T0) });
    const finishedA = shell("finished-a", {}, { latestRun: run("completed", T0) });

    expect(
      sortNeedsYouThreads([question, finishedB, approval, finishedA]).map(({ id }) => id),
    ).toEqual(["finished-a", "finished-b", "approval", "question"]);
  });
});

describe("sortTrailThreads", () => {
  it("orders by your last touch, never by agent activity", () => {
    const visited = shell("visited", {}, { lastVisitedAt: T2 });
    const busy = shell("busy", {}, { lastVisitedAt: T1, latestRun: run("completed", T3) });
    expect(sortTrailThreads([busy, visited]).map(({ id }) => id)).toEqual(["visited", "busy"]);

    const messaged = { ...busy, latestUserAuthoredMessageAt: T3 };
    expect(sortTrailThreads([visited, messaged]).map(({ id }) => id)).toEqual(["busy", "visited"]);

    // Older servers send only latestUserMessageAt.
    const legacy = shell("legacy", {}, { latestUserMessageAt: T3 });
    expect(sortTrailThreads([visited, legacy]).map(({ id }) => id)).toEqual(["legacy", "visited"]);

    // Opening an idle thread counts, though its read watermark stays at its last update.
    const reopened = shell(
      "reopened",
      {},
      { lastVisitedAt: T0, opens: { openedAt: Date.parse(T3), score: 1, picks: [] } },
    );
    expect(sortTrailThreads([visited, reopened]).map(({ id }) => id)).toEqual([
      "reopened",
      "visited",
    ]);

    // Un-settling does not, even when it drags the read watermark along with the
    // thread's update: Undo after clearing the Trail puts rows back in order.
    const restored = shell(
      "restored",
      {},
      {
        lastVisitedAt: T3,
        unsettledAt: T3,
        opens: { openedAt: Date.parse(T1), score: 1, picks: [] },
      },
    );
    expect(sortTrailThreads([visited, restored]).map(({ id }) => id)).toEqual([
      "visited",
      "restored",
    ]);
  });
});

describe("splitTrail", () => {
  it("shows eight rows, then splits the rest at local midnight", () => {
    const now = new Date(2026, 10, 15, 10, 0).getTime();
    const touched = (id: string, at: Date) =>
      shell(id, {}, { createdAt: "2026-01-01T00:00:00.000Z", lastVisitedAt: at.toISOString() });
    const recent = Array.from({ length: 8 }, (_, index) =>
      touched(`recent-${index}`, new Date(2026, 10, 15, 9, 50 - index)),
    );
    const afterMidnight = touched("after-midnight", new Date(2026, 10, 15, 0, 0));
    const beforeMidnight = touched("before-midnight", new Date(2026, 10, 14, 23, 59));
    const trail = sortTrailThreads([beforeMidnight, ...recent, afterMidnight]);

    const split = splitTrail(trail, { now });
    expect(split.head.map(({ id }) => id)).toEqual(recent.map(({ id }) => id));
    expect(split.moreToday.map(({ id }) => id)).toEqual(["after-midnight"]);
    expect(split.earlier.map(({ id }) => id)).toEqual(["before-midnight"]);
    expect(splitTrail(trail, { now, visibleCount: 20 }).head).toHaveLength(10);
  });
});

describe("trail labels", () => {
  it("names the hidden rows", () => {
    expect(trailMoreLabel({ moreToday: 5, earlier: 0 })).toBe("5 more today");
    expect(trailMoreLabel({ moreToday: 0, earlier: 3 })).toBe("3 earlier");
    expect(trailMoreLabel({ moreToday: 5, earlier: 3 })).toBe("5 more today, 3 earlier");
  });

  it("names days relative to today", () => {
    const now = new Date(2026, 10, 15, 0, 5).getTime();
    expect(trailDayLabel(new Date(2026, 10, 15, 0, 0).getTime(), now)).toBe("Today");
    expect(trailDayLabel(new Date(2026, 10, 14, 23, 59).getTime(), now)).toBe("Yesterday");
    expect(trailDayLabel(new Date(2026, 10, 10, 12, 0).getTime(), now)).toBe("Tue 10 Nov");
  });
});
