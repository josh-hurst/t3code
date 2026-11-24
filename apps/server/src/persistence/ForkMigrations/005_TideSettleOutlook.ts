import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// One row per quiet stretch of a thread that reached the Settling section: the chance and signals
// when it was listed and when it settled early. Plan events are pruned, so this is the only record
// the score can later be checked against.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS tide_settle_outlook (
      thread_id TEXT NOT NULL,
      quiet_at TEXT NOT NULL,
      listed_at TEXT NOT NULL,
      listed_chance REAL NOT NULL,
      listed_signals_json TEXT NOT NULL,
      settled_at TEXT,
      settled_chance REAL,
      settled_signals_json TEXT,
      PRIMARY KEY (thread_id, quiet_at)
    )
  `;
});
