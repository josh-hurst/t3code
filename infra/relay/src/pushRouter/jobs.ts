import * as PgClient from "@effect/sql-pg/PgClient";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";

import * as ApnsDeliveries from "../agentActivity/ApnsDeliveries.ts";
import * as ApnsDeliveryQueue from "../agentActivity/ApnsDeliveryQueue.ts";

class JobSignal extends Context.Service<JobSignal, Queue.Queue<void>>()(
  "t3code-relay/pushRouter/jobs/JobSignal",
) {}
export const signalLayer = Layer.effect(JobSignal, Queue.sliding<void>(1));

export const senderLayer = Layer.effect(
  ApnsDeliveryQueue.ApnsDeliveryQueueSender,
  Effect.gen(function* () {
    const sql = yield* PgClient.PgClient;
    const signal = yield* JobSignal;
    yield* sql`CREATE TABLE IF NOT EXISTS push_router_jobs (
    id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, body jsonb NOT NULL,
    attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now())`;
    return {
      send: Effect.fn("pushRouter.enqueue")(function* (job) {
        yield* sql`INSERT INTO push_router_jobs (body) VALUES (${sql.json(job)})`;
        yield* Queue.offer(signal, undefined);
      }),
    };
  }),
);

export const worker = Effect.gen(function* () {
  const sql = yield* PgClient.PgClient;
  const signal = yield* JobSignal;
  const deliveries = yield* ApnsDeliveries.ApnsDeliveries;
  const next = Effect.gen(function* () {
    const [job] = yield* sql<{ id: string; body: unknown; attempts: number }>`
      UPDATE push_router_jobs SET attempts = attempts + 1, available_at = now() + interval '1 minute'
      WHERE id = (SELECT id FROM push_router_jobs WHERE available_at <= now()
                  ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, body, attempts`;
    if (!job) {
      yield* Queue.take(signal).pipe(Effect.timeoutOption("30 seconds"));
      return;
    }
    const result = yield* deliveries.processSignedJob(job.body).pipe(Effect.result);
    // A signed job with a recorded APNs response is complete in the shared delivery ledger.
    if (Result.isFailure(result) && job.attempts < 5) {
      yield* sql`UPDATE push_router_jobs SET available_at = now() + interval '30 seconds' WHERE id = ${job.id}`;
    } else {
      if (Result.isFailure(result))
        yield* Effect.logWarning("APNs job exhausted its retries", {
          id: job.id,
          errorType: result.failure._tag,
        });
      yield* sql`DELETE FROM push_router_jobs WHERE id = ${job.id}`;
    }
  });
  return yield* next.pipe(
    Effect.catch(() =>
      Effect.logError("APNs job store unavailable").pipe(Effect.andThen(Effect.sleep("5 seconds"))),
    ),
    Effect.forever,
  );
});
