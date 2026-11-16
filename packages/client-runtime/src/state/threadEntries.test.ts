import {
  EnvironmentId,
  MessageId,
  ProjectId,
  RunId,
  type ThreadEntriesUpdate,
  type ThreadEntry,
  ThreadEntryId,
  type ThreadEntryListItem,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  appendEntriesUpdate,
  entriesUndo,
  entryByRunId,
  entryListInputs,
  entryOwedLabel,
  mergeEntryPages,
  openItemTotals,
  resolveThreadEntries,
  stepThreadEntriesRead,
  type ThreadEntriesRead,
} from "./threadEntries.ts";

const threadId = ThreadId.make("thread:a");
const entry = (seq: number, fields: Partial<ThreadEntry> = {}): ThreadEntry => ({
  id: ThreadEntryId.make(`${threadId}:e${seq}`),
  threadId,
  title: `Topic ${seq}`,
  titleSource: "model",
  outcome: "",
  open: [],
  runs: [{ runId: RunId.make(`run:${seq}`), source: "online" }],
  startMessageId: MessageId.make(`start:${seq}`),
  endMessageId: MessageId.make(`end:${seq}`),
  startedAt: `2030-01-01T00:0${seq}:00.000Z`,
  endedAt: `2030-01-01T00:0${seq}:00.000Z`,
  status: "active",
  ...fields,
});
const update = (revision: number, entries: ReadonlyArray<ThreadEntry>): ThreadEntriesUpdate => ({
  entries,
  runLines: [],
  state: {
    revision,
    nextEntrySeq: 9,
    ownerRuns: 1,
    lastRunOrdinal: 1,
    lastReplyAt: null,
    runsSinceRegroup: 0,
    regroupRequestedThrough: 0,
    regroupedThrough: 0,
    regroupedAt: null,
  },
});

describe("resolveThreadEntries", () => {
  const fetched = { entries: [entry(1), entry(2)], revision: 3 };

  it("replays the next revision: upserts, drops retired entries, keeps first-appearance order", () => {
    const renamed = entry(2, { title: "Renamed" });
    expect(
      resolveThreadEntries(fetched, [
        update(2, [entry(9)]),
        update(4, [entry(1, { status: "retired" }), renamed, entry(3)]),
      ]),
    ).toEqual({ entries: [renamed, entry(3)], revision: 4 });
  });

  it("asks for the list again after a gap, and keeps a list newer than every event", () => {
    expect(resolveThreadEntries(fetched, [update(5, [entry(3)])])).toBe("refetch");
    expect(resolveThreadEntries(fetched, [update(3, [entry(3)])])).toBe(fetched);
  });

  describe("stepThreadEntriesRead", () => {
    // Answers by basis; a missing basis is still loading. `asked` records every basis read.
    const reader = (answers: Readonly<Record<string, typeof fetched>>) => {
      const asked: string[] = [];
      return {
        asked,
        answer: (basis: string) => {
          asked.push(basis);
          return answers[basis] ?? null;
        },
      };
    };
    const step = (
      previous: ThreadEntriesRead | null,
      answers: Readonly<Record<string, typeof fetched>>,
      updates: ReadonlyArray<ThreadEntriesUpdate> = [],
      resyncs = 0,
    ) => {
      const read = reader(answers);
      return {
        next: stepThreadEntriesRead(previous, { resyncs, updates, answer: read.answer }),
        asked: read.asked,
      };
    };

    it("opens with one read and replays the events after it", () => {
      const loading = step(null, {});
      expect(loading.asked).toEqual(["0.0"]);
      expect(loading.next.shown).toBeNull();
      const renamed = entry(2, { title: "Renamed" });
      const loaded = step(loading.next, { "0.0": fetched }, [update(4, [renamed])]);
      expect(loaded.asked).toEqual(["0.0"]);
      expect(loaded.next.shown).toEqual({ entries: [entry(1), renamed], revision: 4 });
    });

    it("reads again once after a gap, showing the last list meanwhile", () => {
      const shown = step(null, { "0.0": fetched }).next;
      const gap = step(shown, { "0.0": fetched }, [update(5, [entry(3)])]);
      expect(gap.asked).toEqual(["0.0", "0.1"]);
      expect(gap.next.shown).toBe(fetched);
      // The second answer still misses revision 4: show it rather than read forever.
      const stale = step(gap.next, { "0.0": fetched, "0.1": fetched }, [update(5, [entry(3)])]);
      expect(stale.asked).toEqual(["0.1"]);
      expect(stale.next.shown).toBe(fetched);
      // A later event with a gap earns one more read.
      const later = step(stale.next, { "0.1": fetched }, [update(5, []), update(7, [])]);
      expect(later.asked).toEqual(["0.1", "0.2"]);
    });

    it("reads again after a resync snapshot, keeping the list while it loads", () => {
      const shown = step(null, { "0.0": fetched }).next;
      const resynced = step(shown, { "0.0": fetched }, [], 1);
      expect(resynced.asked).toEqual(["1.0"]);
      expect(resynced.next.shown).toBe(fetched);
    });
  });

  it("keeps the newest updates in revision order, dropping a replayed one", () => {
    const kept = appendEntriesUpdate(
      appendEntriesUpdate(undefined, update(4, []), 40),
      update(5, []),
      50,
    );
    expect(appendEntriesUpdate(kept, update(5, []), 50).map((held) => held.state.revision)).toEqual(
      [4, 5],
    );
    // A regroup request changes only the state, at the same revision: the edit before it stays.
    const edited = appendEntriesUpdate(kept, update(6, [entry(3)]), 60);
    const requested = appendEntriesUpdate(edited, update(6, []), 61);
    expect(requested.map((held) => held.sequence)).toEqual([40, 50, 60, 61]);
    expect(resolveThreadEntries({ entries: [], revision: 5 }, requested)).toEqual({
      entries: [entry(3)],
      revision: 6,
    });
  });
});

describe("hand edits", () => {
  it("files a run under the entry it has no `second` mark in, whatever the list order", () => {
    const shared = RunId.make("run:shared");
    const earlier = entry(1, { runs: [{ runId: shared, source: "online", second: true }] });
    const first = entry(2, { runs: [{ runId: shared, source: "online" }] });
    const byRun = entryByRunId([earlier, first, entry(3)]);
    expect(byRun.get(shared)?.id).toBe(first.id);
    expect(byRun.get(RunId.make("run:3"))?.id).toBe(entry(3).id);
  });

  it("undoes an edit from the entries shown before it, once its own event is in", () => {
    const before = { entries: [entry(1), entry(2)], revision: 4 };
    const merged = { ...update(5, [entry(1, { status: "retired" }), entry(2)]), sequence: 70 };
    expect(entriesUndo(before, [], 70)).toEqual({ kind: "waiting" });
    expect(entriesUndo(before, [merged], 70)).toEqual({
      kind: "ready",
      entries: [entry(1), entry(2)],
      expectRevision: 5,
    });
    // A new topic has no copy to put back; the server retires it.
    const moved = { ...update(5, [entry(2), entry(4)]), sequence: 70 };
    expect(entriesUndo(before, [moved], 70)).toMatchObject({ entries: [entry(2)] });
    // Something else landed between the read and the edit.
    expect(entriesUndo({ ...before, revision: 3 }, [merged], 70)).toEqual({ kind: "none" });
  });
});

describe("History lists", () => {
  const local = EnvironmentId.make("environment:local");
  const remote = EnvironmentId.make("environment:remote");
  const row = (id: string, endedAt: string): ThreadEntryListItem => ({
    id: ThreadEntryId.make(id),
    threadId,
    projectId: ProjectId.make("project:a"),
    title: id,
    outcome: "",
    open: [],
    startMessageId: MessageId.make("start"),
    endMessageId: MessageId.make("end"),
    startedAt: endedAt,
    endedAt,
    threadTitle: "Thread",
    threadSettled: false,
  });

  it("merges environments newest first, holding back rows below one that has more to load", () => {
    const merged = mergeEntryPages([
      {
        environmentId: local,
        pages: [
          {
            entries: [row("a", "2030-01-01T00:09:00Z"), row("b", "2030-01-01T00:05:00Z")],
            next: { endedAt: "2030-01-01T00:05:00Z", entryId: ThreadEntryId.make("b") },
          },
          // `b` moved up between pages; it is listed once.
          { entries: [row("b", "2030-01-01T00:05:00Z")], next: null },
        ],
      },
      {
        environmentId: remote,
        pages: [
          {
            entries: [row("c", "2030-01-01T00:07:00Z"), row("d", "2030-01-01T00:01:00Z")],
            next: { endedAt: "2030-01-01T00:01:00Z", entryId: ThreadEntryId.make("d") },
          },
        ],
      },
    ]);
    expect(merged.rows.map((entry) => entry.id)).toEqual(["a", "c", "b", "d"]);
    expect(merged.hasMore).toBe(true);
    const held = mergeEntryPages([
      {
        environmentId: local,
        pages: [
          {
            entries: [row("a", "2030-01-01T00:09:00Z")],
            next: { endedAt: "2030-01-01T00:09:00Z", entryId: ThreadEntryId.make("a") },
          },
        ],
      },
      {
        environmentId: remote,
        pages: [{ entries: [row("c", "2030-01-01T00:07:00Z")], next: null }],
      },
    ]);
    expect(held.rows.map((entry) => entry.id)).toEqual(["a"]);
  });

  it("counts open items in scope the way the History chip and the Focus row both show them", () => {
    const counts = (ship: number, commit: number) => ({
      projects: [
        {
          projectId: ProjectId.make("project:a"),
          counts: { ask: 0, verify: 1, commit, ship, followup: 0 },
          lastPublishedAt: null,
        },
        {
          projectId: ProjectId.make("project:b"),
          counts: { ask: 2, verify: 0, commit: 0, ship: 0, followup: 0 },
          lastPublishedAt: null,
        },
      ],
    });
    const all = [
      { environmentId: local, result: counts(4, 1) },
      { environmentId: remote, result: counts(1, 0) },
    ];
    expect(
      openItemTotals(all, [{ environmentId: local, projectId: ProjectId.make("project:a") }]),
    ).toEqual({ total: 6, ship: 4, summary: "4 waiting on a publish, 1 to commit, 1 to check" });
    expect(openItemTotals(all, null).total).toBe(12);
  });

  it("asks each environment for the group's projects there, and skips one holding none", () => {
    const projectA = ProjectId.make("project:a");
    expect(
      entryListInputs({
        environmentIds: [local, remote],
        members: [{ environmentId: local, projectId: projectA }],
        stillOpen: true,
        query: "  login ",
      }),
    ).toEqual([
      { environmentId: local, input: { projectIds: [projectA], stillOpen: true, query: "login" } },
    ]);
    expect(
      entryListInputs({ environmentIds: [local], members: null, stillOpen: false, query: " " }),
    ).toEqual([{ environmentId: local, input: {} }]);
  });

  it("labels what an entry owes, questions included, at most two", () => {
    expect(
      entryOwedLabel([{ kind: "ship" }, { kind: "ask" }, { kind: "ship" }, { kind: "commit" }]),
    ).toBe("Publish, Question");
    expect(entryOwedLabel([])).toBeNull();
  });
});
