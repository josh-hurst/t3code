import { assert, describe, it } from "@effect/vitest";
import {
  type OrchestrationV2ThreadShell,
  RunId,
  type ThreadContentsState,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import { regroupDue } from "./ContentsRegroupWorker.ts";

const nowMs = Date.parse("2030-03-03T12:00:00.000Z");
const hoursAgo = (hours: number) =>
  DateTime.formatIso(DateTime.makeUnsafe(nowMs - hours * 60 * 60 * 1000));

const state = (fields: Partial<ThreadContentsState>): ThreadContentsState => ({
  revision: 3,
  nextEntrySeq: 4,
  ownerRuns: 12,
  lastRunOrdinal: 14,
  lastReplyAt: hoursAgo(1),
  runsSinceRegroup: 1,
  regroupRequestedThrough: 10,
  regroupedThrough: 10,
  regroupedAt: hoursAgo(30),
  ...fields,
});

// Only the fields the rule reads; the rest of a shell does not change the answer.
const shell = (fields: Partial<OrchestrationV2ThreadShell>) =>
  ({
    activeRunId: null,
    activityRunStatus: null,
    status: "completed",
    settledAt: null,
    settledOverride: null,
    deletedAt: null,
    ...fields,
  }) as OrchestrationV2ThreadShell;

const settled = { settledAt: DateTime.makeUnsafe(hoursAgo(1)) };

describe("regroupDue", () => {
  it.each([
    ["five runs since the last regroup", state({ runsSinceRegroup: 5 }), shell({}), true],
    ["four runs on a thread still in use", state({ runsSinceRegroup: 4 }), shell({}), false],
    ["one run on a settled thread", state({}), shell(settled), true],
    ["one run, settled by hand", state({}), shell({ settledOverride: "settled" }), true],
    [
      "one run on a settled thread regrouped an hour ago",
      state({ regroupedAt: hoursAgo(1) }),
      shell(settled),
      false,
    ],
    ["a settled thread never regrouped", state({ regroupedAt: null }), shell(settled), true],
    [
      "an active run",
      state({ runsSinceRegroup: 8 }),
      shell({ activeRunId: RunId.make("run:active") }),
      false,
    ],
    ["a queued run", state({ runsSinceRegroup: 8 }), shell({ status: "queued" }), false],
    [
      "a run starting",
      state({ runsSinceRegroup: 8 }),
      shell({ activityRunStatus: "starting" }),
      false,
    ],
    ["a missing thread", state({ runsSinceRegroup: 8 }), null, false],
  ] as const)("%s", (_name, candidate, threadShell, due) => {
    assert.strictEqual(regroupDue({ state: candidate, shell: threadShell, nowMs }), due);
  });
});
