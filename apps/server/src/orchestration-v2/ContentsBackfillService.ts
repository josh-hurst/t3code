import {
  CommandId,
  type ContentsBackfillEstimate,
  type ContentsBackfillEstimateInput,
  type ContentsBackfillStatus,
  isListedThreadLineage,
  NonNegativeInt,
  type ProjectId,
  ThreadContentsError,
  type ThreadContentsTopic,
  ThreadId,
  type ThreadRunLine,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import type * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import {
  buildRunHeadlinesPrompt,
  buildThreadRegroupPrompt,
  parseRunHeadlines,
} from "../textGeneration/ThreadRegroup.ts";
import { describeRun, runReply } from "./ThreadCardService.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { runSaid, THREAD_REGROUP_MIN_OWNER_RUNS } from "./ThreadRegroup.ts";
import * as ThreadRegroupService from "./ThreadRegroupService.ts";

const ESTIMATE_TTL_MINUTES = 15;
// A run this recent may still get its own card; a line written first would make that a no-op.
const SETTLE_MINUTES = 60;
const RUNS_PER_CALL = 20;
// Nothing else bounds a call outside the outbox, and cancel must not wait on a stuck provider.
const CALL_TIMEOUT = "90 seconds";
// Calls failing back to back mean the model is unreachable; the rest would fail the same way.
const FAILED_CALLS_STOP = 3;

// From the grouping experiment: prompt tokens per character, a headlines run's shortened text
// (170 + 300 + 700 characters and labels), and an outline line. Output per headline and regroup.
const TOKENS_PER_CHAR = 0.29;
const HEADLINE_RUN_CHARS = 1_230;
const REGROUP_TOKENS_PER_RUN = 45;
const HEADLINE_OUTPUT_TOKENS = 15;
const REGROUP_OUTPUT_TOKENS = 300;
const HEADLINE_FIXED_TOKENS = Math.ceil(buildRunHeadlinesPrompt([]).length * TOKENS_PER_CHAR);
const REGROUP_FIXED_TOKENS = Math.ceil(buildThreadRegroupPrompt("").length * TOKENS_PER_CHAR);

/** One listed thread with completed runs that have no line, as the estimate's query reads it. */
export interface BackfillCandidate {
  readonly threadId: ThreadId;
  /** Completed runs in all, lined or not; ten or more counts as long. */
  readonly completedRuns: number;
  /** Completed runs with a reply, finished an hour ago or more, and no line yet. */
  readonly missingRuns: number;
  readonly hasEntries: boolean;
}

const isLong = (candidate: BackfillCandidate) =>
  candidate.completedRuns >= THREAD_REGROUP_MIN_OWNER_RUNS;

const matchesOnly = (candidate: BackfillCandidate, only: "long" | "short" | undefined) =>
  only === undefined || (only === "long") === isLong(candidate);

/**
 * The job's calls and tokens over these counts. Prompt tokens only: a provider's own fixed
 * instructions per call (about a dozen tokens through codex-lite, about 11,200 through
 * `codex exec`) come on top, so the caller states them beside `calls`.
 */
export function estimateBackfill(input: {
  readonly candidates: ReadonlyArray<BackfillCandidate>;
  readonly migrated: number;
  readonly only: "long" | "short" | undefined;
}): Omit<ContentsBackfillEstimate, "estimateId"> {
  let short = 0;
  let long = 0;
  let runs = 0;
  let shortHeadlines = 0;
  let longHeadlineCalls = 0;
  let headlineRuns = 0;
  let outlineRuns = 0;
  for (const candidate of input.candidates) {
    if (!matchesOnly(candidate, input.only)) continue;
    runs += candidate.missingRuns;
    if (isLong(candidate)) {
      long++;
      longHeadlineCalls += Math.ceil(candidate.missingRuns / RUNS_PER_CALL);
      headlineRuns += candidate.missingRuns;
      outlineRuns += candidate.completedRuns;
    } else {
      short++;
      // A short thread that already has a topic needs no headline to name one.
      if (!candidate.hasEntries) {
        shortHeadlines++;
        headlineRuns++;
      }
    }
  }
  const headlines = Math.ceil(shortHeadlines / RUNS_PER_CALL) + longHeadlineCalls;
  const n = (value: number) => NonNegativeInt.make(Math.ceil(value));
  return {
    threads: { short: n(short), long: n(long), migrated: n(input.migrated) },
    runs: n(runs),
    calls: { headlines: n(headlines), regroups: n(long) },
    promptTokens: n(
      headlines * HEADLINE_FIXED_TOKENS +
        headlineRuns * HEADLINE_RUN_CHARS * TOKENS_PER_CHAR +
        long * REGROUP_FIXED_TOKENS +
        outlineRuns * REGROUP_TOKENS_PER_RUN,
    ),
    outputTokens: n(headlineRuns * HEADLINE_OUTPUT_TOKENS + long * REGROUP_OUTPUT_TOKENS),
  };
}

const CandidateRow = Schema.Struct({
  threadId: ThreadId,
  completedRuns: Schema.Number,
  missingRuns: Schema.Number,
  hasEntries: Schema.BooleanFromBit,
});
const decodeCandidates = Schema.decodeUnknownEffect(Schema.Array(CandidateRow));
const decodeCount = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ count: Schema.Number })),
);

interface Estimate {
  readonly input: ContentsBackfillEstimateInput;
  readonly expiresAt: DateTime.Utc;
}

type Job = NonNullable<ContentsBackfillStatus>;

/** A short thread waiting for its one headline, which is asked for with up to nineteen others. */
interface PendingShort {
  readonly threadId: ThreadId;
  readonly lines: ReadonlyArray<ThreadRunLine>;
  readonly said: string;
  readonly reply: string;
}

class JobStopped extends Schema.TaggedError<JobStopped>()("JobStopped", {
  reason: Schema.String,
}) {}

const refused = (message: string) => new ThreadContentsError({ message });

const isJobStopped = Schema.is(JobStopped);

/** A cancel, or a reason to stop the whole job rather than skip one thread. */
const stopsJob = (cause: Cause.Cause<unknown>) => {
  if (Cause.hasInterruptsOnly(cause)) return true;
  const error = Cause.findErrorOption(cause);
  return Option.isSome(error) && isJobStopped(error.value);
};

export class ContentsBackfillService extends Context.Service<
  ContentsBackfillService,
  {
    /** Counts what a backfill of one project would do and keeps the answer for fifteen minutes. */
    readonly estimate: (
      input: ContentsBackfillEstimateInput,
    ) => Effect.Effect<ContentsBackfillEstimate, ThreadContentsError>;
    /** Starts the estimated job; refused while one runs, while summaries are off, or once expired. */
    readonly start: (input: {
      readonly estimateId: string;
    }) => Effect.Effect<{ readonly jobId: string }, ThreadContentsError>;
    /** The environment's one job since the server started, finished or not. */
    readonly status: Effect.Effect<ContentsBackfillStatus>;
    /** The status now, then every change. */
    readonly changes: Stream.Stream<ContentsBackfillStatus>;
    /** Stops the job at once; a thread it was working on records nothing and is left for later. */
    readonly cancel: Effect.Effect<void>;
  }
>()("t3/orchestration-v2/ContentsBackfillService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const entryStore = yield* ThreadEntryStore.ThreadEntryStore;
  const regroups = yield* ThreadRegroupService.ThreadRegroupService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const fileSystem = yield* FileSystem.FileSystem;
  const random = yield* SecureRandom.SecureRandom;
  const scope = yield* Effect.scope;

  const statusRef = yield* SubscriptionRef.make<ContentsBackfillStatus>(null);
  const estimates = new Map<string, Estimate>();
  const lock = yield* Semaphore.make(1);
  let running: Fiber.Fiber<void> | null = null;

  const readFailed = (cause: unknown) =>
    new ThreadContentsError({ message: "Could not read the project's threads.", cause });

  const listedThread = (input: ContentsBackfillEstimateInput) =>
    sql.and([
      sql`t.project_id = ${input.projectId}`,
      sql`t.deleted_at IS NULL`,
      sql`t.archived_at IS NULL`,
      sql`json_extract(t.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'`,
      sql`json_extract(t.payload_json, '$.lineage.sideChat') IS NOT 1`,
      ...(input.since === undefined ? [] : [sql`t.updated_at >= ${input.since}`]),
    ]);

  const readCandidates = Effect.fn("ContentsBackfillService.readCandidates")(
    function* (input: ContentsBackfillEstimateInput) {
      const settledBefore = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { minutes: SETTLE_MINUTES }),
      );
      const candidates = yield* decodeCandidates(
        yield* sql`
          SELECT
            t.thread_id AS "threadId",
            COUNT(*) AS "completedRuns",
            SUM(CASE WHEN tr.run_id IS NULL AND r.completed_at <= ${settledBefore}
              AND EXISTS (
                SELECT 1 FROM orchestration_v2_projection_messages m
                WHERE m.run_id = r.run_id AND m.role = 'assistant'
              )
              -- A maintenance command (/compact, /logout) never gets a line.
              AND NOT EXISTS (
                SELECT 1 FROM orchestration_v2_projection_messages um
                WHERE um.message_id = json_extract(r.payload_json, '$.userMessageId')
                  AND lower(trim(json_extract(um.payload_json, '$.text'))) IN ('/compact', '/logout')
              ) THEN 1 ELSE 0 END) AS "missingRuns",
            EXISTS (
              SELECT 1 FROM tide_thread_entries e
              WHERE e.thread_id = t.thread_id AND e.status = 'active'
            ) AS "hasEntries"
          FROM orchestration_v2_projection_threads t
          JOIN orchestration_v2_projection_runs r
            ON r.thread_id = t.thread_id AND r.status = 'completed'
          LEFT JOIN tide_thread_runs tr ON tr.run_id = r.run_id
          WHERE ${listedThread(input)}
          GROUP BY t.thread_id
          HAVING "missingRuns" > 0
          ORDER BY t.updated_at DESC
        `,
      );
      // The old format kept no runs, so a migrated thread's earlier replies have nothing to file.
      const [migrated] = yield* decodeCount(
        yield* sql`
          SELECT COUNT(*) AS count
          FROM orchestration_v2_legacy_imports li
          JOIN orchestration_v2_projection_threads t ON t.thread_id = li.thread_id
          WHERE ${listedThread(input)}
        `,
      );
      return { candidates, migrated: migrated?.count ?? 0 };
    },
    Effect.mapError(readFailed),
    NodeSqliteClient.readOnly,
  );

  const estimate: ContentsBackfillService["Service"]["estimate"] = Effect.fn(
    "ContentsBackfillService.estimate",
  )(function* (input) {
    const { candidates, migrated } = yield* readCandidates(input);
    const now = yield* DateTime.now;
    for (const [id, held] of estimates) {
      if (DateTime.isLessThanOrEqualTo(held.expiresAt, now)) estimates.delete(id);
    }
    const estimateId = `backfill-estimate:${yield* random.uuidV4()}`;
    estimates.set(estimateId, {
      input,
      expiresAt: DateTime.add(now, { minutes: ESTIMATE_TTL_MINUTES }),
    });
    return {
      estimateId,
      ...estimateBackfill({ candidates, migrated, only: input.only }),
    };
  });

  const update = (change: (job: Job) => Job) =>
    SubscriptionRef.update(statusRef, (job) => (job === null ? job : change(job)));

  const runJob = Effect.fn("ContentsBackfillService.run")(function* (input: {
    readonly jobId: string;
    readonly projectId: ProjectId;
    readonly only: "long" | "short" | undefined;
    readonly threadIds: ReadonlyArray<ThreadId>;
  }) {
    // Providers run in a working directory; headlines read only the text they are given.
    const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-contents-backfill-" });
    let failedInARow = 0;

    const generate = Effect.fn("ContentsBackfillService.generate")(function* (prompt: string) {
      const settings = yield* serverSettings.getSettings;
      if (settings.threadReplySummariesEnabled !== true) {
        return yield* new JobStopped({ reason: "summaries-off" });
      }
      const generated = yield* textGeneration
        .generateTranscriptionPostProcessing({
          cwd,
          prompt,
          modelSelection: settings.threadReplySummaryModelSelection,
        })
        .pipe(Effect.timeout(CALL_TIMEOUT), Effect.result);
      yield* update((job) => ({ ...job, calls: job.calls + 1 }));
      return generated;
    });
    const countCall = Effect.fn("ContentsBackfillService.countCall")(function* (ok: boolean) {
      failedInARow = ok ? 0 : failedInARow + 1;
      if (failedInARow < FAILED_CALLS_STOP) return;
      yield* Effect.logWarning("Contents backfill stopped: the summary model keeps failing", {
        jobId: input.jobId,
      });
      return yield* new JobStopped({ reason: "model-failing" });
    });

    /** Headlines in prompt order, null when the call failed or nothing parsed. */
    const headlines = Effect.fn("ContentsBackfillService.headlines")(function* (
      runs: ReadonlyArray<{ readonly said: string; readonly reply: string }>,
    ) {
      const generated = yield* generate(buildRunHeadlinesPrompt(runs));
      const parsed =
        generated._tag === "Success"
          ? parseRunHeadlines(generated.success.transcription, runs.length)
          : null;
      if (generated._tag === "Failure") {
        yield* Effect.logWarning("Contents backfill headlines call failed", {
          jobId: input.jobId,
          cause: generated.failure,
        });
      }
      yield* countCall(parsed !== null);
      return parsed;
    });

    const finishThread = (failed: boolean) =>
      update((job) => ({
        ...job,
        done: job.done + 1,
        failed: job.failed + (failed ? 1 : 0),
      }));

    const record = Effect.fn("ContentsBackfillService.record")(function* (
      threadId: ThreadId,
      runLines: ReadonlyArray<ThreadRunLine>,
      topics: ReadonlyArray<ThreadContentsTopic> | undefined,
    ) {
      const dispatched = yield* threads
        .dispatch({
          type: "thread.contents.backfill.record",
          commandId: CommandId.make(`command:contents-backfill:${input.jobId}:${threadId}`),
          threadId,
          runLines,
          ...(topics === undefined || topics.length === 0 ? {} : { topics }),
        })
        .pipe(Effect.result);
      if (dispatched._tag === "Failure") {
        yield* Effect.logWarning("Contents backfill record failed", {
          threadId,
          cause: dispatched.failure,
        });
      }
      yield* finishThread(dispatched._tag === "Failure");
    });

    let pending: Array<PendingShort> = [];
    const flushShort = Effect.fn("ContentsBackfillService.flushShort")(function* () {
      if (pending.length === 0) return;
      const batch = pending;
      pending = [];
      const lines = yield* headlines(batch);
      for (const [index, thread] of batch.entries()) {
        if (lines === null) {
          yield* finishThread(true);
          continue;
        }
        const headline = lines[index] ?? null;
        yield* record(
          thread.threadId,
          thread.lines.map((line, position) =>
            position === thread.lines.length - 1 ? { ...line, line: headline } : line,
          ),
          undefined,
        );
      }
    });

    /** Reads one thread and files it, or queues it for the next short batch. */
    const backfillThread = Effect.fn("ContentsBackfillService.thread")(function* (
      threadId: ThreadId,
    ) {
      const records = yield* threads.getThreadRecords(threadId, ["messages", "runs"]);
      const { thread } = records;
      if (
        thread.deletedAt !== null ||
        thread.archivedAt !== null ||
        !isListedThreadLineage(thread.lineage)
      ) {
        return yield* finishThread(false);
      }
      const stored = yield* entryStore.runLines(threadId);
      const lined = new Set(stored.map((line) => line.runId));
      const settledBefore = DateTime.subtract(yield* DateTime.now, { minutes: SETTLE_MINUTES });
      const fresh: Array<{ readonly line: ThreadRunLine; readonly reply: string }> = [];
      for (const run of records.runs.toSorted((left, right) => left.ordinal - right.ordinal)) {
        if (
          run.threadId !== threadId ||
          run.status !== "completed" ||
          lined.has(run.id) ||
          run.completedAt === null ||
          DateTime.isGreaterThan(run.completedAt, settledBefore)
        ) {
          continue;
        }
        const reply = runReply(records.messages, run.id);
        if (reply === undefined) continue;
        const described = describeRun({
          run,
          userMessage: records.messages.find((message) => message.id === run.userMessageId),
          messages: records.messages,
        });
        if (described === null) continue;
        fresh.push({
          reply: reply.text,
          line: {
            runId: run.id,
            threadId,
            ordinal: run.ordinal,
            userMessageId: run.userMessageId,
            replyMessageId: reply.id,
            line: null,
            ownerText: described.ownerText,
            startedBy: described.startedBy,
            startedAt: DateTime.formatIso(run.startedAt ?? run.requestedAt),
            repliedAt: DateTime.formatIso(reply.updatedAt),
          },
        });
      }
      const ownerRuns = [...stored, ...fresh.map((run) => run.line)].filter(
        (line) => line.startedBy === "owner",
      ).length;
      const long = ownerRuns >= THREAD_REGROUP_MIN_OWNER_RUNS;
      if (fresh.length === 0) return yield* finishThread(false);

      if (!long) {
        const contents = yield* entryStore.getThreadContents(threadId);
        const lines = fresh.map((run) => run.line);
        if (contents.entries.some((entry) => entry.status === "active")) {
          return yield* record(threadId, lines, undefined);
        }
        const last = fresh.at(-1)!;
        pending.push({ threadId, lines, said: runSaid(last.line), reply: last.reply });
        if (pending.length >= RUNS_PER_CALL) yield* flushShort();
        return;
      }

      const lines: Array<ThreadRunLine> = [];
      for (let from = 0; from < fresh.length; from += RUNS_PER_CALL) {
        const chunk = fresh.slice(from, from + RUNS_PER_CALL);
        const written = yield* headlines(
          chunk.map((run) => ({ said: runSaid(run.line), reply: run.reply })),
        );
        if (written === null) return yield* finishThread(true);
        chunk.forEach((run, index) => lines.push({ ...run.line, line: written[index] ?? null }));
      }
      // One sample, as a mark regroup: the thread's live regroups refine it later.
      const topics = yield* regroups
        .topics({ threadId, runLines: [...stored, ...lines], samples: 1 })
        .pipe(
          Effect.timeout(CALL_TIMEOUT),
          Effect.orElseSucceed(() => null),
        );
      yield* update((job) => ({ ...job, calls: job.calls + 1 }));
      yield* countCall(topics !== null);
      // Its headlines are paid again next time; filing them without a regroup would leave the
      // thread due for an unasked three-sample idle regroup.
      if (topics === null) return yield* finishThread(true);
      yield* record(threadId, lines, topics);
    });

    for (const threadId of input.threadIds) {
      yield* backfillThread(threadId).pipe(
        Effect.catchCauseIf(
          (cause) => !stopsJob(cause),
          (cause) =>
            Effect.logWarning("Contents backfill could not read a thread", {
              threadId,
              cause,
            }).pipe(Effect.andThen(finishThread(true))),
        ),
      );
    }
    yield* flushShort();
  }, Effect.scoped);

  const start: ContentsBackfillService["Service"]["start"] = Effect.fn(
    "ContentsBackfillService.start",
  )(function* ({ estimateId }) {
    return yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(statusRef);
        if (current !== null && current.finishedAt === null) {
          return yield* refused("Older threads are already being added.");
        }
        const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(readFailed));
        if (settings.threadReplySummariesEnabled !== true) {
          return yield* refused("Turn on reply summaries to add older threads.");
        }
        const held = estimates.get(estimateId);
        const now = yield* DateTime.now;
        if (held === undefined || DateTime.isLessThanOrEqualTo(held.expiresAt, now)) {
          return yield* refused("This estimate has expired. Estimate again to start.");
        }
        estimates.delete(estimateId);
        const { candidates } = yield* readCandidates(held.input);
        const threadIds = candidates
          .filter((candidate) => matchesOnly(candidate, held.input.only))
          .map((candidate) => candidate.threadId);
        const jobId = `backfill:${yield* random.uuidV4()}`;
        yield* SubscriptionRef.set(statusRef, {
          jobId,
          projectId: held.input.projectId,
          done: NonNegativeInt.make(0),
          total: NonNegativeInt.make(threadIds.length),
          calls: NonNegativeInt.make(0),
          failed: NonNegativeInt.make(0),
          finishedAt: null,
        });
        const finish = Effect.gen(function* () {
          const at = DateTime.formatIso(yield* DateTime.now);
          yield* update((job) => ({ ...job, finishedAt: at }));
        });
        running = yield* runJob({
          jobId,
          projectId: held.input.projectId,
          only: held.input.only,
          threadIds,
        }).pipe(
          Effect.catchCause((cause) =>
            stopsJob(cause)
              ? Effect.void
              : Effect.logWarning("Contents backfill failed", { jobId, cause }),
          ),
          Effect.ensuring(finish),
          Effect.forkIn(scope),
        );
        return { jobId };
      }),
    );
  });

  const cancel: ContentsBackfillService["Service"]["cancel"] = Effect.gen(function* () {
    const fiber = running;
    running = null;
    if (fiber !== null) yield* Fiber.interrupt(fiber);
  }).pipe(Effect.withSpan("ContentsBackfillService.cancel"));

  return ContentsBackfillService.of({
    estimate,
    start,
    status: SubscriptionRef.get(statusRef),
    changes: SubscriptionRef.changes(statusRef),
    cancel,
  });
});

export const layer = Layer.effect(ContentsBackfillService, make);
