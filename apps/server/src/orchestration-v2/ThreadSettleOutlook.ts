import type { ProjectId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

const HOUR_MS = 60 * 60 * 1_000;

/**
 * Clients list a thread as settling once the score plans to settle it this soon. A low chance
 * alone listed threads hours early, and about one in eight of those was written in again.
 */
export const SETTLE_OUTLOOK_LIST_LEAD_MS = 30 * 60 * 1_000;
// A thread settled the moment its chance drifts under one bar carries about that bar's risk; the
// batch already under the bar at one first look is much safer.
/** When the score first evaluates a quiet thread. */
const SETTLE_OUTLOOK_FIRST_LOOK_MS = 1.5 * HOUR_MS;
/** At or below this chance at the first look, the thread settles. */
const SETTLE_OUTLOOK_FIRST_LOOK_BELOW = 0.14;
/** Threads longer than this wait past the first look. */
const SETTLE_OUTLOOK_FIRST_LOOK_MAX_TURNS = 10;
/** At or below this chance between the first look and a day quiet, the thread settles. */
export const SETTLE_OUTLOOK_BETWEEN_BELOW = 0.01;
/** A thread still quiet after this settles: under 1% are written in again within two days. */
const SETTLE_OUTLOOK_LATE_MS = 24 * HOUR_MS;
/** Older activity is not read; a thread quiet for longer only looks a little likelier to return. */
export const SETTLE_OUTLOOK_LOOKBACK_MS = 72 * HOUR_MS;

const AGE_CAP_MINUTES = 60;
const TURNS_FREE = 8;

/**
 * Fitted to a month of one owner's threads; a return over two days on is a new need, not a wrong
 * settle. Risk changes over a thread's first hour and climbs past about eight messages. Only work
 * in the thread's own project counts: the owner leaves a project and comes back.
 */
const WEIGHTS = {
  intercept: -1.5866,
  waitHours: -0.754,
  ageHours: 0.3482,
  turns: 0.4047,
  elsewhere: -0.4661,
  published: -0.6687,
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
  const elsewhere = activity.messages.filter(
    (message) =>
      message.projectId === thread.projectId &&
      message.threadId !== thread.id &&
      message.atMs > thread.quietAtMs &&
      message.atMs <= thread.nowMs,
  ).length;
  return {
    waitHours: Math.max(0, thread.nowMs - thread.quietAtMs) / HOUR_MS,
    ageHours: Math.max(0, thread.ageMs) / HOUR_MS,
    turns,
    elsewhere,
    published: activity.publishes.some(
      (publish) =>
        publish.projectId === thread.projectId &&
        publish.atMs > thread.quietAtMs &&
        publish.atMs <= thread.nowMs,
    ),
  };
}

const score = (signals: SettleOutlookSignals) =>
  WEIGHTS.intercept +
  WEIGHTS.waitHours * Math.log1p(signals.waitHours) +
  WEIGHTS.ageHours * Math.log1p(Math.min(signals.ageHours * 60, AGE_CAP_MINUTES)) +
  WEIGHTS.turns * Math.log1p(Math.max(signals.turns - TURNS_FREE, 0)) +
  WEIGHTS.elsewhere * Math.log1p(signals.elsewhere) +
  (signals.published ? WEIGHTS.published : 0);

/** The chance, 0 to 1, that the owner writes in the thread again. */
export function settleOutlookReturnChance(signals: SettleOutlookSignals): number {
  return 1 / (1 + Math.exp(-score(signals)));
}

/**
 * How long the thread must be quiet for its chance to reach `below` if the owner does nothing more
 * elsewhere. What they do elsewhere only shortens it.
 */
export function settleOutlookSettleWaitMs(signals: SettleOutlookSignals, below: number): number {
  const cutoff = Math.log(below / (1 - below));
  const hours = Math.expm1(
    Math.max(0, (cutoff - score({ ...signals, waitHours: 0 })) / WEIGHTS.waitHours),
  );
  return Math.round(hours * HOUR_MS);
}

/**
 * How long after going quiet the score settles the thread if nothing more happens, or null when
 * the activity was not read for it or the score leaves it to the owner's window.
 */
export function settleOutlookSettleAfterMs(
  activity: SettleOutlookActivity,
  thread: {
    readonly id: string;
    readonly projectId: string;
    readonly quietAtMs: number;
    readonly ageMs: number;
    readonly nowMs: number;
  },
): number | null {
  const firstLookSignals = settleOutlookSignals(activity, {
    ...thread,
    nowMs: Math.min(thread.nowMs, thread.quietAtMs + SETTLE_OUTLOOK_FIRST_LOOK_MS),
  });
  if (firstLookSignals === null) return null;
  const atFirstLook = {
    ...firstLookSignals,
    waitHours: SETTLE_OUTLOOK_FIRST_LOOK_MS / HOUR_MS,
  };
  // A thread with no work in its project since, or a long one, waits: the owner may just be away.
  if (
    (atFirstLook.elsewhere >= 1 || atFirstLook.published) &&
    atFirstLook.turns <= SETTLE_OUTLOOK_FIRST_LOOK_MAX_TURNS &&
    settleOutlookReturnChance(atFirstLook) <= SETTLE_OUTLOOK_FIRST_LOOK_BELOW
  ) {
    return SETTLE_OUTLOOK_FIRST_LOOK_MS;
  }
  const current = settleOutlookSignals(activity, thread);
  if (current === null) return null;
  return Math.min(
    SETTLE_OUTLOOK_LATE_MS,
    Math.max(
      SETTLE_OUTLOOK_FIRST_LOOK_MS,
      settleOutlookSettleWaitMs(current, SETTLE_OUTLOOK_BETWEEN_BELOW),
    ),
  );
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
      }>`
        SELECT message.thread_id AS "threadId", thread.project_id AS "projectId",
          message.updated_at AS "at"
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
