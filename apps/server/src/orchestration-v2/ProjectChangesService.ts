import {
  IsoDateTime,
  MessageId,
  type ProjectChangeCounts,
  type ProjectChangesResult,
  ProjectId,
  RunId,
  ThreadEntryId,
  ThreadEntryRun,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  assembleTouches,
  buildProjectChanges,
  parseGitLogWithFiles,
  parseGitStatusPaths,
  projectChangeEntryIds,
} from "./ProjectChanges.ts";

/** How far back commits and run records are read. */
const HISTORY_DAYS = 30;
/** A project counts toward the sidebar while a thread of it ran this recently. */
const COUNTS_ACTIVE_DAYS = 14;
const COUNTS_HELD_MS = 30_000;
const OWN_COMMITS_MAX = 400;
/** Every author's commits, read without files to fold the others into one line each run. */
const ALL_COMMITS_MAX = 1_500;
const GIT_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;

export class ProjectChangesError extends Schema.TaggedError<ProjectChangesError>()(
  "ProjectChangesError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Project changes operation '${this.operation}' failed.`;
  }
}

const decodeThreads = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      parentThreadId: Schema.NullOr(ThreadId),
      worktreePath: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeCheckpoints = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      runId: RunId,
      capturedAt: IsoDateTime,
      paths: Schema.fromJsonString(Schema.Array(Schema.String)),
    }),
  ),
);
const decodeEntries = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      id: ThreadEntryId,
      threadId: ThreadId,
      title: Schema.String,
      outcome: Schema.String,
      threadTitle: Schema.String,
      startMessageId: MessageId,
      runs: Schema.fromJsonString(Schema.Array(ThreadEntryRun)),
    }),
  ),
);
const decodeRuns = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ runId: RunId, requestedAt: IsoDateTime })),
);
const decodeProjectIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ projectId: ProjectId })),
);
const decodePublishes = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ publishedAt: IsoDateTime })),
);

const EMPTY: ProjectChangesResult = {
  branch: null,
  isRepository: false,
  uncommitted: { files: 0, topics: [] },
  unpushedCommits: 0,
  sincePublish: null,
  commits: [],
  publishes: [],
  entries: [],
};

export class ProjectChangesService extends Context.Service<
  ProjectChangesService,
  {
    /**
     * Uncommitted files and unpushed commits in the root checkout of each project worked on
     * lately. Held for half a minute: the sidebar asks again on every card write.
     */
    readonly counts: () => Effect.Effect<
      ReadonlyArray<{ readonly projectId: ProjectId } & ProjectChangeCounts>,
      ProjectChangesError
    >;
    /** The project's root checkout: threads working in their own worktrees are left out. */
    readonly read: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<ProjectChangesResult, ProjectChangesError>;
  }
>()("t3/orchestration-v2/ProjectChangesService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const failed = (operation: string) => (cause: unknown) =>
    new ProjectChangesError({ operation, cause });

  const run = (cwd: string, operation: string, args: ReadonlyArray<string>) =>
    git
      .execute({
        operation: `ProjectChangesService.${operation}`,
        cwd,
        args,
        allowNonZeroExit: true,
        maxOutputBytes: GIT_OUTPUT_MAX_BYTES,
      })
      .pipe(
        Effect.map((result) => {
          if (result.exitCode !== 0) return null;
          if (!result.stdoutTruncated) return result.stdout;
          // Output cut at the byte cap ends mid-record; keep what came before it.
          const end = Math.max(result.stdout.lastIndexOf("\x1e"), result.stdout.lastIndexOf("\0"));
          return end === -1 ? "" : result.stdout.slice(0, end);
        }),
      );

  const loadEvidence = Effect.fn("ProjectChangesService.loadEvidence")(function* (
    projectId: ProjectId,
    since: string,
  ) {
    const threads = yield* decodeThreads(
      yield* sql`
        SELECT
          thread_id AS "threadId",
          json_extract(payload_json, '$.lineage.parentThreadId') AS "parentThreadId",
          json_extract(payload_json, '$.worktreePath') AS "worktreePath"
        FROM orchestration_v2_projection_threads
        WHERE project_id = ${projectId}
      `,
    );
    const checkpoints = yield* decodeCheckpoints(
      yield* sql`
        SELECT
          c.thread_id AS "threadId",
          c.run_id AS "runId",
          c.captured_at AS "capturedAt",
          (
            SELECT json_group_array(json_extract(file.value, '$.path'))
            FROM json_each(c.payload_json, '$.files') file
          ) AS paths
        FROM orchestration_v2_projection_checkpoints c
        JOIN orchestration_v2_projection_threads t ON t.thread_id = c.thread_id
        WHERE t.project_id = ${projectId}
          AND c.run_id IS NOT NULL
          AND c.captured_at >= ${since}
          AND json_array_length(c.payload_json, '$.files') > 0
      `,
    );
    // Top-level threads only: a subagent's edits count for its parent's topic.
    const entries = yield* decodeEntries(
      yield* sql`
        SELECT
          e.entry_id AS id,
          e.thread_id AS "threadId",
          e.title,
          e.outcome,
          t.title AS "threadTitle",
          e.start_message_id AS "startMessageId",
          e.runs_json AS runs
        FROM tide_thread_entries e
        JOIN orchestration_v2_projection_threads t
          ON t.thread_id = e.thread_id AND t.deleted_at IS NULL
        WHERE t.project_id = ${projectId}
          AND e.status = 'active'
          AND e.ended_at >= ${since}
          AND json_extract(t.payload_json, '$.lineage.parentThreadId') IS NULL
      `,
    );
    const runs = yield* decodeRuns(
      yield* sql`
        SELECT r.run_id AS "runId", r.requested_at AS "requestedAt"
        FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_threads t ON t.thread_id = r.thread_id
        WHERE t.project_id = ${projectId} AND r.requested_at >= ${since}
      `,
    );
    const publishes = yield* decodePublishes(
      yield* sql`
        SELECT published_at AS "publishedAt"
        FROM tide_publish_markers
        WHERE project_id = ${projectId} AND undone_at IS NULL AND published_at >= ${since}
      `,
    );
    return {
      touches: assembleTouches({
        threads,
        entries,
        runStartedAtMs: new Map(runs.map((row) => [row.runId, Date.parse(row.requestedAt)])),
        checkpoints: checkpoints.map((checkpoint) => ({
          threadId: checkpoint.threadId,
          runId: checkpoint.runId,
          capturedAtMs: Date.parse(checkpoint.capturedAt),
          paths: checkpoint.paths,
        })),
      }),
      entries,
      publishedAtMs: publishes.map((row) => Date.parse(row.publishedAt)),
    };
  }, NodeSqliteClient.readOnly);

  const statusArgs = [
    // Never takes the index lock, which a commit running in the checkout needs.
    "--no-optional-locks",
    "-c",
    "core.quotepath=off",
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ];
  const countsHeld = yield* Ref.make<{
    readonly atMs: number;
    readonly value: ReadonlyArray<{ readonly projectId: ProjectId } & ProjectChangeCounts>;
  } | null>(null);

  const counts: ProjectChangesService["Service"]["counts"] = Effect.fn(
    "ProjectChangesService.counts",
  )(
    function* () {
      const now = yield* DateTime.now;
      const nowMs = DateTime.toEpochMillis(now);
      const held = yield* Ref.get(countsHeld);
      if (held !== null && nowMs - held.atMs < COUNTS_HELD_MS) return held.value;
      const active = yield* decodeProjectIds(
        yield* sql`
          SELECT DISTINCT t.project_id AS "projectId"
          FROM orchestration_v2_projection_runs r
          JOIN orchestration_v2_projection_threads t
            ON t.thread_id = r.thread_id AND t.deleted_at IS NULL
          WHERE r.requested_at >= ${DateTime.formatIso(
            DateTime.subtract(now, { days: COUNTS_ACTIVE_DAYS }),
          )}
        `,
      );
      const since = DateTime.formatIso(DateTime.subtract(now, { days: HISTORY_DAYS }));
      const value = yield* Effect.forEach(
        active,
        ({ projectId }) =>
          Effect.gen(function* () {
            const project = yield* projects.getById(projectId);
            if (Option.isNone(project)) return [];
            const cwd = project.value.workspaceRoot;
            const [status, unpushed] = yield* Effect.all(
              [
                run(cwd, "status", statusArgs),
                // The same commits the project's change list marks as not pushed.
                run(cwd, "unpushedCount", [
                  "rev-list",
                  "--count",
                  "--no-merges",
                  `--since=${since}`,
                  "HEAD",
                  "--not",
                  "--remotes",
                ]),
              ],
              { concurrency: 2 },
            );
            if (status === null) return [];
            return [
              {
                projectId,
                uncommittedFiles: parseGitStatusPaths(status).length,
                unpushedCommits: Number.parseInt(unpushed ?? "", 10) || 0,
              },
            ];
          }),
        { concurrency: 4 },
      ).pipe(Effect.map((rows) => rows.flat()));
      yield* Ref.set(countsHeld, { atMs: nowMs, value });
      return value;
    },
    Effect.mapError(failed("counts")),
  );

  const read: ProjectChangesService["Service"]["read"] = Effect.fn("ProjectChangesService.read")(
    function* ({ projectId }) {
      const project = yield* projects.getById(projectId);
      if (Option.isNone(project)) return EMPTY;
      const cwd = project.value.workspaceRoot;
      const branch = yield* run(cwd, "branch", ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch === null) return EMPTY;
      const since = DateTime.formatIso(
        DateTime.subtract(yield* DateTime.now, { days: HISTORY_DAYS }),
      );
      const email = (yield* run(cwd, "user", ["config", "user.email"]))?.trim() || null;
      const logArgs = (extra: ReadonlyArray<string>) => [
        "-c",
        "core.quotepath=off",
        "log",
        "--no-merges",
        `--since=${since}`,
        "--format=%x1e%H%x1f%ct%x1f%an%x1f%ae%x1f%s",
        ...extra,
        "HEAD",
      ];
      const [status, ownLog, allLog, unpushed, evidence] = yield* Effect.all(
        [
          run(cwd, "status", statusArgs),
          // The owner's commits with their files. A busy upstream must not crowd them out of
          // the cap, so other authors' commits are read apart, without files.
          run(
            cwd,
            "ownLog",
            logArgs([
              `--max-count=${OWN_COMMITS_MAX}`,
              "--name-only",
              ...(email === null ? [] : ["--fixed-strings", `--author=<${email}>`]),
            ]),
          ),
          email === null
            ? Effect.succeed(null)
            : run(cwd, "allLog", logArgs([`--max-count=${ALL_COMMITS_MAX}`])),
          // On no remote branch at all, so a branch without an upstream still reads right.
          run(cwd, "unpushed", ["rev-list", `--since=${since}`, "HEAD", "--not", "--remotes"]),
          loadEvidence(projectId, since),
        ],
        { concurrency: "unbounded" },
      );
      const changes = buildProjectChanges({
        touches: evidence.touches,
        dirtyPaths: parseGitStatusPaths(status ?? ""),
        commits: [
          ...parseGitLogWithFiles(ownLog ?? "", email).filter((commit) => commit.own),
          ...parseGitLogWithFiles(allLog ?? "", email).filter((commit) => !commit.own),
        ],
        unpushedShas: new Set((unpushed ?? "").split("\n").filter((sha) => sha !== "")),
        publishedAtMs: evidence.publishedAtMs,
      });
      const named = projectChangeEntryIds(changes);
      return {
        branch: branch.trim() === "HEAD" ? null : branch.trim(),
        isRepository: true,
        ...changes,
        entries: evidence.entries
          .filter((entry) => named.has(entry.id))
          .map(({ runs: _runs, ...entry }) => entry),
      };
    },
    Effect.mapError(failed("read")),
  );

  return ProjectChangesService.of({ counts, read });
});

export const layer = Layer.effect(ProjectChangesService, make);
