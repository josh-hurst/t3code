import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Derived and rebuildable; keyed by stable chunk keys (message ids, not rowids, which VACUUM renumbers).
  yield* sql`
    CREATE TABLE thread_search_embeddings (
      thread_id TEXT NOT NULL,
      chunk_key TEXT NOT NULL,
      chunk_kind TEXT NOT NULL,
      message_id TEXT,
      message_created_at TEXT,
      content_hash TEXT NOT NULL,
      model_id TEXT NOT NULL,
      snippet TEXT NOT NULL,
      embedding BLOB NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, chunk_key)
    )
  `;
  yield* sql`
    CREATE INDEX thread_search_embeddings_model_idx
      ON thread_search_embeddings(model_id)
  `;
});
