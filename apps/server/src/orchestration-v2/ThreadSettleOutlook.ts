import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const HOUR_MS = 60 * 60 * 1_000;

/** At or below this chance of the owner writing again, clients list the thread as settling. */
export const SETTLE_OUTLOOK_LIST_BELOW = 0.15;
export const SETTLE_OUTLOOK_LIST_AFTER_MS = 15 * 60 * 1_000;
/** At or below this chance the thread settles; about 1 such close in 30 was written in again. */
export const SETTLE_OUTLOOK_SETTLE_BELOW = 0.04;
export const SETTLE_OUTLOOK_SETTLE_AFTER_MS = 2 * HOUR_MS;
/** Older activity is not read; a thread quiet for longer only looks a little likelier to return. */
export const SETTLE_OUTLOOK_LOOKBACK_MS = 72 * HOUR_MS;

/**
 * A logistic score fitted to a month of one owner's threads (1,777 quiet points). What the owner
 * did elsewhere since the reply predicts a return better than the wait alone; the reply's text, a
 * model's reading of it and message embeddings added nothing. Inputs are log1p of hours or counts.
 */
const WEIGHTS = {
  intercept: -1.1623,
  waitHours: -0.3804,
  ageHours: 0.312,
  turns: 0.4296,
  elsewhere: -0.3622,
  started: -0.4251,
  published: -0.6915,
} as const;

const SettleOutlookSignals = Schema.Struct({
  /** Hours the thread has been quiet. */
  waitHours: Schema.Finite,
  /** Hours from the thread's creation to when it went quiet. */
  ageHours: Schema.Finite,
  /** Messages the owner wrote in the thread. */
  turns: Schema.Finite,
  /** Messages the owner wrote in the project's other threads since. */
  elsewhere: Schema.Finite,
  /** Threads the owner started since, in any project. */
  started: Schema.Finite,
  /** A publish in the project since. */
  published: Schema.Boolean,
});
export type SettleOutlookSignals = typeof SettleOutlookSignals.Type;
const encodeSignals = Schema.encodeSync(Schema.fromJsonString(SettleOutlookSignals));
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

/** What the owner did since `sinceMs`, read once per sweep and counted per thread. */
export interface SettleOutlookActivity {
  readonly messages: ReadonlyArray<{
    readonly threadId: string;
    readonly projectId: string;
    readonly atMs: number;
    readonly startsThread: boolean;
  }>;
  readonly publishes: ReadonlyArray<{ readonly projectId: string; readonly atMs: number }>;
  readonly turns: ReadonlyMap<string, number>;
}

/** Null for a thread the activity was not read for. */
export function settleOutlookSignals(
  activity: SettleOutlookActivity,
  thread: {
    readonly id: string;
    readonly projectId: string;
    readonly quietAtMs: number;
    readonly ageMs: number;
    readonly nowMs: number;
  },
): SettleOutlookSignals | null {
  const turns = activity.turns.get(thread.id);
  if (turns === undefined) return null;
  let elsewhere = 0;
  let started = 0;
  for (const message of activity.messages) {
    if (message.atMs <= thread.quietAtMs || message.threadId === thread.id) continue;
    if (message.projectId === thread.projectId) elsewhere += 1;
    if (message.startsThread) started += 1;
  }
  return {
    waitHours: Math.max(0, thread.nowMs - thread.quietAtMs) / HOUR_MS,
    ageHours: Math.max(0, thread.ageMs) / HOUR_MS,
    turns,
    elsewhere,
    started,
    published: activity.publishes.some(
      (publish) => publish.projectId === thread.projectId && publish.atMs > thread.quietAtMs,
    ),
  };
}

/** The chance, 0 to 1, that the owner writes in the thread again. */
export function settleOutlookReturnChance(signals: SettleOutlookSignals): number {
  const score =
    WEIGHTS.intercept +
    WEIGHTS.waitHours * Math.log1p(signals.waitHours) +
    WEIGHTS.ageHours * Math.log1p(signals.ageHours) +
    WEIGHTS.turns * Math.log1p(signals.turns) +
    WEIGHTS.elsewhere * Math.log1p(signals.elsewhere) +
    WEIGHTS.started * Math.log1p(signals.started) +
    (signals.published ? WEIGHTS.published : 0);
  return 1 / (1 + Math.exp(-score));
}

export class ThreadSettleOutlookError extends Schema.TaggedError<ThreadSettleOutlookError>()(
  "ThreadSettleOutlookError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Settle outlook operation '${this.operation}' failed.`;
  }
}

export interface SettleOutlookRecord {
  readonly threadId: ThreadId;
  readonly quietAtMs: number;
  readonly atMs: number;
  readonly chance: number;
  readonly signals: SettleOutlookSignals;
  /** False when the thread was listed, true when it settled on the score. */
  readonly settled: boolean;
}

export class ThreadSettleOutlookStore extends Context.Service<
  ThreadSettleOutlookStore,
  {
    readonly activity: (input: {
      readonly threadIds: ReadonlyArray<ThreadId>;
      readonly sinceMs: number;
    }) => Effect.Effect<SettleOutlookActivity, ThreadSettleOutlookError>;
    /** Keeps the first listing of a quiet stretch and the settle that ended it. */
    readonly record: (input: SettleOutlookRecord) => Effect.Effect<void, ThreadSettleOutlookError>;
  }
>()("t3/orchestration-v2/ThreadSettleOutlook/ThreadSettleOutlookStore") {}

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failed = (operation: string) => (cause: unknown) =>
    new ThreadSettleOutlookError({ operation, cause });
  // The messages the settlement candidates count as the owner writing.
  const ownerWrote = (alias: string) => {
    const payload = sql.literal(`${alias}.payload_json`);
    return sql`(
      ${sql.literal(`${alias}.role`)} = 'user'
      AND json_extract(${payload}, '$.createdBy') = 'user'
      AND json_extract(${payload}, '$.scheduledTaskId') IS NULL
      AND json_extract(${payload}, '$.idleCompaction') IS NULL
    )`;
  };

  const activity: ThreadSettleOutlookStore["Service"]["activity"] = Effect.fn(
    "ThreadSettleOutlookStore.activity",
  )(
    function* (input) {
      const since = iso(input.sinceMs);
      const messages = yield* sql<{
        readonly threadId: string;
        readonly projectId: ProjectId;
        readonly at: string;
        readonly startsThread: number;
      }>`
        SELECT message.thread_id AS "threadId", thread.project_id AS "projectId",
          message.updated_at AS "at",
          NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_messages earlier
            WHERE earlier.thread_id = message.thread_id
              AND earlier.updated_at < message.updated_at
              AND ${ownerWrote("earlier")}
          ) AS "startsThread"
        FROM orchestration_v2_projection_messages message
        JOIN orchestration_v2_projection_threads thread ON thread.thread_id = message.thread_id
        WHERE message.updated_at > ${since} AND ${ownerWrote("message")}
      `;
      const turns = yield* sql<{ readonly threadId: string; readonly turns: number }>`
        SELECT message.thread_id AS "threadId", COUNT(*) AS turns
        FROM orchestration_v2_projection_messages message
        WHERE message.thread_id IN (SELECT value FROM json_each(${encodeIds(input.threadIds)}))
          AND ${ownerWrote("message")}
        GROUP BY message.thread_id
      `;
      const publishes = yield* sql<{ readonly projectId: ProjectId; readonly at: string }>`
        SELECT project_id AS "projectId", published_at AS "at"
        FROM tide_publish_markers
        WHERE undone_at IS NULL AND published_at > ${since}
      `;
      return {
        messages: messages.map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          atMs: Date.parse(row.at),
          startsThread: row.startsThread === 1,
        })),
        publishes: publishes.map((row) => ({ projectId: row.projectId, atMs: Date.parse(row.at) })),
        turns: new Map(turns.map((row) => [row.threadId, row.turns])),
      };
    },
    Effect.mapError(failed("activity")),
    NodeSqliteClient.readOnly,
  );

  const record: ThreadSettleOutlookStore["Service"]["record"] = Effect.fn(
    "ThreadSettleOutlookStore.record",
  )(
    function* (input) {
      const at = iso(input.atMs);
      const signals = encodeSignals(input.signals);
      const settled = input.settled ? { at, chance: input.chance, signals } : null;
      yield* sql`
      INSERT INTO tide_settle_outlook (
        thread_id, quiet_at, listed_at, listed_chance, listed_signals_json,
        settled_at, settled_chance, settled_signals_json
      ) VALUES (
        ${input.threadId}, ${iso(input.quietAtMs)}, ${at}, ${input.chance}, ${signals},
        ${settled?.at ?? null}, ${settled?.chance ?? null}, ${settled?.signals ?? null}
      )
      ON CONFLICT (thread_id, quiet_at) DO UPDATE SET
        settled_at = excluded.settled_at,
        settled_chance = excluded.settled_chance,
        settled_signals_json = excluded.settled_signals_json
      WHERE excluded.settled_at IS NOT NULL
    `;
    },
    Effect.mapError(failed("record")),
  );

  return { activity, record } satisfies ThreadSettleOutlookStore["Service"];
});

export const layer = Layer.effect(ThreadSettleOutlookStore, make);
