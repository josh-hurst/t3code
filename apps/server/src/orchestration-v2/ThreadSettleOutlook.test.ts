import { assert, describe, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ThreadSettleOutlook from "./ThreadSettleOutlook.ts";

const layer = ThreadSettleOutlook.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
const at = (minute: number) => `2030-03-03T12:${String(minute).padStart(2, "0")}:00.000Z`;
const quiet = ThreadId.make("quiet");
const projectA = ProjectId.make("project:a");
const projectB = ProjectId.make("project:b");

const seedThread = Effect.fn("test.seedThread")(function* (
  threadId: string,
  projectId: ProjectId,
  messages: ReadonlyArray<{ readonly minute: number; readonly payload?: object }>,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, provider_instance_id, runtime_mode,
      interaction_mode, active_provider_thread_id, created_at, updated_at, archived_at,
      deleted_at, payload_json
    ) VALUES (
      ${threadId}, ${projectId}, 'Thread', 'codex', 'codex', 'full-access', 'default', NULL,
      ${at(0)}, ${at(0)}, NULL, NULL, '{}'
    )`;
  for (const [index, message] of messages.entries()) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_messages (
        message_id, thread_id, run_id, node_id, role, streaming, created_at, updated_at,
        payload_json
      ) VALUES (
        ${`${threadId}:${index}`}, ${threadId}, NULL, NULL, 'user', 0, ${at(message.minute)},
        ${at(message.minute)}, ${JSON.stringify({ createdBy: "user", text: "Hi", ...message.payload })}
      )`;
  }
});

describe("ThreadSettleOutlook", () => {
  it("scores the chance the owner writes again from what they did elsewhere", () => {
    const chance = (
      waitHours: number,
      ageHours: number,
      turns: number,
      elsewhere: number,
      published = false,
    ) =>
      Number(
        ThreadSettleOutlook.settleOutlookReturnChance({
          waitHours,
          ageHours,
          turns,
          elsewhere,
          published,
        }).toFixed(3),
      );
    // A quick question half an hour on: the owner busy elsewhere, then not.
    assert.equal(chance(0.5, 0.1, 1, 6), 0.108);
    assert.equal(chance(0.5, 0.1, 1, 0), 0.239);
    // A long thread stays likelier to be written in again, even after a publish.
    assert.equal(chance(4, 3, 12, 12, true), 0.073);
    // Quiet for the projected wait, the thread is exactly at the requested cutoff.
    const signals = {
      waitHours: 0.5,
      ageHours: 0.1,
      turns: 1,
      elsewhere: 6,
      published: false,
    };
    const waitHours =
      ThreadSettleOutlook.settleOutlookSettleWaitMs(
        signals,
        ThreadSettleOutlook.SETTLE_OUTLOOK_LATE_BELOW,
      ) / 3_600_000;
    assert.closeTo(waitHours, 2.06, 0.05);
    assert.closeTo(
      ThreadSettleOutlook.settleOutlookReturnChance({ ...signals, waitHours }),
      ThreadSettleOutlook.SETTLE_OUTLOOK_LATE_BELOW,
      1e-6,
    );
  });

  const HOUR_MS = 60 * 60 * 1_000;
  const messages = (count: number, atMs: number) =>
    Array.from({ length: count }, (_, index) => ({
      threadId: `other-${index}`,
      projectId: projectA,
      atMs,
    }));

  it.each([
    {
      name: "passes the 3h first look when busy in the project before 3h",
      // 10 messages at 1h -> 8.8% at 3h (<= 9.5%), settles at 3h.
      activity: { messages: messages(10, HOUR_MS), publishes: [], turns: new Map([[quiet, 1]]) },
      ageMs: 0.5 * HOUR_MS,
      nowMs: 6 * HOUR_MS,
      expected: 3 * HOUR_MS,
    },
    {
      name: "misses the first look with no project work since even when chance is low",
      // 0m old, no project work: 6.5% at 3h (<= 9.5%) but requires work in the project; 1% wait is
      // 70.3h (>= 24h) and 7% wait is 2.5h -> clamped to 24h.
      activity: { messages: [], publishes: [], turns: new Map([[quiet, 1]]) },
      ageMs: 0,
      nowMs: 6 * HOUR_MS,
      expected: 24 * HOUR_MS,
    },
    {
      name: "misses the first look past 10 turns even when chance is low",
      // 11 turns with 10 messages + publish at 1h: 8.2% at 3h (<= 9.5%) but > 10 turns; 1% wait is
      // 103.4h (>= 24h) and 7% wait is 4.2h -> clamped to 24h.
      activity: {
        messages: messages(10, HOUR_MS),
        publishes: [{ projectId: projectA, atMs: HOUR_MS }],
        turns: new Map([[quiet, 11]]),
      },
      ageMs: 0.5 * HOUR_MS,
      nowMs: 6 * HOUR_MS,
      expected: 24 * HOUR_MS,
    },
    {
      name: "ignores messages written after 3h when judging the first look",
      // 10 messages at 4h: no project work and 23.8% at 3h (fails first look); 1% wait is 116.5h
      // (>= 24h) and 7% wait is 4.8h -> clamped to 24h.
      activity: {
        messages: messages(10, 4 * HOUR_MS),
        publishes: [],
        turns: new Map([[quiet, 1]]),
      },
      ageMs: 0.5 * HOUR_MS,
      nowMs: 6 * HOUR_MS,
      expected: 24 * HOUR_MS,
    },
    {
      name: "reaches the 1% between-bar before 24h when heavy activity arrives after 3h",
      // Fails first look at 3h (no project work, 23.8%); 30 messages + publish at 4h bring the 1%
      // wait to 18.86h (< 24h).
      activity: {
        messages: messages(30, 4 * HOUR_MS),
        publishes: [{ projectId: projectA, atMs: 4 * HOUR_MS }],
        turns: new Map([[quiet, 1]]),
      },
      ageMs: 0.5 * HOUR_MS,
      nowMs: 6 * HOUR_MS,
      expected: ThreadSettleOutlook.settleOutlookSettleWaitMs(
        { waitHours: 6, ageHours: 0.5, turns: 1, elsewhere: 30, published: true },
        ThreadSettleOutlook.SETTLE_OUTLOOK_BETWEEN_BELOW,
      ),
    },
    {
      name: "waits past 24h when the 7% late bar is reached after a day",
      // 3h old, 12 turns, no activity: 38.7% at 3h, 7% wait is 95.0h (> 24h).
      activity: { messages: [], publishes: [], turns: new Map([[quiet, 12]]) },
      ageMs: 3 * HOUR_MS,
      nowMs: 6 * HOUR_MS,
      expected: ThreadSettleOutlook.settleOutlookSettleWaitMs(
        { waitHours: 6, ageHours: 3, turns: 12, elsewhere: 0, published: false },
        ThreadSettleOutlook.SETTLE_OUTLOOK_LATE_BELOW,
      ),
    },
    {
      name: "leaves threads past 16 turns to the window when nothing published since",
      activity: { messages: messages(20, HOUR_MS), publishes: [], turns: new Map([[quiet, 17]]) },
      ageMs: 0.5 * HOUR_MS,
      nowMs: 6 * HOUR_MS,
      expected: null,
    },
    {
      name: "still scores threads past 16 turns after a publish",
      // Misses first look (17 > 10); published unlocks scoring, 1% wait is 117.3h, 7% wait is 4.9h
      // -> clamped to 24h.
      activity: {
        messages: messages(20, HOUR_MS),
        publishes: [{ projectId: projectA, atMs: HOUR_MS }],
        turns: new Map([[quiet, 17]]),
      },
      ageMs: 0.5 * HOUR_MS,
      nowMs: 6 * HOUR_MS,
      expected: 24 * HOUR_MS,
    },
    {
      name: "returns null when the thread is missing from activity.turns",
      activity: { messages: messages(10, HOUR_MS), publishes: [], turns: new Map() },
      ageMs: 0.5 * HOUR_MS,
      nowMs: 6 * HOUR_MS,
      expected: null,
    },
  ])("settleOutlookSettleAfterMs: $name", ({ activity, ageMs, nowMs, expected }) => {
    assert.strictEqual(
      ThreadSettleOutlook.settleOutlookSettleAfterMs(activity, {
        id: quiet,
        projectId: projectA,
        quietAtMs: 0,
        ageMs,
        nowMs,
      }),
      expected,
    );
  });

  it.layer(layer)("reads the owner's activity and keeps one record per quiet stretch", (it) => {
    it.effect("counts", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const store = yield* ThreadSettleOutlook.ThreadSettleOutlookStore;
        yield* seedThread(quiet, projectA, [
          { minute: 1 },
          { minute: 2 },
          // Not the owner writing: an agent's message, a schedule's and an idle compaction.
          { minute: 3, payload: { createdBy: "agent" } },
          { minute: 4, payload: { scheduledTaskId: "task" } },
          { minute: 5, payload: { idleCompaction: {} } },
        ]);
        yield* seedThread("started-since", projectA, [{ minute: 20 }, { minute: 21 }]);
        yield* seedThread("older", projectB, [{ minute: 3 }, { minute: 22 }]);
        for (const [id, project, minute, undone] of [
          ["before", projectA, 4, null],
          ["since", projectA, 23, null],
          ["undone", projectB, 24, at(25)],
        ] as const) {
          yield* sql`
            INSERT INTO tide_publish_markers (
              marker_id, project_id, published_at, source_thread_id, cleared_json, undone_at
            ) VALUES (${id}, ${project}, ${at(minute)}, NULL, '[]', ${undone})`;
        }

        const activity = yield* store.activity({
          threadIds: [quiet],
          sinceMs: Date.parse(at(10)),
        });
        assert.deepEqual(
          activity.messages
            .map((message) => `${message.threadId} ${message.projectId} ${message.atMs}`)
            .sort(),
          [
            `older ${projectB} ${Date.parse(at(22))}`,
            `started-since ${projectA} ${Date.parse(at(20))}`,
            `started-since ${projectA} ${Date.parse(at(21))}`,
          ],
        );
        assert.deepEqual([...activity.turns], [[quiet, 2]]);
        const signals = ThreadSettleOutlook.settleOutlookSignals(activity, {
          id: quiet,
          projectId: projectA,
          quietAtMs: Date.parse(at(10)),
          ageMs: 10 * 60_000,
          nowMs: Date.parse(at(40)),
        });
        assert.deepEqual(signals, {
          waitHours: 0.5,
          ageHours: 10 / 60,
          turns: 2,
          elsewhere: 2,
          published: true,
        });
        assert.isNull(
          ThreadSettleOutlook.settleOutlookSignals(activity, {
            id: "uncounted",
            projectId: projectA,
            quietAtMs: 0,
            ageMs: 0,
            nowMs: 0,
          }),
        );

        const record = (minute: number, chance: number, settled: boolean) =>
          store.record({
            threadId: quiet,
            quietAtMs: Date.parse(at(10)),
            atMs: Date.parse(at(minute)),
            chance,
            signals: signals!,
            settled,
          });
        yield* record(30, 0.12, false);
        yield* record(31, 0.11, false);
        yield* record(50, 0.03, true);
        const rows = yield* sql`
          SELECT listed_at, listed_chance, settled_at, settled_chance FROM tide_settle_outlook`;
        assert.deepEqual(rows, [
          { listed_at: at(30), listed_chance: 0.12, settled_at: at(50), settled_chance: 0.03 },
        ]);
      }),
    );
  });
});
