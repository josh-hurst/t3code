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
      started: number,
      published = false,
    ) =>
      Number(
        ThreadSettleOutlook.settleOutlookReturnChance({
          waitHours,
          ageHours,
          turns,
          elsewhere,
          started,
          published,
        }).toFixed(3),
      );
    // A quick question half an hour on: the owner busy elsewhere, then not.
    assert.equal(chance(0.5, 0.1, 1, 6, 2), 0.103);
    assert.equal(chance(0.5, 0.1, 1, 0, 0), 0.271);
    // A long thread stays likelier to be written in again, even after a publish.
    assert.equal(chance(4, 3, 12, 12, 4, true), 0.073);
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
            .map((message) => `${message.threadId} ${message.atMs} ${message.startsThread}`)
            .sort(),
          [
            `older ${Date.parse(at(22))} false`,
            `started-since ${Date.parse(at(20))} true`,
            `started-since ${Date.parse(at(21))} false`,
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
          started: 1,
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
