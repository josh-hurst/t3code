import { assert, describe, it } from "@effect/vitest";
import { CommandId, RunId, ThreadId, type ThreadFollowUp } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";

import {
  followUpAfterOwnerMessage,
  followUpPrompt,
  followUpPromptQuestion,
  nextFollowUp,
} from "./ThreadFollowUp.ts";

const nowMs = Date.parse("2026-11-16T12:00:00.000Z");
const minutes = (count: number) => DateTime.formatIso(DateTime.makeUnsafe(nowMs + count * 60_000));
const followUpRun = RunId.make("run:follow-up");

const armed: ThreadFollowUp = {
  question: "Is the test done?",
  reason: "Nightly test",
  dueAt: minutes(60),
  armedAt: minutes(-60),
  armedBy: "agent",
  quietCount: 1,
};
const sent: ThreadFollowUp = { ...armed, sentAt: minutes(-1), runId: followUpRun };

const set = (input: {
  readonly armedBy?: "agent" | "user";
  readonly dueAt?: string;
  readonly afterPublishMinutes?: number;
  readonly limit?: number | undefined;
}) => ({
  type: "thread.follow-up.set" as const,
  commandId: CommandId.make("set"),
  threadId: ThreadId.make("thread"),
  question: "Is the test done?",
  reason: "Nightly test",
  armedBy: input.armedBy ?? "agent",
  ...(input.dueAt === undefined && input.afterPublishMinutes === undefined
    ? { dueAt: minutes(15) }
    : {}),
  ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
  ...(input.afterPublishMinutes === undefined
    ? {}
    : { afterPublishMinutes: input.afterPublishMinutes }),
  ...("limit" in input ? { limit: input.limit } : { limit: 3 }),
});

describe("nextFollowUp", () => {
  it.each([
    {
      name: "an agent in a run the user started counts from 0 and leaves filing to the visit",
      previous: null,
      activeRunId: RunId.make("run:user"),
      command: set({}),
      quietCount: 0,
      files: false,
    },
    {
      name: "an agent inside its own re-check counts one more and files at once",
      previous: sent,
      activeRunId: followUpRun,
      command: set({}),
      quietCount: 2,
      files: true,
    },
    {
      name: "a later wake run after a re-check keeps counting, so the cap cannot reset",
      previous: sent,
      activeRunId: RunId.make("run:wake"),
      command: set({}),
      quietCount: 2,
      files: false,
    },
    {
      name: "arming twice in one run keeps the count",
      previous: armed,
      activeRunId: followUpRun,
      command: set({}),
      quietCount: 1,
      files: false,
    },
    {
      name: "the owner always counts from 0 and files at once",
      previous: sent,
      activeRunId: followUpRun,
      command: set({ armedBy: "user", limit: undefined }),
      quietCount: 0,
      files: true,
    },
    {
      name: "an after-publish wait has no time yet",
      previous: null,
      activeRunId: null,
      command: set({ afterPublishMinutes: 60 }),
      quietCount: 0,
      files: false,
    },
  ])("$name", ({ previous, activeRunId, command, quietCount, files }) => {
    const decided = nextFollowUp({ previous, activeRunId, command, nowMs });
    assert.isTrue(Result.isSuccess(decided));
    if (Result.isFailure(decided)) return;
    assert.equal(decided.success.followUp.quietCount, quietCount);
    assert.equal(decided.success.files, files);
    assert.equal(decided.success.followUp.dueAt, command.dueAt ?? null);
  });

  it.each([
    { name: "agent re-checks turned off", command: set({ limit: 0 }), cause: "turned off" },
    { name: "an agent without the limit", command: set({ limit: undefined }), cause: "turned off" },
    { name: "under ten minutes", command: set({ dueAt: minutes(8) }), cause: "at least 10" },
    { name: "over thirty days", command: set({ dueAt: minutes(31 * 24 * 60) }), cause: "30 days" },
    { name: "a past time", command: set({ armedBy: "user", dueAt: minutes(-1) }), cause: "future" },
    {
      name: "both a time and a publish",
      command: { ...set({ dueAt: minutes(15) }), afterPublishMinutes: 60 },
      cause: "exactly one",
    },
  ])("refuses $name", ({ command, cause }) => {
    const decided = nextFollowUp({ previous: null, activeRunId: null, command, nowMs });
    assert.isTrue(Result.isFailure(decided) && decided.failure.includes(cause));
  });

  it("accepts exactly ten minutes read a few seconds later, and lets the owner go shorter", () => {
    const tenMinutes = set({ dueAt: minutes(10) });
    assert.isTrue(
      Result.isSuccess(
        nextFollowUp({
          previous: null,
          activeRunId: null,
          command: tenMinutes,
          nowMs: nowMs + 5_000,
        }),
      ),
    );
    const owner = set({ armedBy: "user", dueAt: minutes(1) });
    assert.isTrue(
      Result.isSuccess(nextFollowUp({ previous: null, activeRunId: null, command: owner, nowMs })),
    );
  });

  it("refuses the re-arm past the limit with the count it reached", () => {
    const decided = nextFollowUp({
      previous: { ...sent, quietCount: 3 },
      activeRunId: followUpRun,
      command: set({ limit: 3 }),
      nowMs,
    });
    assert.isTrue(Result.isFailure(decided));
    if (Result.isSuccess(decided)) return;
    assert.equal(
      decided.failure,
      "This thread has re-checked 4 times without news. Tell the user what you found instead.",
    );
  });
});

describe("followUpAfterOwnerMessage", () => {
  it("keeps an armed follow-up but ends its filing, and ends a sent one", () => {
    const filed = { ...armed, filedAt: minutes(-30) };
    const { filedAt: _filedAt, ...unfiled } = { ...filed, quietCount: 0 };
    assert.deepEqual(followUpAfterOwnerMessage(filed), unfiled);
    assert.isNull(followUpAfterOwnerMessage(sent));
    const untouched = { ...armed, quietCount: 0 };
    assert.strictEqual(followUpAfterOwnerMessage(untouched), untouched);
  });
});

describe("followUpPrompt", () => {
  it("offers another re-check under the limit and asks for an answer at it", () => {
    assert.include(
      followUpPrompt({ question: "Done?", quietCount: 2 }, 3),
      "call `t3_thread_organize` `check_later` again",
    );
    assert.include(followUpPrompt({ question: "Done?", quietCount: 3 }, 3), "last re-check");
    assert.include(followUpPrompt({ question: "Done?", quietCount: 0 }, 0), "last re-check");
  });

  it("gives back only the question, and nothing for a message it did not write", () => {
    const question = "Did the backfill finish?\n\nCompare the row counts.";
    assert.strictEqual(
      followUpPromptQuestion(followUpPrompt({ question, quietCount: 0 }, 3)),
      question,
    );
    assert.isNull(followUpPromptQuestion("Did the backfill finish?"));
  });
});
