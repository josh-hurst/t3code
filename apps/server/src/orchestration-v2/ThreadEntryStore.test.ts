import { assert, describe, it } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  RunId,
  type ThreadContentsState,
  type ThreadEntry,
  ThreadEntryId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import { THREAD_REGROUP_MIN_OWNER_RUNS } from "./ThreadRegroup.ts";

const layer = ThreadEntryStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const at = (minute: number) => `2030-03-03T12:${String(minute).padStart(2, "0")}:00.000Z`;
const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");

const state = (fields: Partial<ThreadContentsState> = {}): ThreadContentsState => ({
  revision: 1,
  nextEntrySeq: 5,
  ownerRuns: 1,
  lastRunOrdinal: 1,
  lastReplyAt: at(0),
  runsSinceRegroup: 1,
  regroupRequestedThrough: 0,
  regroupedThrough: 0,
  regroupedAt: null,
  ...fields,
});

const seedThread = Effect.fn("test.seedThread")(function* (input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly settled?: boolean;
  readonly deleted?: boolean;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
      interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at,
      deleted_at, payload_json
    ) VALUES (
      ${input.threadId}, ${input.projectId}, ${`Title of ${input.threadId}`}, 'codex', 'codex',
      'full-access', 'default', NULL, ${at(0)}, ${at(0)}, NULL,
      ${input.deleted ? at(1) : null},
      ${JSON.stringify({ settledAt: input.settled ? at(1) : null })}
    )`;
});

const seedEntries = Effect.fn("test.seedEntries")(function* (
  threadId: ThreadId,
  entries: ReadonlyArray<Partial<ThreadEntry> & { readonly seq: number }>,
  contents: ThreadContentsState = state(),
) {
  const sql = yield* SqlClient.SqlClient;
  yield* ThreadEntryStore.applyEntriesUpdated(sql, {
    threadId,
    payload: {
      entries: entries.map(({ seq, ...entry }) => ({
        id: ThreadEntryId.make(`${threadId}:e${seq}`),
        threadId,
        title: `Topic ${seq}`,
        titleSource: "model",
        outcome: `Outcome ${seq}`,
        open: [],
        runs: [{ runId: RunId.make(`${threadId}:run:${seq}`), source: "online" }],
        startMessageId: MessageId.make("message:start"),
        endMessageId: MessageId.make("message:end"),
        startedAt: at(0),
        endedAt: at(0),
        status: "active",
        ...entry,
      })),
      runLines: [],
      state: contents,
    },
  });
});

const store = ThreadEntryStore.ThreadEntryStore;

describe("ThreadEntryStore", () => {
  it.effect("pages active entries of live threads newest first, stable across equal times", () =>
    Effect.gen(function* () {
      const one = ThreadId.make("thread:one");
      const gone = ThreadId.make("thread:gone");
      yield* seedThread({ threadId: one, projectId: projectA });
      yield* seedThread({ threadId: gone, projectId: projectA, deleted: true });
      yield* seedEntries(one, [
        { seq: 1, endedAt: at(5) },
        { seq: 2, endedAt: at(5) },
        { seq: 3, endedAt: at(5) },
        { seq: 4, endedAt: at(9) },
        { seq: 5, endedAt: at(9), status: "retired" },
      ]);
      yield* seedEntries(gone, [{ seq: 1, endedAt: at(30) }]);

      const pages: Array<ReadonlyArray<string>> = [];
      let before = undefined as Parameters<
        ThreadEntryStore.ThreadEntryStore["Service"]["list"]
      >[0]["before"];
      for (;;) {
        const page = yield* store.use((entries) =>
          entries.list({ limit: 2, ...(before === undefined ? {} : { before }) }),
        );
        pages.push(page.entries.map((entry) => entry.title));
        if (page.next === null) break;
        before = page.next;
      }
      assert.deepEqual(pages, [
        ["Topic 4", "Topic 1"],
        ["Topic 2", "Topic 3"],
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("filters by project, still open and search words through the thread join", () =>
    Effect.gen(function* () {
      const a = ThreadId.make("thread:a");
      const b = ThreadId.make("thread:b");
      yield* seedThread({ threadId: a, projectId: projectA, settled: true });
      yield* seedThread({ threadId: b, projectId: projectB });
      const open = [
        { kind: "commit" as const, text: "Uncommitted", runId: RunId.make("run:a") },
        { kind: "ship" as const, text: "Publish it", runId: RunId.make("run:a") },
      ];
      yield* seedEntries(a, [
        { seq: 1, title: "Billing webhook retries", outcome: "Backoff added", open },
        { seq: 2, title: "Search reindex", outcome: "Done" },
      ]);
      yield* seedEntries(b, [
        { seq: 1, title: "Dark mode", open: [{ ...open[0]!, runId: RunId.make("run:b") }] },
      ]);
      const titles = (input: Parameters<ThreadEntryStore.ThreadEntryStore["Service"]["list"]>[0]) =>
        store.use((entries) =>
          entries.list(input).pipe(Effect.map((page) => page.entries.map((entry) => entry.title))),
        );

      assert.sameMembers(yield* titles({ projectIds: [projectA] }), [
        "Billing webhook retries",
        "Search reindex",
      ]);
      assert.sameMembers(yield* titles({ stillOpen: true }), [
        "Billing webhook retries",
        "Dark mode",
      ]);
      assert.deepEqual(yield* titles({ openKind: "ship" }), ["Billing webhook retries"]);
      assert.deepEqual(yield* titles({ query: "WEBHOOK backoff" }), ["Billing webhook retries"]);
      assert.deepEqual(yield* titles({ query: "webhook dark" }), []);
      const [row] = (yield* store.use((entries) => entries.list({ query: "billing" }))).entries;
      assert.deepEqual(
        [row?.projectId, row?.threadTitle, row?.threadSettled, row?.open.length],
        [projectA, "Title of thread:a", true, 2],
      );

      assert.deepEqual(yield* store.use((entries) => entries.counts()), [
        { projectId: projectA, counts: { ask: 0, verify: 0, commit: 1, ship: 1, followup: 0 } },
        { projectId: projectB, counts: { ask: 0, verify: 0, commit: 1, ship: 0, followup: 0 } },
      ]);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("finds long threads idle for ten minutes with runs not yet regrouped", () =>
    Effect.gen(function* () {
      // The query repeats the partial index's literal; it must agree with the constant.
      const ownerRuns = THREAD_REGROUP_MIN_OWNER_RUNS;
      const cases: ReadonlyArray<readonly [string, Partial<ThreadContentsState>, boolean]> = [
        ["due", { ownerRuns, lastRunOrdinal: 12, lastReplyAt: at(0) }, true],
        ["too-short", { ownerRuns: ownerRuns - 1, lastRunOrdinal: 12, lastReplyAt: at(0) }, false],
        ["recent", { ownerRuns, lastRunOrdinal: 12, lastReplyAt: at(55) }, false],
        ["recent-later", { ownerRuns, lastRunOrdinal: 12, lastReplyAt: at(58) }, false],
        ["requested", { ownerRuns, lastRunOrdinal: 12, regroupRequestedThrough: 12 }, false],
        ["regrouped", { ownerRuns, lastRunOrdinal: 12, runsSinceRegroup: 0 }, false],
      ];
      for (const [name, fields] of cases) {
        yield* seedEntries(ThreadId.make(`thread:${name}`), [], state(fields));
      }
      const now = DateTime.makeUnsafe(Date.parse("2030-03-03T13:00:00.000Z"));
      const due = yield* store.use((entries) => entries.regroupCandidates(now));
      assert.deepEqual(
        due.map((candidate) => [candidate.threadId, candidate.state.ownerRuns]),
        cases.filter(([, , expected]) => expected).map(([name]) => [`thread:${name}`, ownerRuns]),
      );
      const idleAt = yield* store.use((entries) => entries.regroupIdleAt(now));
      assert.strictEqual(idleAt === null ? null : DateTime.formatIso(idleAt), at(55));
    }).pipe(Effect.provide(layer)),
  );
});
