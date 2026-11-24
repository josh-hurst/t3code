// @effect-diagnostics globalDate:off -- Tests exercise local calendar day boundaries.
import {
  EnvironmentId,
  MessageId,
  THREAD_SET_ASIDE_UNTIL,
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
  createOpenThreadPlacementHold,
  sortLaterThreads,
  sortNeedsYouThreads,
  sortSettlingThreads,
  sortTrailThreads,
  splitTrail,
  threadAutoSettleAt,
  threadAutoSettleLabel,
  threadNeedsYou,
  threadCardQuestionLabel,
  threadCardRowLine,
  threadAwaitingAsk,
  threadLaterLabel,
  threadLaterLead,
  threadLaterStatusLabel,
  threadRowLineText,
  threadRowProjectName,
  threadSettlingChance,
  threadStatusKind,
  threadStatusWord,
  threadWorkingLine,
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

const subagentTask = { taskId: "bg-0", kind: "subagent" } as const;

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
    [
      "waiting on a thread, the last reply's ask already answered",
      { runtime: runtime("running"), blockedOnThreadWait: true, card: card("ask") },
      "waiting",
      true,
      true,
    ],
    [
      "finished while a subagent works",
      { latestRun: run("completed", T0), pendingBackgroundTasks: [subagentTask] },
      "waiting",
      false,
      false,
    ],
    [
      "finished on an unread question while a subagent works",
      {
        latestRun: run("completed", T2),
        pendingBackgroundTasks: [subagentTask],
        card: card("ask"),
      },
      "question",
      true,
      true,
    ],
    ["unseen failure", { latestRun: run("failed", T2) }, "failed", true, true],
    ["visited failure", { latestRun: run("failed", T0) }, "failed", true, true],
    [
      "retry starting after a failure",
      { latestRun: run("failed", T0), runtime: runtime("starting") },
      "connecting",
      false,
      false,
    ],
    [
      "plan ready",
      { interactionMode: "plan", hasActionableProposedPlan: true, latestRun: run("completed", T0) },
      "plan",
      true,
      true,
    ],
    ["unseen completion", { latestRun: run("completed", T2) }, "completed", false, true],
    // A question holds the thread until its reply is read; the row keeps the Question status.
    [
      "read reply with an open ask",
      { latestRun: run("completed", T0), card: card("ask") },
      "question",
      false,
      false,
    ],
    [
      "unread reply with an open ask",
      { latestRun: run("completed", T2), card: card("ask") },
      "question",
      true,
      true,
    ],
    [
      "never visited with an open ask",
      { latestRun: run("completed", T0), card: card("ask"), lastVisitedAt: null },
      "question",
      true,
      true,
    ],
    // The report is news, so the row reads Done; the question it repeats is not.
    [
      "a later report carrying an ask already read",
      { latestRun: run("completed", T2), card: { ...card("ask"), askedAt: T0 } },
      "completed",
      false,
      true,
    ],
    [
      "a read ask while a subagent works",
      {
        latestRun: run("completed", T0),
        pendingBackgroundTasks: [subagentTask],
        card: card("ask"),
      },
      "waiting",
      false,
      false,
    ],
    [
      "a later report raising a new ask",
      { latestRun: run("completed", T2), card: { ...card("ask"), askedAt: T2 } },
      "question",
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

it("uses an older server's message preview only while it belongs to the working turn", () => {
  const active = RunId.make("active");
  const line = (overrides: Partial<OrchestrationV2ThreadShell>) =>
    threadWorkingLine(
      shell("t", {
        status: "running",
        activityRunStatus: "running",
        latestRunId: active,
        activeRunId: active,
        latestRunRequestedAt: DateTime.makeUnsafe(T1),
        latestVisibleMessage: {
          id: MessageId.make("update"),
          role: "assistant",
          text: "Checking the sidebar",
          updatedAt: DateTime.makeUnsafe(T2),
        },
        goal: { status: "active", objective: "Fix navigation" },
        ...overrides,
      }),
    );
  expect(line({})).toBe("Checking the sidebar");
  expect(line({ latestRunRequestedAt: DateTime.makeUnsafe(T3) })).toBe("Fix navigation");
  expect(line({ latestRunId: RunId.make("queued") })).toBe("Fix navigation");
  expect(line({ activityDescription: null })).toBe("Fix navigation");
});

describe("threadAwaitingAsk", () => {
  const latest = (role: "user" | "assistant", id = "message") => ({
    ...shell("t").source,
    latestVisibleMessage: {
      id: MessageId.make(id),
      role,
      text: "",
      updatedAt: DateTime.makeUnsafe(T0),
    },
  });
  it.each([
    ["the last reply's card asks", latest("assistant"), card("verify", "ask"), "ask"],
    ["the card asks nothing", latest("assistant"), card("verify"), null],
    ["you answered", latest("user", "answer"), card("ask"), null],
    ["a newer reply has no card yet", latest("assistant", "newer"), card("ask"), null],
  ] as const)("%s", (_name, source, threadCard, expected) => {
    expect(threadAwaitingAsk({ card: threadCard, source })).toBe(expected);
  });
});

describe("createOpenThreadPlacementHold", () => {
  it("lets the open thread leave Needs you once you dismiss its card's question, and return on Undo", () => {
    const hold = createOpenThreadPlacementHold();
    expect(hold("a")("a", true, null, card("ask"))).toBe(true);
    expect(hold("a")("a", false, null, card())).toBe(false);
    expect(hold("a")("a", true, null, card("ask"))).toBe(true);
  });

  it("holds the open thread when a new card arrives without a question", () => {
    const hold = createOpenThreadPlacementHold();
    expect(hold("a")("a", true, null, card("ask"))).toBe(true);
    expect(hold("a")("a", false, null, { ...card(), messageId: MessageId.make("next") })).toBe(
      true,
    );
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

describe("threadCardQuestionLabel", () => {
  it.each<[ThreadCardOpenKind[], string | null]>([
    [[], null],
    [["ask"], "Question"],
    [["ship", "ask"], "Question"],
    // A check, commit, publish or follow-up never labels a thread's row.
    [["verify", "commit", "ship", "followup"], null],
  ])("%j reads %j", (kinds, expected) => {
    expect(threadCardQuestionLabel(card(...kinds))).toBe(expected);
  });
});

describe("threadRowLineText", () => {
  it("puts the lead word before the outcome, so truncation cuts the outcome", () => {
    expect(threadRowLineText({ owed: "Question", line: "Fixed feed" })).toBe(
      "Question · Fixed feed",
    );
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
    // A thread set aside has no time to name; one held for a re-check names the re-check's.
    expect(threadLaterLabel(snoozed(THREAD_SET_ASIDE_UNTIL), { now: T0 })).toBe("Later");
    const held = snoozed(THREAD_SET_ASIDE_UNTIL, {
      followUp: { reason: "Results", dueAt: T2, armedBy: "agent", quietCount: 0 },
    });
    expect(threadLaterLabel(held, { now: T0 })).toBe("Later · in 2h");
    expect(threadLaterLabel(held, { now: T3 })).toBe("Later · due");
  });
});

describe("threadLaterLead", () => {
  const followUp = (overrides: Partial<NonNullable<EnvironmentThreadShell["followUp"]>> = {}) => ({
    reason: "A/B results",
    dueAt: T2,
    armedBy: "agent" as const,
    quietCount: 0,
    ...overrides,
  });
  const held = (overrides: Partial<EnvironmentThreadShell>) =>
    shell("held", {}, { snoozedAt: T0, snoozedUntil: THREAD_SET_ASIDE_UNTIL, ...overrides });

  it("names what a held thread waits for", () => {
    const limit = { recheckLimit: 3 };
    expect(threadLaterLead(held({ followUp: followUp() }), limit)).toEqual({
      word: "Re-check",
      text: "A/B results",
    });
    expect(threadLaterLead(held({ followUp: followUp({ quietCount: 2 }) }), limit)).toEqual({
      word: "Re-check 2 of 3",
      text: "A/B results",
    });
    expect(
      threadLaterLead(held({ followUp: followUp({ quietCount: 1 }) }), { recheckLimit: null })
        ?.word,
    ).toBe("Re-check 1");
    expect(
      threadLaterLead(held({ followUp: followUp({ reason: " ", dueAt: null }) }), limit),
    ).toEqual({ word: "Re-check", text: "After the next publish" });
    expect(threadLaterLead(held({ standingCheck: true }), limit)).toEqual({
      word: "Standing check",
      text: null,
    });
    expect(threadLaterLead(held({}), limit)).toEqual({ word: "Set aside", text: null });
    // A sent re-check is spent, and a plain snooze reads like any other row.
    expect(threadLaterLead(held({ followUp: followUp({ sentAt: T1 }) }), limit)?.word).toBe(
      "Set aside",
    );
    expect(threadLaterLead(held({ snoozedUntil: T3 }), limit)).toBeNull();
  });

  it("shows a settle plan only while the thread is where the plan left it", () => {
    const quiet = (overrides: Partial<EnvironmentThreadShell> = {}) =>
      shell(
        "planned",
        {
          latestRunId: RunId.make("run-1"),
          latestRunRequestedAt: DateTime.makeUnsafe(T0),
          latestRunCompletedAt: DateTime.makeUnsafe(T1),
          latestUserMessageAt: DateTime.makeUnsafe(T0),
        },
        { autoSettlePlan: { at: Date.parse(T3), basisAt: Date.parse(T1) }, ...overrides },
      );
    expect(threadAutoSettleAt(quiet())).toBe(Date.parse(T3));
    // A message or run after the plan's basis restarts the wait before the server says so.
    expect(threadAutoSettleAt(quiet({ latestUserMessageAt: T2 }))).toBeNull();
    const rerun = quiet().latestRun;
    expect(
      threadAutoSettleAt(quiet({ latestRun: rerun && { ...rerun, requestedAt: T2 } })),
    ).toBeNull();
    // The server stops sweeping these threads, so their last plan is never cleared.
    for (const stale of [
      { pinnedAt: T2 },
      { autoSettleDisabledAt: T2 },
      { settledOverride: "settled" as const },
      { archivedAt: T2 },
      { autoSettlePlan: null },
    ]) {
      expect(threadAutoSettleAt(quiet(stale))).toBeNull();
    }
    // Listed as settling only with a chance on a plan that still stands, the surest thread last.
    const plan = { at: Date.parse(T3), basisAt: Date.parse(T1) };
    const listed = (id: string, returnChance: number, basisAt = plan.basisAt) => ({
      ...quiet({ autoSettlePlan: { ...plan, basisAt, returnChance } }),
      id: ThreadId.make(id),
    });
    expect(threadSettlingChance(quiet())).toBeNull();
    expect(threadSettlingChance(listed("a", 0.12))).toBe(0.12);
    expect(threadSettlingChance({ ...listed("a", 0.12), latestUserMessageAt: T2 })).toBeNull();
    expect(
      sortSettlingThreads([
        listed("sure", 0.02),
        listed("older", 0.1, Date.parse(T0)),
        listed("unsure", 0.14),
        listed("newer", 0.1),
      ]).map((thread) => thread.id),
    ).toEqual(["unsure", "newer", "older", "sure"]);
    expect(threadAutoSettleLabel(Date.parse(T3), { now: T1 })).toBe("Settles in 2h");
    expect(threadAutoSettleLabel(Date.parse(T1), { now: T2 })).toBe(
      "Settles soon after your next message",
    );
  });

  it("puts the lead and the time on a held thread's status line", () => {
    const at = { now: T0, recheckLimit: 3 };
    expect(threadLaterStatusLabel(held({ snoozedUntil: T3 }), at)).toBe("Snoozed, wakes in 3h");
    expect(threadLaterStatusLabel(held({}), at)).toBe("Set aside");
    expect(
      threadLaterStatusLabel(held({ followUp: followUp({ quietCount: 1, dueAt: T0 }) }), {
        ...at,
        now: T1,
      }),
    ).toBe("Re-check 1 of 3, due");
  });
});

describe("sortLaterThreads", () => {
  it("orders by the time each thread comes back, untimed rows last by when they were held", () => {
    const timed = shell("timed", {}, { snoozedAt: T0, snoozedUntil: T3 });
    const recheck = shell(
      "recheck",
      {},
      {
        snoozedAt: T1,
        snoozedUntil: THREAD_SET_ASIDE_UNTIL,
        followUp: { reason: "", dueAt: T2, armedBy: "user", quietCount: 0 },
      },
    );
    const asideLater = shell(
      "aside-later",
      {},
      { snoozedAt: T2, snoozedUntil: THREAD_SET_ASIDE_UNTIL },
    );
    const asideEarlier = shell(
      "aside-earlier",
      {},
      { snoozedAt: T1, snoozedUntil: THREAD_SET_ASIDE_UNTIL },
    );
    expect(
      sortLaterThreads([asideLater, timed, asideEarlier, recheck]).map(({ id }) => id),
    ).toEqual(["recheck", "timed", "aside-earlier", "aside-later"]);
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
  it("orders by the last message you sent, never by opening it or agent activity", () => {
    const sent = shell("sent", {}, { latestUserAuthoredMessageAt: T2 });
    const older = shell("older", {}, { latestUserAuthoredMessageAt: T1 });
    const order = (threads: EnvironmentThreadShell[]) =>
      sortTrailThreads(threads).map(({ id }) => id);
    expect(order([older, sent])).toEqual(["sent", "older"]);

    // Opening and reading it, a finished run you have not opened, and un-settling leave it put.
    const touched = {
      ...older,
      lastVisitedAt: T3,
      opens: { openedAt: Date.parse(T3), score: 1, picks: [] },
      latestRun: run("completed", T3),
      unsettledAt: T3,
    };
    expect(order([sent, touched])).toEqual(["sent", "older"]);

    // Older servers send only latestUserMessageAt.
    const legacy = shell("legacy", {}, { latestUserMessageAt: T3 });
    expect(order([sent, legacy])).toEqual(["legacy", "sent"]);
  });
});

describe("splitTrail", () => {
  it("shows eight rows, then splits the rest at local midnight", () => {
    const now = new Date(2026, 10, 15, 10, 0).getTime();
    const touched = (id: string, at: Date) =>
      shell(
        id,
        {},
        { createdAt: "2026-01-01T00:00:00.000Z", latestUserAuthoredMessageAt: at.toISOString() },
      );
    const recent = Array.from({ length: 8 }, (_, index) =>
      touched(`recent-${index}`, new Date(2026, 10, 15, 9, 50 - index)),
    );
    const afterMidnight = touched("after-midnight", new Date(2026, 10, 15, 0, 0));
    const beforeMidnight = touched("before-midnight", new Date(2026, 10, 14, 23, 59));
    // Written to two days ago, finished just now and not yet opened: it stays in view.
    const unseenFinish = {
      ...touched("unseen-finish", new Date(2026, 10, 13, 9, 0)),
      lastVisitedAt: new Date(2026, 10, 13, 9, 0).toISOString(),
      latestRun: run("completed", new Date(2026, 10, 15, 9, 55).toISOString()),
    };
    const trail = sortTrailThreads([beforeMidnight, ...recent, unseenFinish, afterMidnight]);

    const split = splitTrail(trail, { now });
    expect(split.head.map(({ id }) => id)).toEqual([
      ...recent.map(({ id }) => id),
      "unseen-finish",
    ]);
    expect(split.moreToday.map(({ id }) => id)).toEqual(["after-midnight"]);
    expect(split.earlier.map(({ id }) => id)).toEqual(["before-midnight"]);
    expect(splitTrail(trail, { now, visibleCount: 20 }).head).toHaveLength(11);
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
