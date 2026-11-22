import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// The regroup rules changed (a topic is a whole job, not a part of one), so every thread grouped
// under the old rules is due once more. The revision moves so its request is a new one.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    UPDATE tide_thread_contents
    SET revision = revision + 1,
        regroup_requested_through = 0,
        regrouped_through = 0,
        regrouped_at = NULL,
        runs_since_regroup = (
          SELECT COUNT(*) FROM tide_thread_runs
          WHERE tide_thread_runs.thread_id = tide_thread_contents.thread_id
        )
    WHERE regrouped_at IS NOT NULL
  `;
});
