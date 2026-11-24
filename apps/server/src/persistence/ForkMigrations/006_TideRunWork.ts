import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// What each finished run did to its checkout, read once from its turn items: commands carry their
// output, so reading them on every Changes view was megabytes per open. Rows age out with the view.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tide_run_work (
      run_id TEXT PRIMARY KEY,
      captured_at TEXT NOT NULL,
      edited_json TEXT NOT NULL,
      named_json TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS tide_run_work_captured_idx ON tide_run_work(captured_at)
  `;
});
