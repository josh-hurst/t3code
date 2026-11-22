import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tide_change_digests (
      project_id TEXT NOT NULL,
      period_key TEXT NOT NULL,
      digest_json TEXT NOT NULL,
      generated_at TEXT NOT NULL,
      PRIMARY KEY (project_id, period_key)
    )
  `;
});
