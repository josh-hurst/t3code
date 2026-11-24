// Fork-only schema, in its own ledger so upstream's ids and ledger never see it.
// 1. A fork migration creates or alters only tables and indexes named `tide_*`.
// 2. It never alters or indexes an upstream table; fork state on an upstream row is an optional,
//    leniently decoded field of that row's JSON payload. 3. Fork ids never join `migrationEntries`.
import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import ForkMigration0001 from "./ForkMigrations/001_TideContents.ts";
import ForkMigration0002 from "./ForkMigrations/002_TidePublishMarkers.ts";
import ForkMigration0003 from "./ForkMigrations/003_TideChangeDigests.ts";
import ForkMigration0004 from "./ForkMigrations/004_TideRegroupAgain.ts";
import ForkMigration0005 from "./ForkMigrations/005_TideSettleOutlook.ts";
import ForkMigration0006 from "./ForkMigrations/006_TideRunWork.ts";

const FORK_MIGRATIONS_TABLE = "t3_fork_migrations";

const forkMigrationEntries = [
  [1, "TideContents", ForkMigration0001],
  [2, "TidePublishMarkers", ForkMigration0002],
  [3, "TideChangeDigests", ForkMigration0003],
  [4, "TideRegroupAgain", ForkMigration0004],
  [5, "TideSettleOutlook", ForkMigration0005],
  [6, "TideRunWork", ForkMigration0006],
] as const;

export const forkMigrationManifest = forkMigrationEntries.map(([id, name]) => [id, name] as const);

const latestForkMigrationId = Math.max(...forkMigrationEntries.map(([id]) => id));

const makeForkMigrationLoader = (throughId: number) =>
  Migrator.fromRecord(
    Object.fromEntries(
      forkMigrationEntries
        .filter(([id]) => id <= throughId)
        .map(([id, name, migration]) => [`${id}_${name}`, migration]),
    ),
  );

const readLatestForkMigrationId = Effect.fn("readLatestForkMigrationId")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${FORK_MIGRATIONS_TABLE}
  `;
  if (tables.length === 0) return 0;
  const [row] = yield* sql<{ readonly id: number | null }>`
    SELECT MAX(migration_id) AS id FROM ${sql(FORK_MIGRATIONS_TABLE)}
  `;
  return row?.id ?? 0;
});

export const hasPendingForkMigrations = Effect.fn("hasPendingForkMigrations")(function* () {
  return (yield* readLatestForkMigrationId()) < latestForkMigrationId;
});

const run = Migrator.make({});

/** One transaction per migration, like upstream's loop. */
export const runForkMigrations = Effect.fn("runForkMigrations")(function* () {
  const latestRecordedId = yield* readLatestForkMigrationId();
  const executed: Array<readonly [id: number, name: string]> = [];
  for (const [id] of forkMigrationEntries.filter(([id]) => id > latestRecordedId)) {
    executed.push(
      ...(yield* run({ loader: makeForkMigrationLoader(id), table: FORK_MIGRATIONS_TABLE })),
    );
  }
  return executed;
});
