import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tide_publish_markers (
      marker_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      published_at TEXT NOT NULL,
      source_thread_id TEXT,
      cleared_json TEXT NOT NULL,
      undone_at TEXT
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS tide_publish_markers_project_idx
    ON tide_publish_markers(project_id, published_at DESC)
  `;
});
