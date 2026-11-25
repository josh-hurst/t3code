import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  presentThreadShell,
  type EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/models";
import {
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  RuntimeRequestId,
  THREAD_SET_ASIDE_UNTIL,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ThreadCardOpenKind,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  arrangeTideActive,
  arrangeTideHistory,
  needsYouElsewhere,
  nextNeedsYouKey,
  resolveTideRowLead,
  tideRenderedOrder,
  trailThreadsToClear,
} from "./tideSidebar.logic";

const environmentId = EnvironmentId.make("env");
const at = (iso: string) => DateTime.makeUnsafe(iso);
// Local noon, so the day labels hold in any time zone.
const NOW = new Date(2026, 5, 20, 12).getTime();
const hoursAgo = (hours: number) => new Date(NOW - hours * 3_600_000).toISOString();

const base: OrchestrationV2ThreadShell = {
  id: ThreadId.make("thread"),
  projectId: ProjectId.make("alpha"),
  title: "Thread",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  activeProviderThreadId: null,
  lineage: {
    rootThreadId: ThreadId.make("thread"),
    parentThreadId: null,
    relationshipToParent: null,
  },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "web",
  latestRunId: null,
  activeRunId: null,
  status: "idle",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: at(hoursAgo(24 * 30)),
  updatedAt: at(hoursAgo(24 * 30)),
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
};

function thread(
  id: string,
  touchedHoursAgo: number,
  raw: Partial<OrchestrationV2ThreadShell> = {},
): EnvironmentThreadShell {
  return presentThreadShell(environmentId, {
    ...base,
    id: ThreadId.make(id),
    lineage: { ...base.lineage, rootThreadId: ThreadId.make(id) },
    lastVisitedAt: at(hoursAgo(touchedHoursAgo)),
    latestUserMessageAt: at(hoursAgo(touchedHoursAgo)),
    ...raw,
  });
}

const keyOf = (id: string) => scopedThreadKey(scopeThreadRef(environmentId, ThreadId.make(id)));
const ids = (threads: readonly EnvironmentThreadShell[]) => threads.map((entry) => entry.id);
const failed = (id: string, hours: number) =>
  thread(id, hours + 1, {
    status: "failed",
    latestRunId: RunId.make(`run:${id}`),
    latestRunCompletedAt: at(hoursAgo(hours)),
  });

describe("arrangeTideActive", () => {
  // t0 is the latest touch; t0..t9 are today, t10 yesterday, t11 two days back.
  const trail = [
    ...Array.from({ length: 10 }, (_, index) => thread(`t${index}`, index * 0.5)),
    thread("t10", 24, { projectId: ProjectId.make("beta") }),
    thread("t11", 48),
  ];
  const needy = [failed("waited-1h", 1), failed("waited-5h", 5)];
  const arrange = (
    options: Partial<Parameters<typeof arrangeTideActive>[0]> = {},
  ): ReturnType<typeof arrangeTideActive> =>
    arrangeTideActive({
      active: [...trail.toReversed(), ...needy],
      isNeedsYou: (entry) => needy.includes(entry),
      nowMs: NOW,
      trailExpanded: false,
      routeKey: null,
      projectOf: null,
      ...options,
    });

  it("lists Needs you by longest wait and caps the Trail at eight rows by last touch", () => {
    const arranged = arrange();
    expect(ids(arranged.needsYou)).toEqual(["waited-5h", "waited-1h"]);
    expect(arranged.timeAtByKey.get(keyOf("waited-5h"))).toBe(Date.parse(hoursAgo(5)));
    expect(arranged.timeAtByKey.get(keyOf("t3"))).toBe(Date.parse(hoursAgo(1.5)));
    expect(ids(arranged.trail)).toHaveLength(12);
    expect(ids(arranged.visibleTrail)).toEqual(["t0", "t1", "t2", "t3", "t4", "t5", "t6", "t7"]);
    expect(arranged.counts).toEqual({ moreToday: 2, earlier: 2 });
    expect(arranged.groupLabelByKey.size).toBe(0);
  });

  it("keeps the open thread listed when the cap would hide it, outside the expander's count", () => {
    const pastCap = arrange({ routeKey: keyOf("t10") });
    expect(ids(pastCap.visibleTrail).at(-1)).toBe("t10");
    expect(pastCap.counts).toEqual({ moreToday: 2, earlier: 1 });
    expect(ids(arrange({ routeKey: keyOf("t2") }).visibleTrail)).toHaveLength(8);
  });

  it("expands to the rest of today, then earlier days under labels", () => {
    const arranged = arrange({ trailExpanded: true });
    expect(ids(arranged.visibleTrail).slice(8)).toEqual(["t8", "t9", "t10", "t11"]);
    expect([...arranged.groupLabelByKey]).toEqual([
      [keyOf("t10"), "Yesterday"],
      [keyOf("t11"), expect.stringMatching(/^\w{3} \d+ \w{3}$/)],
    ]);
  });

  it("groups the expanded rows by project, leaving the first eight alone", () => {
    const arranged = arrange({
      trailExpanded: true,
      projectOf: (entry) =>
        entry.projectId === "beta" ? { rank: 0, label: "Beta" } : { rank: 1, label: "Alpha" },
    });
    expect(ids(arranged.visibleTrail).slice(0, 8)).toEqual(ids(trail).slice(0, 8));
    expect(ids(arranged.visibleTrail).slice(8)).toEqual(["t10", "t8", "t9", "t11"]);
    expect([...arranged.groupLabelByKey]).toEqual([
      [keyOf("t10"), "Beta"],
      [keyOf("t8"), "Alpha"],
    ]);
    expect(arranged.groupDividerKey).toBe(keyOf("t10"));
    expect(arrange({ trailExpanded: true }).groupDividerKey).toBeNull();
    // Only the regrouped rows sit under a project label.
    expect([...arranged.projectLabelledKeys]).toEqual(
      ["t10", "t8", "t9", "t11"].map((id) => keyOf(id)),
    );
    expect(arrange({ trailExpanded: true }).projectLabelledKeys.size).toBe(0);
  });
});

it("keeps a Trail row in place when it is opened, and moves it when you send to it", () => {
  const rows = (open: EnvironmentThreadShell, others: readonly EnvironmentThreadShell[]) => {
    const arranged = arrangeTideActive({
      active: [open, ...others],
      isNeedsYou: () => false,
      nowMs: NOW,
      trailExpanded: false,
      routeKey: keyOf(open.id),
      projectOf: null,
    });
    return { ids: ids(arranged.trail), timeAt: arranged.timeAtByKey.get(keyOf(open.id)) };
  };
  const others = [thread("a", 1), thread("c", 3)];
  expect(rows(thread("b", 2), others).ids).toEqual(["a", "b", "c"]);
  // Reading it and the server's open stamp leave it put, and its time stays the one it sorts by.
  const read = thread("b", 2, {
    lastVisitedAt: at(hoursAgo(0)),
    opens: { openedAt: NOW, score: 1, picks: [] },
  });
  expect(rows(read, others)).toEqual({ ids: ["a", "b", "c"], timeAt: Date.parse(hoursAgo(2)) });
  // Sending it a message moves it.
  const sent = thread("b", 2, { latestUserMessageAt: at(hoursAgo(0)) });
  expect(rows(sent, others).ids).toEqual(["b", "a", "c"]);
});

it("labels History by the day each thread was settled", () => {
  const settled = [
    thread("s-today", 100, { settledOverride: "settled", settledAt: at(hoursAgo(1)) }),
    thread("s-today-2", 100, { settledOverride: "settled", settledAt: at(hoursAgo(2)) }),
    thread("s-yesterday", 100, { settledOverride: "settled", settledAt: at(hoursAgo(24)) }),
  ];
  const history = arrangeTideHistory(settled, { nowMs: NOW, projectOf: null });
  expect(history.threads).toBe(settled);
  expect([...history.groupLabelByKey]).toEqual([
    [keyOf("s-today"), "Today"],
    [keyOf("s-yesterday"), "Yesterday"],
  ]);
});

it("draws Pinned, Needs you, Trail, Working, Later, then History", () => {
  expect(
    tideRenderedOrder({
      history: ["h"],
      trail: ["t"],
      later: ["l"],
      working: ["w"],
      needsYou: ["n"],
      pinned: ["p"],
    }),
  ).toEqual(["p", "n", "t", "w", "l", "h"]);
});

describe("nextNeedsYouKey", () => {
  it.each([
    { name: "after the open thread", currentKey: "a", expected: "b" },
    { name: "wrapping", currentKey: "c", expected: "a" },
    { name: "from a thread outside the list", currentKey: "z", expected: "a" },
    { name: "with nothing open", currentKey: null, expected: "a" },
  ])("goes to the next thread $name", ({ currentKey, expected }) => {
    expect(nextNeedsYouKey({ keys: ["a", "b", "c"], elsewhereKeys: ["x"], currentKey })).toBe(
      expected,
    );
  });

  it("leaves the scope only when nothing else in it needs you", () => {
    expect(nextNeedsYouKey({ keys: [], elsewhereKeys: ["x"], currentKey: "z" })).toBe("x");
    expect(nextNeedsYouKey({ keys: ["a"], elsewhereKeys: ["x"], currentKey: "a" })).toBe("x");
    expect(nextNeedsYouKey({ keys: ["a"], elsewhereKeys: [], currentKey: "a" })).toBeNull();
    expect(nextNeedsYouKey({ keys: [], elsewhereKeys: [], currentKey: null })).toBeNull();
  });
});

it("counts what needs you outside the scope, leaving hidden projects out", () => {
  const inProject = (id: string, project: string, hours: number) => ({
    ...failed(id, hours),
    projectId: ProjectId.make(project),
  });
  const elsewhere = needsYouElsewhere({
    threads: [
      inProject("in-scope", "alpha", 1),
      inProject("elsewhere-1h", "beta", 1),
      inProject("elsewhere-5h", "beta", 5),
      inProject("hidden", "gamma", 1),
      { ...thread("elsewhere-idle", 1), projectId: ProjectId.make("beta") },
      { ...inProject("elsewhere-settled", "beta", 1), settledOverride: "settled" as const },
    ],
    scopedProjectKeys: new Set(["env:alpha"]),
    unscopedProjectKeys: new Set(["env:alpha", "env:beta"]),
    delegatedUnderParent: new Set(),
    settlementKnown: () => true,
    now: new Date(NOW).toISOString(),
  });
  expect(ids(elsewhere)).toEqual(["elsewhere-5h", "elsewhere-1h"]);
});

it("clears every Trail thread except the open one", () => {
  const trail = [thread("a", 1), thread("b", 2), thread("c", 3)];
  expect(ids(trailThreadsToClear(trail, keyOf("b")))).toEqual(["a", "c"]);
  expect(ids(trailThreadsToClear(trail, null))).toEqual(["a", "b", "c"]);
});

describe("resolveTideRowLead", () => {
  const card = (...kinds: ThreadCardOpenKind[]) => ({
    line: "Outcome",
    topics: [],
    open: kinds.map((kind) => ({ kind, text: `${kind} text` })),
    messageId: MessageId.make("message:card"),
    at: hoursAgo(3),
  });
  const finished = (raw: Partial<OrchestrationV2ThreadShell> = {}) =>
    thread("t", 2, {
      latestRunId: RunId.make("run:t"),
      latestRunCompletedAt: at(hoursAgo(1)),
      ...raw,
    });
  const approving = thread("t", 2, {
    card: card("verify"),
    pendingRuntimeRequest: {
      id: RuntimeRequestId.make("request"),
      kind: "command",
      createdAt: at(hoursAgo(1)),
      description: "Run: npm publish",
    },
    activityDescription: "Preparing the release",
  });
  const limited = (() => {
    const shell = finished({ status: "failed", card: card() });
    return { ...shell, runtime: { ...shell.runtime!, lastErrorClass: "usage_limit" as const } };
  })();

  it.each([
    [
      "a working thread on its current step",
      thread("t", 2, {
        latestRunId: RunId.make("run:t"),
        status: "running",
        card: card("ship"),
        activityDescription: "Checking the **sidebar**\n navigation",
      }),
      true,
      false,
      { kind: "status", tone: "working", word: "Working" },
      "Checking the sidebar navigation",
    ],
    [
      "a plan in Needs you",
      finished({ interactionMode: "plan", hasActionableProposedPlan: true, card: card() }),
      true,
      false,
      { kind: "status", tone: "plan", word: "Plan ready" },
      "Outcome",
    ],
    [
      "a pinned approval, with what it asks",
      approving,
      true,
      false,
      { kind: "status", tone: "approval", word: "Approval" },
      "Run: npm publish",
    ],
    [
      "the same approval in Later, whose open check leads nothing",
      approving,
      false,
      false,
      null,
      "Outcome",
    ],
    [
      "a read question outside Needs you",
      thread("t", 2, { card: { ...card("ask", "commit"), askedAt: hoursAgo(3) } }),
      false,
      false,
      { kind: "status", tone: "question", word: "Question" },
      "Outcome",
    ],
    [
      "an unseen finish in History, whose publish is counted on the project",
      finished({ card: card("ship") }),
      false,
      false,
      null,
      "Outcome",
    ],
    [
      "an unseen finish in the Trail, whose question was read before the run ended",
      finished({
        card: { ...card("ask", "ship"), askedAt: hoursAgo(3) },
        lastVisitedAt: at(hoursAgo(2)),
      }),
      true,
      false,
      { kind: "status", tone: "completed", word: "Done" },
      "Question · Outcome",
    ],
    [
      "a usage limit",
      limited,
      true,
      false,
      { kind: "status", tone: "limited", word: "Limited" },
      "Outcome",
    ],
    [
      "a woken snooze in the Trail",
      thread("t", 2, { card: card("verify") }),
      false,
      true,
      { kind: "status", tone: "woke", word: "Woke" },
      "Outcome",
    ],
    ["a quiet Trail row", thread("t", 2), false, false, null, null],
  ] as const)("leads %s", (_name, shell, showsStatus, isWoke, lead, text) => {
    expect(resolveTideRowLead(shell, { showsStatus, isWoke })).toMatchObject({ lead, text });
  });

  const held = (raw: Partial<OrchestrationV2ThreadShell>) =>
    thread("t", 2, {
      card: card("verify"),
      snoozedAt: at(hoursAgo(1)),
      snoozedUntil: at(THREAD_SET_ASIDE_UNTIL),
      ...raw,
    });
  it.each([
    [
      "a re-check that has re-armed, with its reason",
      held({
        followUp: { reason: "A/B results", dueAt: hoursAgo(-20), armedBy: "agent", quietCount: 2 },
      }),
      { kind: "owed", word: "Re-check 2 of 3" },
      "A/B results",
    ],
    [
      "a thread set aside, with its outcome",
      held({}),
      { kind: "owed", word: "Set aside" },
      "Outcome",
    ],
    ["a plain snooze, by its outcome", held({ snoozedUntil: at(hoursAgo(-2)) }), null, "Outcome"],
  ] as const)("leads a Later row: %s", (_name, shell, lead, text) => {
    expect(
      resolveTideRowLead(shell, {
        showsStatus: false,
        isWoke: false,
        later: { recheckLimit: 3 },
      }),
    ).toMatchObject({ lead, text });
  });
});
