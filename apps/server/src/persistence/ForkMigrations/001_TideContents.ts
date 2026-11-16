import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tide_thread_entries (
      entry_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      title TEXT NOT NULL,
      title_source TEXT NOT NULL,
      outcome TEXT NOT NULL,
      open_json TEXT NOT NULL,
      open_count INTEGER NOT NULL,
      runs_json TEXT NOT NULL,
      start_message_id TEXT NOT NULL,
      end_message_id TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT NOT NULL,
      status TEXT NOT NULL,
      merged_into TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS tide_thread_entries_recent_idx
    ON tide_thread_entries(ended_at DESC, entry_id) WHERE status = 'active'
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS tide_thread_entries_thread_idx
    ON tide_thread_entries(thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS tide_thread_entries_open_idx
    ON tide_thread_entries(ended_at DESC) WHERE open_count > 0 AND status = 'active'
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tide_thread_runs (
      run_id TEXT PRIMARY KEY,
      thread_id TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      user_message_id TEXT NOT NULL,
      reply_message_id TEXT NOT NULL,
      line TEXT,
      owner_text TEXT,
      started_by TEXT NOT NULL,
      started_at TEXT NOT NULL,
      replied_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS tide_thread_runs_thread_idx
    ON tide_thread_runs(thread_id, ordinal)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tide_thread_contents (
      thread_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL,
      next_entry_seq INTEGER NOT NULL,
      owner_runs INTEGER NOT NULL,
      last_run_ordinal INTEGER NOT NULL,
      last_reply_at TEXT,
      runs_since_regroup INTEGER NOT NULL,
      regroup_requested_through INTEGER NOT NULL,
      regrouped_through INTEGER NOT NULL,
      regrouped_at TEXT
    )
  `;
  // Keep the predicate identical to the regroup sweep's query so SQLite can use the index.
  yield* sql`
    CREATE INDEX IF NOT EXISTS tide_thread_contents_due_idx
    ON tide_thread_contents(last_reply_at)
    WHERE owner_runs >= 10 AND runs_since_regroup > 0
      AND last_run_ordinal > regroup_requested_through
  `;
});
