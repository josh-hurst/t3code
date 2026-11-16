import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  RunId,
  type ThreadContentsState,
  type ThreadContentsTopic,
  type ThreadEntry,
  ThreadEntryId,
  type ThreadEntryLinkSource,
  ThreadId,
  type ThreadRunLine,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  type HandEditResult,
  mergeEntries,
  moveRun,
  renameEntry,
  type ThreadContents,
} from "./ThreadEntries.ts";
import {
  applyRegroup,
  buildOutline,
  combineSamples,
  parseTopics,
  type RegroupTopic,
  repairTopics,
} from "./ThreadRegroup.ts";

const threadId = ThreadId.make("thread:regroup");
const runId = (n: number) => RunId.make(`run:${n}`);
const id = (seq: number) => ThreadEntryId.make(`${threadId}:e${seq}`);
const at = (n: number, seconds = 0) =>
  DateTime.formatIso(DateTime.makeUnsafe(Date.UTC(2030, 0, 1, 0, n, seconds)));

const runLine = (n: number, fields: Partial<ThreadRunLine> = {}): ThreadRunLine => ({
  runId: runId(n),
  threadId,
  ordinal: n,
  userMessageId: MessageId.make(`message:${n}:user`),
  replyMessageId: MessageId.make(`message:${n}:reply`),
  line: `Did ${n}`,
  ownerText: `Ask ${n}`,
  startedBy: "owner",
  startedAt: at(n),
  repliedAt: at(n, 30),
  ...fields,
});

type LinkSpec = number | readonly [number, ThreadEntryLinkSource];

const entry = (
  seq: number,
  links: ReadonlyArray<LinkSpec>,
  fields: Partial<ThreadEntry> = {},
): ThreadEntry => {
  const runs = links.map((link) =>
    typeof link === "number"
      ? { runId: runId(link), source: "online" as const }
      : { runId: runId(link[0]), source: link[1] },
  );
  const ordinals = links.map((link) => (typeof link === "number" ? link : link[0]));
  const first = Math.min(...ordinals);
  const last = Math.max(...ordinals);
  return {
    id: id(seq),
    threadId,
    title: `Entry ${seq}`,
    titleSource: "model",
    outcome: `Outcome ${seq}`,
    open: [],
    runs,
    startMessageId: MessageId.make(`message:${first}:user`),
    endMessageId: MessageId.make(`message:${last}:reply`),
    startedAt: at(first),
    endedAt: at(last, 30),
    status: "active",
    ...fields,
  };
};

const state = (fields: Partial<ThreadContentsState> = {}): ThreadContentsState => ({
  revision: 4,
  nextEntrySeq: 10,
  ownerRuns: 12,
  lastRunOrdinal: 12,
  lastReplyAt: at(12, 30),
  runsSinceRegroup: 12,
  regroupRequestedThrough: 12,
  regroupedThrough: 0,
  regroupedAt: null,
  ...fields,
});

const topic = (title: string, runs: ReadonlyArray<number>): ThreadContentsTopic => ({
  title,
  outcome: `${title} outcome`,
  runIds: runs.map(runId),
});

const lines = (count: number) => Array.from({ length: count }, (_, index) => runLine(index + 1));

/** The thread's entries after the update, as `<seq> <status> <title> | <runs> -> <mergedInto>`. */
function regroup(
  entries: ReadonlyArray<ThreadEntry>,
  topics: ReadonlyArray<ThreadContentsTopic>,
  runCount = 12,
  contentsState = state(),
) {
  const update = applyRegroup({
    contents: { entries, state: contentsState, previousRunEntryIds: [] },
    runLines: lines(runCount),
    topics,
    at: at(59),
  })!;
  const byId = new Map(entries.map((candidate) => [candidate.id, candidate]));
  for (const changed of update.entries) byId.set(changed.id, changed);
  const after = [...byId.values()];
  // Every run sits in exactly one active entry as its first link.
  for (const line of lines(runCount)) {
    const primary = after.filter(
      (candidate) =>
        candidate.status === "active" &&
        candidate.runs.some((link) => link.runId === line.runId && link.second !== true),
    );
    const linked = after.some((candidate) =>
      candidate.runs.some((link) => link.runId === line.runId),
    );
    if (linked) assert.lengthOf(primary, 1, `run ${line.ordinal}`);
  }
  const seq = (entryId: string) => entryId.slice(entryId.lastIndexOf(":e") + 1);
  return {
    update,
    after,
    rows: after.map(
      (candidate) =>
        `${seq(candidate.id)} ${candidate.status} ${candidate.title} | ${candidate.runs
          .map(
            (link) =>
              `${link.runId.slice(4)}${link.source === "owner" ? "o" : ""}${link.second ? "s" : ""}`,
          )
          .join(
            " ",
          )}${candidate.mergedInto === undefined ? "" : ` -> ${seq(candidate.mergedInto)}`}`,
    ),
  };
}

describe("buildOutline", () => {
  it("numbers runs in order and marks runs the owner did not start", () => {
    const outline = buildOutline([
      runLine(7, { ownerText: null, line: "Skipped: nothing typed, no line" }),
      runLine(2, { startedBy: "report", ownerText: null, line: "Tests passed" }),
      runLine(1, { ownerText: "Add a rate limit", line: "Added it" }),
      runLine(3, { startedBy: "report", ownerText: "also check the logs", line: "Logs clean" }),
      runLine(5, { startedBy: "other", ownerText: "Re-check: is the deploy live?", line: null }),
      runLine(6, { ownerText: null, line: null }),
    ]);
    assert.deepEqual(outline.text.split("\n"), [
      "r1 | Add a rate limit | Added it",
      "r2 | (background task or subagent reported back) | Tests passed",
      "r3 | (background task or subagent reported back) / also: also check the logs | Logs clean",
      "r4 | Re-check: is the deploy live? |",
      "r5 | (background task or subagent reported back) | Skipped: nothing typed, no line",
    ]);
    assert.deepEqual(outline.runIds, [1, 2, 3, 5, 7].map(runId));
  });
});

describe("parseTopics", () => {
  it.each([
    [
      "the measured shape",
      "Rate limit | Added, not deployed | open | 1 2 3",
      ["Rate limit", "Added, not deployed", [1, 2, 3]],
    ],
    [
      "a label, r numbers and commas",
      "topic: Rate limit | Added | done | r1, r2",
      ["Rate limit", "Added", [1, 2]],
    ],
    [
      "title and outcome in one field",
      "Rate limit: added and deployed | 4 5",
      ["Rate limit", "added and deployed", [4, 5]],
    ],
    ["a bullet and an unknown run", "- Rate limit | Added | 2 99 2", ["Rate limit", "Added", [2]]],
    ["an over-long title", `${"x".repeat(90)} | Added | 1`, ["x".repeat(80), "Added", [1]]],
  ] as const)("reads %s", (_name, raw, [title, outcome, runs]) => {
    assert.deepEqual(parseTopics(raw, 10), [{ title, outcome, runs: [...runs] }]);
  });

  it("skips lines that are not topics and returns null when none is left", () => {
    assert.isNull(parseTopics("Here are the topics:\nRate limit | Added | runs one to three", 10));
    assert.isNull(parseTopics("| Added | 1 2", 10));
    assert.deepEqual(
      parseTopics('{"note": "x"}\nRate limit | Added | 1\nSearch | Fixed | 2', 10)?.map(
        (parsed) => parsed.title,
      ),
      ["Rate limit", "Search"],
    );
  });
});

describe("repairTopics", () => {
  const topicOf = (title: string, runs: ReadonlyArray<number>): RegroupTopic => ({
    title,
    outcome: "",
    runs,
  });

  it("files dropped runs with the previous run, the first with the next, and keeps two topics a run", () => {
    const repaired = repairTopics(
      [topicOf("A", [2, 3, 6]), topicOf("B", [3, 5, 6]), topicOf("C", [6])],
      6,
    );
    assert.strictEqual(repaired.repaired, 2);
    assert.deepEqual(
      repaired.topics.map((repairedTopic) => [repairedTopic.title, repairedTopic.runs]),
      [
        ["A", [1, 2, 3, 4, 6]],
        ["B", [3, 5, 6]],
      ],
    );
  });
});

describe("combineSamples", () => {
  const sample = (...groups: ReadonlyArray<readonly [string, ReadonlyArray<number>]>) =>
    groups.map(([title, runs]): RegroupTopic => ({ title, outcome: `${title} now`, runs }));

  it("joins runs two samples put together and titles a group from its best match, earliest first", () => {
    const combined = combineSamples(
      [
        sample(["Billing", [1, 2, 3]], ["Search", [4, 5, 6]]),
        sample(["Everything", [1, 2, 3, 4, 5, 6]]),
        sample(["Billing bug", [1, 2, 3]], ["Search index", [4, 5]], ["Stray", [6]]),
      ],
      6,
    );
    assert.deepEqual(
      combined.map((group) => [group.title, group.runs]),
      [
        ["Billing", [1, 2, 3]],
        ["Search", [4, 5, 6]],
      ],
    );
  });

  it("takes connected groups, and one sample as it is", () => {
    const chained = combineSamples(
      [
        sample(["A", [1, 2]], ["C", [3]]),
        sample(["AB", [1, 2, 3]]),
        sample(["A", [1]], ["BC", [2, 3]]),
      ],
      3,
    );
    assert.deepEqual(
      chained.map((group) => group.runs),
      [[1, 2, 3]],
    );
    // A run in two topics in every sample votes only for its first, so it joins nothing.
    const bridged = combineSamples(
      [
        sample(["A", [1, 2, 3]], ["B", [3, 4, 5]]),
        sample(["A", [1, 2, 3]], ["B", [3, 4, 5]]),
        sample(["A", [1, 2]], ["B", [3, 4, 5]]),
      ],
      5,
    );
    assert.deepEqual(
      bridged.map((group) => group.runs),
      [
        [1, 2, 3],
        [4, 5],
      ],
    );
    const single = sample(["A", [1, 2]], ["B", [2, 3]]);
    assert.strictEqual(combineSamples([single], 3), single);
  });
});

type HandEdit = (
  contents: ThreadContents,
  runLines: ReadonlyMap<RunId, ThreadRunLine>,
) => HandEditResult;

/** The entries and state a hand edit leaves, as the store would hold them. */
function afterEdit(entries: ReadonlyArray<ThreadEntry>, edit: HandEdit) {
  const result = edit(
    { entries, state: state(), previousRunEntryIds: [] },
    new Map(lines(12).map((line) => [line.runId, line])),
  );
  if ("refused" in result || result.update === null) throw new Error("the edit did nothing");
  const changed = result.update.entries;
  return {
    entries: [
      ...entries.map((old) => changed.find((candidate) => candidate.id === old.id) ?? old),
      ...changed.filter((candidate) => !entries.some((old) => old.id === candidate.id)),
    ],
    state: result.update.state,
  };
}

describe("applyRegroup", () => {
  it.each<{
    name: string;
    entries: ReadonlyArray<ThreadEntry>;
    edit?: HandEdit;
    topics: ReadonlyArray<ThreadContentsTopic>;
    rows: ReadonlyArray<string>;
  }>([
    {
      name: "a split entry keeps its id on the part it matches best and down to 0.25",
      entries: [entry(1, [1, 2, 3, 4]), entry(2, [5, 6, 7, 8])],
      topics: [topic("First", [1]), topic("Rest", [2, 3, 4, 5, 6, 7, 8])],
      rows: ["e1 active First | 1", "e2 active Entry 2 | 2 3 4 5 6 7 8"],
    },
    {
      name: "a tie goes to the topic holding the entry's first run",
      entries: [entry(1, [1, 2, 3, 4])],
      topics: [topic("Later part", [3, 4]), topic("Opening part", [1, 2])],
      rows: ["e1 active Entry 1 | 1 2", "e10 active Later part | 3 4"],
    },
    {
      name: "an entry below 0.25 is retired and every pointer at it moves on, one hop",
      entries: [
        entry(1, [1], { status: "retired", runs: [], mergedInto: id(2) }),
        entry(2, [2, 3, 4, 5]),
        entry(3, [6, 7, 8, 9, 10, 11, 12]),
      ],
      topics: [topic("All of it", [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])],
      rows: [
        "e1 retired Entry 1 |  -> e3",
        "e2 retired Entry 2 |  -> e3",
        "e3 active Entry 3 | 2 3 4 5 6 7 8 9 10 11 12",
      ],
    },
    {
      name: "runs the topics do not mention keep their links",
      entries: [entry(1, [1, 2, 3, 4])],
      topics: [topic("Start", [1, 2]), topic("Other", [3])],
      rows: ["e1 active Entry 1 | 1 2 4", "e10 active Other | 3"],
    },
    {
      name: "a run in two topics of one sample gets one first link",
      entries: [entry(1, [1, 2, 3, 4, 5])],
      topics: [topic("Start", [1, 2, 3]), topic("Status", [3, 4, 5])],
      rows: ["e1 active Entry 1 | 1 2 3", "e10 active Status | 3s 4 5"],
    },
    {
      name: "a run the owner placed stays where it is",
      entries: [entry(1, [1, 2, [3, "owner"]]), entry(2, [4, 5])],
      topics: [topic("All", [1, 2, 3, 4, 5])],
      rows: ["e1 active Entry 1 | 1 2 3o 4 5", "e2 retired Entry 2 |  -> e1"],
    },
    {
      name: "an entry whose every run the owner placed is left alone",
      entries: [
        entry(1, [
          [1, "owner"],
          [2, "owner"],
        ]),
        entry(2, [3, 4]),
      ],
      topics: [topic("All", [1, 2, 3, 4])],
      rows: ["e1 active Entry 1 | 1o 2o", "e2 active Entry 2 | 3 4"],
    },
    {
      name: "an owner-titled entry is never retired",
      entries: [
        entry(1, [1, 2], { title: "Rate limiter", titleSource: "owner" }),
        entry(2, [3, 4], { title: "Search index", titleSource: "owner" }),
      ],
      topics: [topic("Backend work", [1, 2, 3, 4])],
      rows: ["e1 active Rate limiter | 1 2", "e2 active Search index | 3 4"],
    },
    {
      name: "a model title changes only when more than half the runs changed",
      entries: [entry(1, [1, 2, 3, 4, 5, 6, 7]), entry(2, [8])],
      topics: [topic("Kept", [1, 2, 3, 4]), topic("Renamed", [5, 6, 7, 8])],
      rows: ["e1 active Entry 1 | 1 2 3 4", "e2 active Renamed | 5 6 7 8"],
    },
    // A regroup after a hand edit keeps the edit, by the edit functions the commands run.
    {
      name: "after a rename the owner's entry keeps its title and wins the topic",
      entries: [entry(1, [1, 2]), entry(2, [3, 4, 5, 6, 7, 8])],
      edit: (contents, runLines) => renameEntry(contents, runLines, id(1), "Rate limiter"),
      topics: [topic("Everything", [1, 2, 3, 4, 5, 6, 7, 8])],
      rows: ["e1 active Rate limiter | 1 2 3 4 5 6 7 8", "e2 retired Entry 2 |  -> e1"],
    },
    {
      name: "after a merge the merged entry is left as it is",
      entries: [entry(1, [1, 2]), entry(2, [3, 4]), entry(3, [5, 6])],
      edit: (contents, runLines) => mergeEntries(contents, runLines, id(2), id(1)),
      topics: [topic("Split A", [1, 2]), topic("Split B", [3, 4, 5, 6])],
      rows: [
        "e1 active Entry 1 | 1o 2o 3o 4o",
        "e2 retired Entry 2 |  -> e1",
        "e3 active Entry 3 | 5 6",
      ],
    },
    {
      name: "after a move the run stays in the entry the owner chose",
      entries: [entry(1, [1, 2, 3, 4]), entry(2, [5, 6])],
      edit: (contents, runLines) => moveRun(contents, runLines, runId(4), { entryId: id(2) }),
      topics: [topic("Start", [1, 2, 3, 4]), topic("End", [5, 6])],
      rows: ["e1 active Entry 1 | 1 2 3", "e2 active Entry 2 | 4o 5 6"],
    },
    {
      name: "after a move to a new topic the new topic stays",
      entries: [entry(1, [1, 2, 3, 4, 5, 6])],
      edit: (contents, runLines) => moveRun(contents, runLines, runId(6), { newTitle: "Invoices" }),
      topics: [topic("All", [1, 2, 3, 4, 5, 6]), topic("Fresh", [7])],
      rows: ["e1 active Entry 1 | 1 2 3 4 5", "e10 active Invoices | 6o", "e11 active Fresh | 7"],
    },
  ])("$name", ({ entries, edit, topics, rows }) => {
    const edited = edit === undefined ? { entries, state: state() } : afterEdit(entries, edit);
    assert.deepEqual(regroup(edited.entries, topics, 12, edited.state).rows, rows);
  });

  it("keeps an unchanged entry's outcome and takes the topic's when the runs changed", () => {
    const { after } = regroup(
      [entry(1, [1, 2, 3]), entry(2, [4, 5, 6])],
      [topic("Same", [1, 2, 3]), topic("Grown", [4, 5, 6, 7])],
    );
    assert.deepEqual(
      after.map((candidate) => candidate.outcome),
      ["Outcome 1", "Grown outcome"],
    );
    assert.deepEqual(
      [after[1]!.startedAt, after[1]!.endedAt, after[1]!.endMessageId],
      [at(4), at(7, 30), MessageId.make("message:7:reply")],
    );
  });

  it("moves open items with their run, and never takes open state from the topics", () => {
    const item = { kind: "commit" as const, text: "Commit the limiter", runId: runId(4) };
    const { after } = regroup(
      [entry(1, [1, 2, 3, 4], { open: [item] })],
      [topic("Start", [1, 2]), topic("Limiter", [3, 4])],
    );
    assert.deepEqual(
      after.map((candidate) => candidate.open.map((open) => open.text)),
      [[], ["Commit the limiter"]],
    );
  });

  it("advances the bookkeeping even when the owner placed every run", () => {
    const { update } = regroup(
      [
        entry(1, [
          [1, "owner"],
          [2, "owner"],
        ]),
      ],
      [topic("Mine", [1, 2])],
      2,
    );
    assert.deepEqual(update.entries, []);
    assert.deepEqual(
      [
        update.state.revision,
        update.state.regroupedThrough,
        update.state.runsSinceRegroup,
        update.state.regroupedAt,
      ],
      [5, 2, 0, at(59)],
    );
  });

  it("leaves out runs rolled back since the outline was read and counts the runs after it", () => {
    const update = applyRegroup({
      contents: { entries: [entry(1, [1, 2])], state: state(), previousRunEntryIds: [] },
      runLines: lines(5),
      topics: [topic("Start", [1, 2, 99])],
      at: at(59),
    })!;
    assert.deepEqual(update.entries, []);
    assert.deepEqual([update.state.regroupedThrough, update.state.runsSinceRegroup], [2, 3]);
  });
});
