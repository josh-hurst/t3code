import {
  type ListEntriesInput,
  type ListEntriesResult,
  type ListThreadEntriesResult,
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  ProjectId,
  RunId,
  ThreadCardOpenKind,
  ThreadContentsState,
  type ThreadEntriesUpdate,
  ThreadEntry,
  ThreadEntryId,
  ThreadEntryListItem,
  ThreadEntryOpenItem,
  ThreadEntryRun,
  ThreadId,
  ThreadRunLine,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { compareEntries, type ThreadContents, withoutRun } from "./ThreadEntries.ts";

export class ThreadEntryStoreError extends Schema.TaggedError<ThreadEntryStoreError>()(
  "ThreadEntryStoreError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread entry store operation '${this.operation}' failed.`;
  }
}

const LIST_LIMIT_DEFAULT = 50;
const SEARCH_SCAN_MAX = 5_000;

const EntryDbRow = Schema.Struct({
  ...ThreadEntry.fields,
  open: Schema.fromJsonString(Schema.Array(ThreadEntryOpenItem)),
  runs: Schema.fromJsonString(Schema.Array(ThreadEntryRun)),
  mergedInto: Schema.NullOr(ThreadEntryId),
});
const decodeEntryRows = Schema.decodeUnknownEffect(Schema.Array(EntryDbRow));
const encodeEntryRow = Schema.encodeEffect(EntryDbRow);
const decodeStateRows = Schema.decodeUnknownEffect(Schema.Array(ThreadContentsState));
const decodeRunLines = Schema.decodeUnknownEffect(Schema.Array(ThreadRunLine));
const decodeLatestRun = Schema.decodeUnknownEffect(Schema.Array(Schema.Struct({ runId: RunId })));
const decodeListRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      ...ThreadEntryListItem.fields,
      open: Schema.fromJsonString(ThreadEntryListItem.fields.open),
      threadSettled: Schema.BooleanFromBit,
    }),
  ),
);
const decodeCountRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({ projectId: ProjectId, kind: ThreadCardOpenKind, count: NonNegativeInt }),
  ),
);
const OpenItemRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  threadTitle: Schema.String,
  threadSettled: Schema.BooleanFromBit,
  worktreePath: Schema.NullOr(Schema.String),
  /** When the thread's card was last written; Undo leaves a regenerated card alone. */
  cardAt: Schema.NullOr(IsoDateTime),
  entryId: ThreadEntryId,
  entryTitle: Schema.String,
  /** The reply of the run that raised the item, else the entry's latest reply. */
  messageId: MessageId,
  item: Schema.fromJsonString(ThreadEntryOpenItem),
});
export type OpenItemRow = typeof OpenItemRow.Type;
const decodeOpenItemRows = Schema.decodeUnknownEffect(Schema.Array(OpenItemRow));
const decodeCandidateRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ threadId: ThreadId, ...ThreadContentsState.fields })),
);
const decodeIdleAtRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ lastReplyAt: Schema.NullOr(IsoDateTime) })),
);

const toEntry = ({ mergedInto, ...row }: typeof EntryDbRow.Type): ThreadEntry =>
  mergedInto === null ? row : { ...row, mergedInto };

const selectEntryColumns = (sql: SqlClient.SqlClient) => sql`
  entry_id AS "id",
  thread_id AS "threadId",
  title,
  title_source AS "titleSource",
  outcome,
  open_json AS "open",
  runs_json AS "runs",
  start_message_id AS "startMessageId",
  end_message_id AS "endMessageId",
  started_at AS "startedAt",
  ended_at AS "endedAt",
  status,
  merged_into AS "mergedInto"
`;

const selectStateColumns = (sql: SqlClient.SqlClient) => sql`
  revision,
  next_entry_seq AS "nextEntrySeq",
  owner_runs AS "ownerRuns",
  last_run_ordinal AS "lastRunOrdinal",
  last_reply_at AS "lastReplyAt",
  runs_since_regroup AS "runsSinceRegroup",
  regroup_requested_through AS "regroupRequestedThrough",
  regrouped_through AS "regroupedThrough",
  regrouped_at AS "regroupedAt"
`;

// The readers and writers below take the caller's `sql` so the projection's persist step can run
// them inside the event sink's transaction. They must never open a transaction of their own.

/* Runs per event or per read; the caller's operation owns the span. */
const readRunLines = Effect.fnUntraced(function* (sql: SqlClient.SqlClient, threadId: ThreadId) {
  const rows = yield* sql`
    SELECT
      run_id AS "runId",
      thread_id AS "threadId",
      ordinal,
      user_message_id AS "userMessageId",
      reply_message_id AS "replyMessageId",
      line,
      owner_text AS "ownerText",
      started_by AS "startedBy",
      started_at AS "startedAt",
      replied_at AS "repliedAt"
    FROM tide_thread_runs
    WHERE thread_id = ${threadId}
    ORDER BY ordinal
  `;
  return yield* decodeRunLines(rows);
});

/** Every entry of the thread, its bookkeeping, and the entries its latest run line sits in. */
const readThreadContents = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const entries = (yield* decodeEntryRows(
    yield* sql`SELECT ${selectEntryColumns(sql)} FROM tide_thread_entries WHERE thread_id = ${threadId}`,
  ))
    .map(toEntry)
    .sort(compareEntries);
  const [state] = yield* decodeStateRows(
    yield* sql`SELECT ${selectStateColumns(sql)} FROM tide_thread_contents WHERE thread_id = ${threadId}`,
  );
  const [latest] = yield* decodeLatestRun(
    yield* sql`
      SELECT run_id AS "runId" FROM tide_thread_runs
      WHERE thread_id = ${threadId}
      ORDER BY ordinal DESC
      LIMIT 1
    `,
  );
  const previousRunEntryIds =
    latest === undefined
      ? []
      : entries
          .filter((entry) => entry.status === "active")
          .flatMap((entry) => {
            const link = entry.runs.find((candidate) => candidate.runId === latest.runId);
            return link === undefined ? [] : [{ id: entry.id, second: link.second === true }];
          })
          .sort((left, right) => Number(left.second) - Number(right.second))
          .map((link) => link.id);
  return { entries, state: state ?? null, previousRunEntryIds } satisfies ThreadContents;
});

const writeUpdate = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  update: ThreadEntriesUpdate,
) {
  for (const entry of update.entries) {
    const row = yield* encodeEntryRow({ ...entry, mergedInto: entry.mergedInto ?? null });
    yield* sql`
      INSERT INTO tide_thread_entries (
        entry_id, thread_id, title, title_source, outcome, open_json, open_count, runs_json,
        start_message_id, end_message_id, started_at, ended_at, status, merged_into
      ) VALUES (
        ${row.id}, ${row.threadId}, ${row.title}, ${row.titleSource}, ${row.outcome},
        ${row.open}, ${entry.open.length}, ${row.runs}, ${row.startMessageId},
        ${row.endMessageId}, ${row.startedAt}, ${row.endedAt}, ${row.status}, ${row.mergedInto}
      )
      ON CONFLICT(entry_id) DO UPDATE SET
        title = excluded.title,
        title_source = excluded.title_source,
        outcome = excluded.outcome,
        open_json = excluded.open_json,
        open_count = excluded.open_count,
        runs_json = excluded.runs_json,
        start_message_id = excluded.start_message_id,
        end_message_id = excluded.end_message_id,
        started_at = excluded.started_at,
        ended_at = excluded.ended_at,
        status = excluded.status,
        merged_into = excluded.merged_into
    `;
  }
  for (const line of update.runLines) {
    yield* sql`
      INSERT INTO tide_thread_runs (
        run_id, thread_id, ordinal, user_message_id, reply_message_id, line, owner_text,
        started_by, started_at, replied_at
      ) VALUES (
        ${line.runId}, ${line.threadId}, ${line.ordinal}, ${line.userMessageId},
        ${line.replyMessageId}, ${line.line}, ${line.ownerText}, ${line.startedBy},
        ${line.startedAt}, ${line.repliedAt}
      )
      ON CONFLICT(run_id) DO UPDATE SET
        ordinal = excluded.ordinal,
        user_message_id = excluded.user_message_id,
        reply_message_id = excluded.reply_message_id,
        line = excluded.line,
        owner_text = excluded.owner_text,
        started_by = excluded.started_by,
        started_at = excluded.started_at,
        replied_at = excluded.replied_at
    `;
  }
  const { state } = update;
  yield* sql`
    INSERT INTO tide_thread_contents (
      thread_id, revision, next_entry_seq, owner_runs, last_run_ordinal, last_reply_at,
      runs_since_regroup, regroup_requested_through, regrouped_through, regrouped_at
    ) VALUES (
      ${threadId}, ${state.revision}, ${state.nextEntrySeq}, ${state.ownerRuns},
      ${state.lastRunOrdinal}, ${state.lastReplyAt}, ${state.runsSinceRegroup},
      ${state.regroupRequestedThrough}, ${state.regroupedThrough}, ${state.regroupedAt}
    )
    ON CONFLICT(thread_id) DO UPDATE SET
      revision = excluded.revision,
      next_entry_seq = excluded.next_entry_seq,
      owner_runs = excluded.owner_runs,
      last_run_ordinal = excluded.last_run_ordinal,
      last_reply_at = excluded.last_reply_at,
      runs_since_regroup = excluded.runs_since_regroup,
      regroup_requested_through = excluded.regroup_requested_through,
      regrouped_through = excluded.regrouped_through,
      regrouped_at = excluded.regrouped_at
  `;
});

/** The persist step of `thread.entries-updated`. */
export const applyEntriesUpdated = (
  sql: SqlClient.SqlClient,
  event: { readonly threadId: ThreadId; readonly payload: ThreadEntriesUpdate },
) => writeUpdate(sql, event.threadId, event.payload);

export const deleteThreadContents = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  yield* sql`DELETE FROM tide_thread_entries WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM tide_thread_runs WHERE thread_id = ${threadId}`;
  yield* sql`DELETE FROM tide_thread_contents WHERE thread_id = ${threadId}`;
});

/** A run was rolled back after it was carded: its line and links go. Nothing for an unfiled run. */
export const removeRunFromContents = Effect.fnUntraced(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  runId: RunId,
) {
  // Runs inside the rollback's own commit: an unreadable row must not fail the rollback.
  const update = yield* Effect.gen(function* () {
    const lines = yield* readRunLines(sql, threadId);
    if (!lines.some((line) => line.runId === runId)) return null;
    return withoutRun(yield* readThreadContents(sql, threadId), lines, runId);
  }).pipe(
    Effect.catchTags({
      SchemaError: (cause) =>
        Effect.logWarning("Thread contents could not be read for a rolled-back run", {
          threadId,
          runId,
          cause,
        }).pipe(Effect.as(null)),
    }),
  );
  yield* sql`DELETE FROM tide_thread_runs WHERE run_id = ${runId}`;
  if (update !== null) yield* writeUpdate(sql, threadId, update);
});

// A thread reads as settled exactly when the unsettled-only thread list leaves it out.
const threadSettledColumn = (sql: SqlClient.SqlClient) => sql`
  CASE WHEN json_extract(t.payload_json, '$.settledAt') IS NULL
    AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled' THEN 0 ELSE 1 END
`;

export class ThreadEntryStore extends Context.Service<
  ThreadEntryStore,
  {
    readonly getThreadContents: (
      threadId: ThreadId,
    ) => Effect.Effect<ThreadContents, ThreadEntryStoreError>;
    /** Active entries in order of first appearance. */
    readonly listForThread: (
      threadId: ThreadId,
    ) => Effect.Effect<ListThreadEntriesResult, ThreadEntryStoreError>;
    /** Active entries of live threads, last worked on first. */
    readonly list: (
      input: ListEntriesInput,
    ) => Effect.Effect<ListEntriesResult, ThreadEntryStoreError>;
    /** Open items of active entries per project and kind, for projects that have any. */
    readonly counts: () => Effect.Effect<
      ReadonlyArray<{
        readonly projectId: ProjectId;
        readonly counts: Readonly<Record<ThreadCardOpenKind, number>>;
      }>,
      ThreadEntryStoreError
    >;
    /** Every open item of active entries in live threads, last worked on first. */
    readonly openItems: (input: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
      readonly kind?: ThreadCardOpenKind;
    }) => Effect.Effect<ReadonlyArray<OpenItemRow>, ThreadEntryStoreError>;
    /** Whether an active publish marker covers this run (called during it, or after its reply). */
    readonly hasPublishCoveringRun: (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly runRequestedAt: string;
      readonly repliedAt: string;
    }) => Effect.Effect<boolean, ThreadEntryStoreError>;
    readonly runLines: (
      threadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<ThreadRunLine>, ThreadEntryStoreError>;
    /** Long threads with runs not yet regrouped and no reply for ten minutes. */
    readonly regroupCandidates: (
      now: DateTime.Utc,
    ) => Effect.Effect<
      ReadonlyArray<{ readonly threadId: ThreadId; readonly state: ThreadContentsState }>,
      ThreadEntryStoreError
    >;
    /** The oldest last reply of a long thread not yet idle for ten minutes, or null. */
    readonly regroupIdleAt: (
      now: DateTime.Utc,
    ) => Effect.Effect<DateTime.Utc | null, ThreadEntryStoreError>;
  }
>()("t3/orchestration-v2/ThreadEntryStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failed = (operation: string) => (cause: unknown) =>
    new ThreadEntryStoreError({ operation, cause });

  const getThreadContents = Effect.fn("ThreadEntryStore.getThreadContents")(
    function* (threadId: ThreadId) {
      return yield* readThreadContents(sql, threadId);
    },
    Effect.mapError(failed("getThreadContents")),
    NodeSqliteClient.readOnly,
  );

  const listForThread = Effect.fn("ThreadEntryStore.listForThread")(
    function* (threadId: ThreadId) {
      const contents = yield* readThreadContents(sql, threadId);
      return {
        entries: contents.entries.filter((entry) => entry.status === "active"),
        revision: contents.state?.revision ?? 0,
      };
    },
    Effect.mapError(failed("listForThread")),
    NodeSqliteClient.readOnly,
  );

  const list = Effect.fn("ThreadEntryStore.list")(
    function* (input: ListEntriesInput) {
      const limit = input.limit ?? LIST_LIMIT_DEFAULT;
      const words = (input.query ?? "")
        .toLowerCase()
        .split(/\s+/)
        .filter((word) => word !== "");
      const rows = yield* sql`
        SELECT
          e.entry_id AS "id",
          e.thread_id AS "threadId",
          t.project_id AS "projectId",
          e.title,
          e.outcome,
          e.open_json AS "open",
          e.start_message_id AS "startMessageId",
          e.end_message_id AS "endMessageId",
          e.started_at AS "startedAt",
          e.ended_at AS "endedAt",
          t.title AS "threadTitle",
          ${threadSettledColumn(sql)} AS "threadSettled"
        FROM tide_thread_entries e
        JOIN orchestration_v2_projection_threads t
          ON t.thread_id = e.thread_id AND t.deleted_at IS NULL
        WHERE ${sql.and([
          sql`e.status = 'active'`,
          ...(input.projectIds === undefined
            ? []
            : [sql`t.project_id IN ${sql.in(input.projectIds)}`]),
          ...(input.stillOpen === true || input.openKind !== undefined
            ? [sql`e.open_count > 0`]
            : []),
          ...(input.openKind === undefined
            ? []
            : [
                sql`EXISTS (
                  SELECT 1 FROM json_each(e.open_json) item
                  WHERE json_extract(item.value, '$.kind') = ${input.openKind}
                )`,
              ]),
          ...(input.before === undefined
            ? []
            : [
                sql`(e.ended_at < ${input.before.endedAt}
                  OR (e.ended_at = ${input.before.endedAt} AND e.entry_id > ${input.before.entryId}))`,
              ]),
          ...(words.length === 0
            ? []
            : [
                sql`e.entry_id IN (
                  SELECT entry_id FROM tide_thread_entries WHERE status = 'active'
                  ORDER BY ended_at DESC, entry_id LIMIT ${SEARCH_SCAN_MAX}
                )`,
                ...words.map((word) => sql`instr(lower(e.title || ' ' || e.outcome), ${word}) > 0`),
              ]),
        ])}
        ORDER BY e.ended_at DESC, e.entry_id
        LIMIT ${limit + 1}
      `;
      const entries = yield* decodeListRows(rows);
      const page = entries.slice(0, limit);
      const last = page.at(-1);
      return {
        entries: page,
        next:
          entries.length > limit && last !== undefined
            ? { endedAt: last.endedAt, entryId: last.id }
            : null,
      };
    },
    Effect.mapError(failed("list")),
    NodeSqliteClient.readOnly,
  );

  const counts = Effect.fn("ThreadEntryStore.counts")(
    function* () {
      const rows = yield* decodeCountRows(
        yield* sql`
          SELECT
            t.project_id AS "projectId",
            json_extract(item.value, '$.kind') AS kind,
            COUNT(*) AS count
          FROM tide_thread_entries e
          JOIN orchestration_v2_projection_threads t
            ON t.thread_id = e.thread_id AND t.deleted_at IS NULL,
            json_each(e.open_json) item
          WHERE e.open_count > 0 AND e.status = 'active'
          GROUP BY t.project_id, kind
          ORDER BY t.project_id
        `,
      );
      const byProject = new Map<ProjectId, Record<ThreadCardOpenKind, number>>();
      for (const row of rows) {
        const counts = byProject.get(row.projectId) ?? {
          ask: 0,
          verify: 0,
          commit: 0,
          ship: 0,
          followup: 0,
        };
        counts[row.kind] = row.count;
        byProject.set(row.projectId, counts);
      }
      return [...byProject].map(([projectId, counts]) => ({ projectId, counts }));
    },
    Effect.mapError(failed("counts")),
    NodeSqliteClient.readOnly,
  );

  const openItems = Effect.fn("ThreadEntryStore.openItems")(
    function* (input: {
      readonly projectIds?: ReadonlyArray<ProjectId>;
      readonly kind?: ThreadCardOpenKind;
    }) {
      if (input.projectIds?.length === 0) return [];
      return yield* decodeOpenItemRows(
        yield* sql`
          SELECT
            e.thread_id AS "threadId",
            t.project_id AS "projectId",
            t.title AS "threadTitle",
            ${threadSettledColumn(sql)} AS "threadSettled",
            json_extract(t.payload_json, '$.worktreePath') AS "worktreePath",
            json_extract(t.payload_json, '$.card.at') AS "cardAt",
            e.entry_id AS "entryId",
            e.title AS "entryTitle",
            COALESCE(r.reply_message_id, e.end_message_id) AS "messageId",
            item.value AS item
          FROM tide_thread_entries e
          JOIN orchestration_v2_projection_threads t
            ON t.thread_id = e.thread_id AND t.deleted_at IS NULL,
            json_each(e.open_json) item
          LEFT JOIN tide_thread_runs r ON r.run_id = json_extract(item.value, '$.runId')
          WHERE ${sql.and([
            sql`e.open_count > 0`,
            sql`e.status = 'active'`,
            ...(input.projectIds === undefined
              ? []
              : [sql`t.project_id IN ${sql.in(input.projectIds)}`]),
            ...(input.kind === undefined
              ? []
              : [sql`json_extract(item.value, '$.kind') = ${input.kind}`]),
          ])}
          ORDER BY e.ended_at DESC, e.entry_id, item.key
        `,
      );
    },
    Effect.mapError(failed("openItems")),
    NodeSqliteClient.readOnly,
  );

  const hasPublishCoveringRun = Effect.fn("ThreadEntryStore.hasPublishCoveringRun")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly threadId: ThreadId;
      readonly runRequestedAt: string;
      readonly repliedAt: string;
    }) {
      const rows = yield* sql`
        SELECT 1 AS hit
        FROM tide_publish_markers
        WHERE project_id = ${input.projectId}
          AND undone_at IS NULL
          AND (
            published_at >= ${input.repliedAt}
            OR (source_thread_id = ${input.threadId} AND published_at >= ${input.runRequestedAt})
          )
        LIMIT 1
      `;
      return rows.length > 0;
    },
    Effect.mapError(failed("hasPublishCoveringRun")),
    NodeSqliteClient.readOnly,
  );

  const runLines = Effect.fn("ThreadEntryStore.runLines")(
    function* (threadId: ThreadId) {
      return yield* readRunLines(sql, threadId);
    },
    Effect.mapError(failed("runLines")),
    NodeSqliteClient.readOnly,
  );

  const regroupCandidates = Effect.fn("ThreadEntryStore.regroupCandidates")(
    function* (now: DateTime.Utc) {
      const idleSince = DateTime.formatIso(DateTime.subtract(now, { minutes: 10 }));
      // The predicate repeats the partial index's, literals included, so SQLite can use it.
      return (yield* decodeCandidateRows(
        yield* sql`
            SELECT thread_id AS "threadId", ${selectStateColumns(sql)}
            FROM tide_thread_contents
            WHERE owner_runs >= 10 AND runs_since_regroup > 0
              AND last_run_ordinal > regroup_requested_through
              AND last_reply_at <= ${idleSince}
            ORDER BY last_reply_at
          `,
      )).map(({ threadId, ...state }) => ({ threadId, state }));
    },
    Effect.mapError(failed("regroupCandidates")),
    NodeSqliteClient.readOnly,
  );

  const regroupIdleAt = Effect.fn("ThreadEntryStore.regroupIdleAt")(
    function* (now: DateTime.Utc) {
      const idleSince = DateTime.formatIso(DateTime.subtract(now, { minutes: 10 }));
      const [row] = yield* decodeIdleAtRows(
        yield* sql`
          SELECT MIN(last_reply_at) AS "lastReplyAt"
          FROM tide_thread_contents
          WHERE owner_runs >= 10 AND runs_since_regroup > 0
            AND last_run_ordinal > regroup_requested_through
            AND last_reply_at > ${idleSince}
        `,
      );
      return row?.lastReplyAt == null ? null : DateTime.makeUnsafe(row.lastReplyAt);
    },
    Effect.mapError(failed("regroupIdleAt")),
    NodeSqliteClient.readOnly,
  );

  return ThreadEntryStore.of({
    getThreadContents,
    listForThread,
    list,
    counts,
    openItems,
    hasPublishCoveringRun,
    runLines,
    regroupCandidates,
    regroupIdleAt,
  });
});

export const layer = Layer.effect(ThreadEntryStore, make);
