import {
  MessageId,
  RunId,
  ThreadId,
  type ThreadCardOpenItem,
  type ThreadEntry,
  type ThreadEntryFiling,
  ThreadEntryId,
  type ThreadEntryOpenItem,
  type ThreadRunLine,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  assignEntries,
  contentsForPrompt,
  fileRun,
  isGoAhead,
  type HandEditResult,
  itemsToRestore,
  mergeEntries,
  moveRun,
  rehomeOpenItems,
  renameEntry,
  restoreEntries,
  runOwnerText,
  runStarter,
  syncOpenItems,
  type ThreadContents,
} from "./ThreadEntries.ts";

const threadId = ThreadId.make("thread:entries");
const entryId = (seq: number) => ThreadEntryId.make(`${threadId}:e${seq}`);
const runId = (ordinal: number) => RunId.make(`run:entries:${ordinal}`);
const at = (minute: number) => `2030-03-03T12:${String(minute).padStart(2, "0")}:00.000Z`;

function entry(
  seq: number,
  title: string,
  runs: ReadonlyArray<number>,
  extra: Partial<ThreadEntry> = {},
): ThreadEntry {
  return {
    id: entryId(seq),
    threadId,
    title,
    titleSource: "model",
    outcome: `${title} outcome`,
    open: [],
    runs: runs.map((ordinal) => ({ runId: runId(ordinal), source: "online" })),
    startMessageId: MessageId.make(`message:${runs[0]}:user`),
    endMessageId: MessageId.make(`message:${runs.at(-1)}:reply`),
    startedAt: at(runs[0]!),
    endedAt: at(runs.at(-1)!),
    status: "active",
    ...extra,
  };
}

function runLine(ordinal: number, startedBy: ThreadRunLine["startedBy"] = "owner"): ThreadRunLine {
  return {
    runId: runId(ordinal),
    threadId,
    ordinal,
    userMessageId: MessageId.make(`message:${ordinal}:user`),
    replyMessageId: MessageId.make(`message:${ordinal}:reply`),
    line: `Card line ${ordinal}`,
    ownerText: null,
    startedBy,
    startedAt: at(ordinal),
    repliedAt: at(ordinal),
  };
}

const contents = (
  entries: ReadonlyArray<ThreadEntry>,
  previous: ReadonlyArray<number> = [],
): ThreadContents => ({
  entries,
  state:
    entries.length === 0
      ? null
      : {
          revision: 3,
          nextEntrySeq: entries.length + 1,
          ownerRuns: 2,
          lastRunOrdinal: 2,
          lastReplyAt: at(2),
          runsSinceRegroup: 2,
          regroupRequestedThrough: 0,
          regroupedThrough: 0,
          regroupedAt: null,
        },
  previousRunEntryIds: previous.map(entryId),
});

const file = (input: {
  readonly contents: ThreadContents;
  readonly run?: ThreadRunLine;
  readonly filing?: ReadonlyArray<ThreadEntryFiling>;
  readonly goAhead?: boolean;
  readonly ownerSpokeMidRun?: boolean;
  readonly open?: ReadonlyArray<ThreadCardOpenItem>;
}) =>
  assignEntries({
    ...input.contents,
    run: input.run ?? runLine(3),
    goAhead: input.goAhead ?? false,
    ownerSpokeMidRun: input.ownerSpokeMidRun ?? false,
    filing: input.filing ?? [],
    card: { line: "Card line 3", open: input.open ?? [] },
  });

/** Where the run went: each entry it now sits in, with `second` marking a second link. */
const placement = (result: ReturnType<typeof assignEntries>) =>
  result?.update.entries.flatMap((candidate) =>
    candidate.runs
      .filter((link) => link.runId === result.update.runLines[0]!.runId)
      .map((link) => `${candidate.title}${link.second ? " (second)" : ""}`),
  ) ?? null;

describe("isGoAhead", () => {
  it.each([
    ["yes", true],
    ["Yesss!", true],
    ["yes do that", true],
    ["Fix it.", true],
    ["published", true],
    ["looks good, ship it", true],
    ["ok now turn it off", false],
    ["sure, but rename the button", false],
    ["how's it going?", false],
    ["make the button blue", false],
    ["", false],
  ])("%j is %s", (text, expected) => {
    expect(isGoAhead(text)).toBe(expected);
  });
});

describe("runStarter", () => {
  const owner = { createdBy: "user" } as const;
  it.each([
    ["the user", owner, "owner"],
    [
      "a wake",
      {
        createdBy: "agent",
        notification: {
          source: { kind: "background_task" },
          outcome: "completed",
          summary: "Done",
        },
      },
      "report",
    ],
    [
      "a subagent report",
      { ...owner, delegatedCompletion: { parentRunId: runId(1), generation: 1, taskIds: [] } },
      "report",
    ],
    ["a Later re-check", { createdBy: "agent", followUp: true }, "other"],
    ["a re-check marked as the user's", { ...owner, followUp: true }, "other"],
    ["another agent", { createdBy: "agent" }, "other"],
    ["a missing message", undefined, "other"],
  ] as const)("%s starts a run as %s", (_name, message, expected) => {
    expect(runStarter(message)).toBe(expected);
  });
});

describe("runOwnerText", () => {
  it.each([
    ["owner", "  fix   the\nlogin test ", [], "fix the login test"],
    ["owner", "fix it", ["also the reset email", "  "], "fix it / also: also the reset email"],
    ["report", "Task finished", [], null],
    ["report", "Task finished", ["how is it going?"], "how is it going?"],
    ["other", null, [], null],
  ] as const)("%s %j with %j reads %j", (startedBy, startText, midRun, expected) => {
    expect(runOwnerText({ startedBy, startText, midRun })).toBe(expected);
  });

  it("cuts the start, each mid-run message and the whole at their lengths", () => {
    const text = runOwnerText({
      startedBy: "owner",
      startText: "s".repeat(300),
      midRun: ["m".repeat(300), "n".repeat(300), "o".repeat(300)],
    })!;
    expect(text.startsWith(`${"s".repeat(170)} / also: ${"m".repeat(100)} / `)).toBe(true);
    expect(text.length).toBe(400);
  });
});

describe("contentsForPrompt and fileRun", () => {
  it("shows the most recent active entries in order of first appearance and maps refs back", () => {
    const entries = [
      entry(2, "Second", [3, 55]),
      entry(1, "First", [1, 2], { open: [{ kind: "verify", text: "Check it", runId: runId(1) }] }),
      entry(3, "Retired", [4], { status: "retired", mergedInto: entryId(1) }),
      ...Array.from({ length: 40 }, (_, index) => entry(10 + index, `Many ${index}`, [10 + index])),
    ];
    const shown = contentsForPrompt(contents(entries, [2]));
    expect(shown.contents.entries).toHaveLength(40);
    // The cap leaves out the two that ended first; "Second" started first of those left.
    expect(shown.contents.entries[0]).toEqual({
      ref: "e1",
      title: "Second",
      outcome: "Second outcome",
      open: false,
    });
    expect(shown.contents.previousRefs).toEqual(["e1"]);
    expect(shown.refToId.get("e1")).toBe(entryId(2));

    const few = contentsForPrompt(contents(entries.slice(0, 3), [1]));
    expect(
      few.contents.entries.map((shownEntry) => [shownEntry.ref, shownEntry.title, shownEntry.open]),
    ).toEqual([
      ["e1", "First", true],
      ["e2", "Second", false],
    ]);
    expect(
      fileRun({
        parsed: [
          { ref: "e2", title: null, outcome: "Moved on" },
          { ref: "e7", title: null, outcome: "Unknown" },
          { ref: "new", title: "Dark mode", outcome: "Added" },
          { ref: "new", title: null, outcome: "Untitled" },
        ],
        refToId: few.refToId,
      }),
    ).toEqual([
      { ref: entryId(2), outcome: "Moved on" },
      { ref: "new", title: "Dark mode", outcome: "Added" },
      { ref: "new", outcome: "Untitled" },
    ]);
  });
});

describe("assignEntries", () => {
  const two = [entry(1, "CSV import limits", [1]), entry(2, "Password reset emails", [2])];

  it.each<{
    readonly name: string;
    readonly contents: ThreadContents;
    readonly run?: ThreadRunLine;
    readonly filing?: ReadonlyArray<ThreadEntryFiling>;
    readonly goAhead?: boolean;
    readonly ownerSpokeMidRun?: boolean;
    readonly expected: ReadonlyArray<string> | null;
  }>([
    {
      name: "1. a run that is already filed changes nothing",
      contents: contents([entry(1, "Login", [1, 3])], [1]),
      filing: [{ ref: "new", title: "Other", outcome: "x" }],
      expected: null,
    },
    {
      name: "2. the first run is one new entry, titled by the filing",
      contents: contents([]),
      filing: [
        { ref: "new", title: "Search accents", outcome: "Fixed" },
        { ref: "new", title: "Another", outcome: "Also" },
      ],
      expected: ["Search accents"],
    },
    {
      name: "2. the first run with no filing is titled by the card line",
      contents: contents([]),
      expected: ["Card line 3"],
    },
    {
      name: "3. a go-ahead keeps the model's pick among the previous run's entries",
      contents: contents(two, [2]),
      goAhead: true,
      filing: [
        { ref: "new", title: "Queue send", outcome: "x" },
        { ref: entryId(2), outcome: "Queued" },
      ],
      expected: ["Password reset emails"],
    },
    {
      name: "3. a go-ahead the model filed elsewhere goes to the previous run's first entry",
      contents: contents(two, [2]),
      goAhead: true,
      filing: [{ ref: entryId(1), outcome: "x" }],
      expected: ["Password reset emails"],
    },
    {
      name: "4. a report never starts an entry",
      contents: contents(two, [1]),
      run: runLine(3, "report"),
      filing: [{ ref: "new", title: "Test run", outcome: "412 pass" }],
      expected: ["CSV import limits"],
    },
    {
      name: "4. a report the user typed into can start one",
      contents: contents(two, [1]),
      run: runLine(3, "report"),
      ownerSpokeMidRun: true,
      filing: [{ ref: "new", title: "Date picker month", outcome: "Fixed" }],
      expected: ["Date picker month"],
    },
    {
      name: "5. no usable filing goes to the previous run's first entry",
      contents: contents(two, [2, 1]),
      expected: ["Password reset emails"],
    },
    {
      name: "5. with no previous run, the entry worked on last",
      contents: contents(two, []),
      expected: ["Password reset emails"],
    },
    {
      name: "5. a retired previous entry resolves to the entry that took it",
      contents: contents(
        [...two, entry(3, "Old", [], { status: "retired", mergedInto: entryId(1) })],
        [3],
      ),
      expected: ["CSV import limits"],
    },
    {
      name: "6. a new topic named like an existing entry is that entry",
      contents: contents(two, [2]),
      filing: [{ ref: "new", title: "csv Import Limits!", outcome: "Raised" }],
      expected: ["CSV import limits"],
    },
    {
      name: "7. two entries at most, duplicates dropped, the second marked",
      contents: contents(two, [2]),
      filing: [
        { ref: entryId(1), outcome: "a" },
        { ref: entryId(1), outcome: "b" },
        { ref: "new", title: "Dark mode", outcome: "c" },
        { ref: entryId(2), outcome: "d" },
      ],
      expected: ["CSV import limits", "Dark mode (second)"],
    },
  ])("$name", (testCase) => {
    expect(placement(file(testCase))).toEqual(testCase.expected);
  });

  it("writes the run's link, outcome, ends and state, and a new entry's start", () => {
    const result = file({
      contents: contents(two, [2]),
      filing: [
        { ref: entryId(2), outcome: "" },
        { ref: "new", title: "Dark mode", outcome: "Switch added" },
      ],
    })!;
    const [reset, darkMode] = result.update.entries;
    expect(reset).toMatchObject({
      id: entryId(2),
      outcome: "Card line 3",
      endMessageId: MessageId.make("message:3:reply"),
      endedAt: at(3),
      startedAt: at(2),
    });
    expect(reset!.runs.at(-1)).toEqual({ runId: runId(3), source: "online" });
    expect(darkMode).toMatchObject({
      id: entryId(3),
      title: "Dark mode",
      titleSource: "model",
      outcome: "Switch added",
      runs: [{ runId: runId(3), source: "online", second: true }],
      startMessageId: MessageId.make("message:3:user"),
      startedAt: at(3),
      status: "active",
    });
    expect(result.update.runLines).toEqual([runLine(3)]);
    expect(result.update.state).toMatchObject({
      revision: 4,
      nextEntrySeq: 4,
      ownerRuns: 3,
      lastRunOrdinal: 3,
      lastReplyAt: at(3),
      runsSinceRegroup: 3,
    });
    expect(result.mark).toBeNull();
  });

  it("marks a regroup when an owner run reaches 10, 20, 40 or 80 and not for a report", () => {
    const at9 = (startedBy: ThreadRunLine["startedBy"]) => {
      const base = contents([entry(1, "Work", [1])], [1]);
      return file({
        contents: { ...base, state: { ...base.state!, ownerRuns: 9 } },
        run: runLine(12, startedBy),
      });
    };
    expect(at9("owner")?.mark).toBe(10);
    expect(at9("report")?.mark).toBeNull();
    expect(at9("report")?.update.state.ownerRuns).toBe(9);
  });

  it("keeps a simple thread of go-aheads, corrections, a commit and a report in one entry", () => {
    // Each step is what the model might say for one run of a five-message thread about one change.
    const steps: ReadonlyArray<{
      readonly startedBy?: ThreadRunLine["startedBy"];
      readonly goAhead?: boolean;
      readonly filing: ReadonlyArray<ThreadEntryFiling>;
    }> = [
      { filing: [{ ref: "new", title: "Orders table columns", outcome: "Status column added" }] },
      { goAhead: true, filing: [{ ref: "new", title: "Column order", outcome: "Reordered" }] },
      { filing: [{ ref: "new", title: "Orders Table Columns", outcome: "Order restored" }] },
      {
        startedBy: "report",
        filing: [{ ref: "new", title: "Snapshot tests", outcome: "12 pass" }],
      },
      { filing: [] },
    ];
    let state: ThreadContents = contents([]);
    for (const [index, step] of steps.entries()) {
      const result = file({
        contents: state,
        run: runLine(index + 1, step.startedBy ?? "owner"),
        goAhead: step.goAhead ?? false,
        filing: step.filing,
      })!;
      const changed = new Map(result.update.entries.map((candidate) => [candidate.id, candidate]));
      const entries = [
        ...state.entries.map((candidate) => changed.get(candidate.id) ?? candidate),
        ...result.update.entries.filter(
          (candidate) => !state.entries.some((old) => old.id === candidate.id),
        ),
      ];
      state = {
        entries,
        state: result.update.state,
        previousRunEntryIds: entries
          .filter((candidate) => candidate.runs.some((link) => link.runId === runId(index + 1)))
          .map((candidate) => candidate.id),
      };
    }
    expect(state.entries.map((candidate) => [candidate.title, candidate.runs.length])).toEqual([
      ["Orders table columns", 5],
    ]);
  });
});

describe("syncOpenItems", () => {
  const item = (
    kind: ThreadCardOpenItem["kind"],
    text: string,
    run: number,
  ): ThreadEntryOpenItem => ({ kind, text, runId: runId(run) });

  it("keeps held items where they are, takes the card's words, adds new ones to the first entry and drops the rest", () => {
    const entries = [
      entry(1, "Login", [1], {
        open: [
          item("verify", "Check the redirect on a phone", 1),
          item("commit", "Login changes are uncommitted", 1),
        ],
      }),
      entry(2, "Reset email", [2], { open: [item("ask", "Queue the reset email send?", 2)] }),
      entry(3, "Retired", [], { status: "retired", open: [item("ship", "Publish", 1)] }),
    ];
    const synced = syncOpenItems(
      entries,
      [
        { kind: "ask", text: "Queue the reset-email send?" },
        { kind: "verify", text: "Check the login redirect on a phone" },
        { kind: "followup", text: "Re-check the nightly build", dueAt: "2030-03-04T08:00:00.000Z" },
      ],
      runId(3),
      entryId(2),
    );
    expect(synced.map((candidate) => candidate.open)).toEqual([
      [item("verify", "Check the login redirect on a phone", 1)],
      [
        item("ask", "Queue the reset-email send?", 2),
        { ...item("followup", "Re-check the nightly build", 3), dueAt: "2030-03-04T08:00:00.000Z" },
      ],
      [item("ship", "Publish", 1)],
    ]);
    expect(synced[2]).toBe(entries[2]);
    const held = entries.slice(0, 2).flatMap((candidate) => candidate.open);
    const unchanged = syncOpenItems(entries, held, runId(3), entryId(1));
    expect(unchanged.every((candidate, index) => candidate === entries[index])).toBe(true);
  });

  it("does not hold a different item of the same kind for a reworded one", () => {
    const entries = [
      entry(1, "Login", [1], { open: [item("verify", "Check the redirect on a phone", 1)] }),
    ];
    expect(
      syncOpenItems(
        entries,
        [{ kind: "verify", text: "Run the billing tests" }],
        runId(2),
        entryId(1),
      )[0]!.open,
    ).toEqual([item("verify", "Run the billing tests", 2)]);
  });

  it("attaches the open items of a card written before entries existed to the run's first entry", () => {
    const result = file({
      contents: contents([]),
      open: [{ kind: "commit", text: "Nothing committed" }],
    })!;
    expect(result.update.entries[0]!.open).toEqual([item("commit", "Nothing committed", 3)]);
  });
});

describe("rehomeOpenItems and itemsToRestore", () => {
  const item = (text: string, run: number): ThreadEntryOpenItem => ({
    kind: "verify",
    text,
    runId: runId(run),
  });

  it("moves items with their run's first link, else to the entry worked on last", () => {
    const entries = [
      entry(1, "Login", [1], { open: [item("Moved run", 2), item("Orphan", 9)] }),
      entry(2, "Reset", [3, 2], { endedAt: at(1) }),
      entry(3, "Later", [4], { runs: [{ runId: runId(2), source: "online", second: true }] }),
    ];
    // "Later" holds run 2 only as its second entry, so the item goes to "Reset".
    expect(rehomeOpenItems(entries).map((candidate) => candidate.open)).toEqual([
      [],
      [item("Moved run", 2)],
      [item("Orphan", 9)],
    ]);
    const retired = entries.map((candidate) => ({ ...candidate, status: "retired" as const }));
    expect(rehomeOpenItems(retired).flatMap((candidate) => candidate.open)).toEqual([]);
  });

  it("restores only items the card lacks, while there is room", () => {
    const card = Array.from({ length: 5 }, (_, index) => ({
      kind: "verify" as const,
      text: `Held ${index}`,
    }));
    expect(
      itemsToRestore(card, [item("held 0!", 1), item("New one", 1), item("Over the cap", 1)]),
    ).toEqual([item("New one", 1)]);
  });
});

describe("hand edits", () => {
  const lines = new Map(
    Array.from({ length: 8 }, (_, index) => runLine(index + 1)).map((line) => [line.runId, line]),
  );
  const second = (ordinal: number) => ({
    runId: runId(ordinal),
    source: "online" as const,
    second: true as const,
  });
  const verify = (text: string, run: number): ThreadEntryOpenItem => ({
    kind: "verify",
    text,
    runId: runId(run),
  });
  // Login 1 2 3 (run 3 also second in Reset), Reset 4 5, Billing 6; e9 and e8 were retired long ago.
  const before: ReadonlyArray<ThreadEntry> = [
    entry(1, "Login", [1, 2, 3], { open: [verify("Check the login", 3)] }),
    entry(2, "Reset", [4, 5], {
      runs: [second(3), ...entry(0, "", [4, 5]).runs],
      startMessageId: MessageId.make("message:3:user"),
      startedAt: at(3),
    }),
    entry(3, "Billing", [6]),
    entry(9, "Old", [7], { status: "retired", runs: [], mergedInto: entryId(2) }),
    entry(8, "Older", [8], { status: "retired", runs: [], mergedInto: entryId(3) }),
  ];
  const start = { ...contents(before), state: { ...contents(before).state!, nextEntrySeq: 10 } };

  /** Each entry after the edit as `<seq> <status> <title>[*] | <runs> [open] -> <mergedInto>`. */
  const rows = (result: HandEditResult) => {
    if ("refused" in result) return result.refused;
    const byId = new Map(before.map((candidate) => [candidate.id, candidate]));
    for (const changed of result.update?.entries ?? []) byId.set(changed.id, changed);
    const seq = (id: string) => id.slice(id.lastIndexOf(":e") + 2);
    return [...byId.values()].map(
      (candidate) =>
        `${seq(candidate.id)} ${candidate.status} ${candidate.title}${candidate.titleSource === "owner" ? "*" : ""} | ${candidate.runs
          .map(
            (link) =>
              `${link.runId.slice(link.runId.lastIndexOf(":") + 1)}${link.source === "owner" ? "o" : ""}${link.second ? "s" : ""}`,
          )
          .join(
            " ",
          )}${candidate.open.length > 0 ? ` [${candidate.open.map((item) => item.text).join(", ")}]` : ""}${
          candidate.mergedInto === undefined ? "" : ` -> ${seq(candidate.mergedInto)}`
        }`,
    );
  };

  it.each<{ name: string; edit: () => HandEditResult; rows: ReadonlyArray<string> | string }>([
    {
      name: "rename sets an owner title, through a retired entry's pointer",
      edit: () => renameEntry(start, lines, entryId(9), "  Password   reset "),
      rows: [
        "1 active Login | 1 2 3 [Check the login]",
        "2 active Password reset* | 3s 4 5",
        "3 active Billing | 6",
        "9 retired Old |  -> 2",
        "8 retired Older |  -> 3",
      ],
    },
    {
      name: "rename refuses an empty title",
      edit: () => renameEntry(start, lines, entryId(1), "   "),
      rows: "A topic needs a title.",
    },
    {
      name: "merge places every run by hand, keeps a run first if it was first in either, and re-points old pointers",
      edit: () => mergeEntries(start, lines, entryId(2), entryId(3)),
      rows: [
        "1 active Login | 1 2 3 [Check the login]",
        "2 retired Reset |  -> 3",
        "3 active Billing | 3os 4o 5o 6o",
        "9 retired Old |  -> 3",
        "8 retired Older |  -> 3",
      ],
    },
    {
      name: "merge moves open items with their runs",
      edit: () => mergeEntries(start, lines, entryId(1), entryId(2)),
      rows: [
        "1 retired Login |  -> 2",
        "2 active Reset | 1o 2o 3o 4o 5o [Check the login]",
        "3 active Billing | 6",
        "9 retired Old |  -> 2",
        "8 retired Older |  -> 3",
      ],
    },
    {
      name: "merge refuses an entry into itself",
      edit: () => mergeEntries(start, lines, entryId(9), entryId(2)),
      rows: "A topic cannot be merged into itself.",
    },
    {
      name: "move takes a run out of every entry and its open item goes with it",
      edit: () => moveRun(start, lines, runId(3), { entryId: entryId(3) }),
      rows: [
        "1 active Login | 1 2",
        "2 active Reset | 4 5",
        "3 active Billing | 3o 6 [Check the login]",
        "9 retired Old |  -> 2",
        "8 retired Older |  -> 3",
      ],
    },
    {
      name: "move to a new topic makes an owner-titled entry; an emptied entry is retired into it",
      edit: () => moveRun(start, lines, runId(6), { newTitle: "Invoices" }),
      rows: [
        "1 active Login | 1 2 3 [Check the login]",
        "2 active Reset | 3s 4 5",
        "3 retired Billing |  -> 10",
        "9 retired Old |  -> 2",
        "8 retired Older |  -> 10",
        "10 active Invoices* | 6o",
      ],
    },
    {
      name: "move refuses a run with no run line",
      edit: () => moveRun(start, lines, runId(99), { entryId: entryId(1) }),
      rows: "That message is not in a topic yet.",
    },
  ])("$name", ({ edit, rows: expected }) => {
    expect(rows(edit())).toEqual(expected);
  });

  it("bumps the revision, keeps the bookkeeping and gives a new entry its span", () => {
    const result = moveRun(start, lines, runId(6), { newTitle: "Invoices" });
    if ("refused" in result) throw new Error(result.refused);
    const { state, entries } = result.update!;
    expect([state.revision, state.nextEntrySeq, state.runsSinceRegroup]).toEqual([4, 11, 2]);
    expect(entries.at(-1)).toMatchObject({
      outcome: "Card line 6",
      startMessageId: MessageId.make("message:6:user"),
      endMessageId: MessageId.make("message:6:reply"),
    });
    const moved = moveRun(start, lines, runId(4), { entryId: entryId(1) });
    if ("refused" in moved) throw new Error(moved.refused);
    // Run 4 opened Reset, which now starts at its next run.
    expect(moved.update!.entries.find((candidate) => candidate.id === entryId(2))?.startedAt).toBe(
      at(3),
    );
    const again = moveRun(
      {
        ...start,
        entries: [entry(1, "Login", [1], { runs: [{ runId: runId(1), source: "owner" }] })],
      },
      lines,
      runId(1),
      { entryId: entryId(1) },
    );
    expect(again).toEqual({ update: null });
  });

  const edits = {
    // Run 3 is second in Reset and first in Login: undo must keep both links whichever is renamed.
    rename: () => renameEntry(start, lines, entryId(2), "Password reset"),
    "rename of a run's first entry": () => renameEntry(start, lines, entryId(1), "Sign in"),
    merge: () => mergeEntries(start, lines, entryId(1), entryId(2)),
    move: () => moveRun(start, lines, runId(3), { entryId: entryId(3) }),
    "new topic": () => moveRun(start, lines, runId(6), { newTitle: "Invoices" }),
  };

  it.each(Object.entries(edits))("undo of %s puts the entries back", (_name, edit) => {
    const result = edit();
    if ("refused" in result || result.update === null) throw new Error("the edit did nothing");
    const after = {
      entries: before.map(
        (candidate) =>
          result.update!.entries.find((changed) => changed.id === candidate.id) ?? candidate,
      ),
      state: result.update.state,
      previousRunEntryIds: [],
    };
    for (const added of result.update.entries) {
      if (!before.some((candidate) => candidate.id === added.id)) {
        (after.entries as Array<ThreadEntry>).push(added);
      }
    }
    // The client sends back the active entries it held before the edit, of those the edit changed.
    const undo = restoreEntries(
      after,
      lines,
      threadId,
      before.filter(
        (candidate) =>
          candidate.status === "active" &&
          result.update!.entries.some((changed) => changed.id === candidate.id),
      ),
      result.update.state.revision,
    );
    if ("refused" in undo) throw new Error(undo.refused);
    const restored = after.entries.map(
      (candidate) =>
        undo.update?.entries.find((changed) => changed.id === candidate.id) ?? candidate,
    );
    expect(restored.slice(0, before.length)).toEqual(before);
    // A message moved to a new topic goes back, and the new topic is retired, never reused.
    expect(
      restored.slice(before.length).map((candidate) => [candidate.status, candidate.mergedInto]),
    ).toEqual(_name === "new topic" ? [["retired", entryId(3)]] : []);
    expect(undo.update?.state.revision).toBe(result.update.state.revision + 1);
  });

  it.each([
    {
      name: "a revision that moved on",
      entries: [before[0]!],
      revision: 2,
      refused: "These topics changed since, so this can no longer be undone.",
    },
    {
      name: "an entry of another thread",
      entries: [{ ...before[0]!, threadId: ThreadId.make("thread:other") }],
      revision: 3,
      refused: "Undo names a topic this thread does not have.",
    },
    {
      name: "an id the thread never had",
      entries: [entry(42, "Made up", [1])],
      revision: 3,
      refused: "Undo names a topic this thread does not have.",
    },
    {
      name: "a run with no run line",
      entries: [entry(3, "Billing", [6, 99])],
      revision: 3,
      refused: "Undo names a message that is no longer in this thread.",
    },
    {
      name: "a message left in no topic",
      entries: [entry(3, "Billing", [], { status: "retired", mergedInto: entryId(1) })],
      revision: 3,
      refused: "Undo would leave a message in no topic or in two.",
    },
  ])("undo refuses $name", ({ entries, revision, refused }) => {
    expect(restoreEntries(start, lines, threadId, entries, revision)).toEqual({ refused });
  });
});
