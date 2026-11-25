import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row each time the owner leaves a thread: how long it was on screen and how much of that the
// window was in front of them, to test whether a glance should hold a thread from settling.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tide_thread_stays (
      thread_id TEXT NOT NULL,
      left_at TEXT NOT NULL,
      stay_ms INTEGER NOT NULL,
      looked_ms INTEGER NOT NULL,
      PRIMARY KEY (thread_id, left_at)
    )
  `;
});
