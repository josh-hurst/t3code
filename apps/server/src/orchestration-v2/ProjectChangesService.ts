import {
  IsoDateTime,
  MessageId,
  type ProjectChangeCounts,
  ProjectChangeItem,
  type ProjectChangesResult,
  ProjectId,
  RunId,
  type SummarizeProjectChangesResult,
  ThreadEntryId,
  ThreadEntryRun,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildProjectChangelogPrompt,
  changelogFolders,
  CHANGELOG_COMMITS_MAX,
  parseProjectChangelog,
} from "../textGeneration/ProjectChangelog.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  assembleTouches,
  buildProjectChanges,
  changePeriods,
  collectRunWork,
  earlierChangelog,
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
/** Periods summarized per request, newest first; the rest wait for the next one. */
const SUMMARIZE_PERIODS_MAX = 4;

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
const decodeRunWork = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      runId: RunId,
      edited: Schema.NullOr(Schema.String),
      command: Schema.NullOr(Schema.String),
    }),
  ),
);
const decodeProjectIds = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ projectId: ProjectId })),
);
const Digest = Schema.fromJsonString(
  Schema.Struct({
    items: Schema.Array(ProjectChangeItem),
    labels: Schema.Record(Schema.String, Schema.String),
  }),
);
const decodeDigests = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ key: Schema.String, digest: Digest })),
);
const encodeDigest = Schema.encodeEffect(Digest);
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const decodePublishes = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      publishedAt: IsoDateTime,
      runCompletedAt: Schema.NullOr(IsoDateTime),
    }),
  ),
);

const EMPTY: ProjectChangesResult = {
  branch: null,
  isRepository: false,
  uncommitted: { files: 0, topics: [] },
  unpushedCommits: 0,
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
    /**
     * Writes the changelog of each period that has none, a model call apiece, a few per call.
     * Does nothing while reply summaries are off. The count of periods written.
     */
    readonly summarize: (input: {
      readonly projectId: ProjectId;
    }) => Effect.Effect<SummarizeProjectChangesResult, ProjectChangesError>;
  }
>()("t3/orchestration-v2/ProjectChangesService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const projects = yield* ProjectService.ProjectService;
  const git = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const textGeneration = yield* TextGeneration.TextGeneration;
  const fileSystem = yield* FileSystem.FileSystem;
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

  const readPublishes = Effect.fn("ProjectChangesService.readPublishes")(function* (
    projectId: ProjectId,
    since: string,
    nowIso: string,
  ) {
    const rows = yield* decodePublishes(
      yield* sql`
        SELECT
          m.published_at AS "publishedAt",
          (
            SELECT CASE
              WHEN r.completed_at IS NOT NULL THEN r.completed_at
              WHEN r.status IN ('running', 'starting') THEN ${nowIso}
              ELSE NULL
            END
            FROM orchestration_v2_projection_runs r
            WHERE r.thread_id = m.source_thread_id
              AND r.requested_at <= m.published_at
              AND (r.completed_at IS NULL OR r.completed_at >= m.published_at)
            ORDER BY r.requested_at DESC
            LIMIT 1
          ) AS "runCompletedAt"
        FROM tide_publish_markers m
        WHERE m.project_id = ${projectId} AND m.undone_at IS NULL AND m.published_at >= ${since}
      `,
    );
    return rows.map((row) => ({
      publishedAtMs: Date.parse(row.publishedAt),
      ...(row.runCompletedAt === null ? {} : { closedAtMs: Date.parse(row.runCompletedAt) }),
    }));
  });

  const loadEvidence = Effect.fn("ProjectChangesService.loadEvidence")(function* (
    projectId: ProjectId,
    workspaceRoot: string,
    since: string,
    nowIso: string,
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
    // File edits and agent commands of each run that changed the checkout, its native
    // subagents' included. The joins are pinned: a free planner scans every turn item for the subagent half.
    const work = yield* decodeRunWork(
      yield* sql`
        WITH changed AS MATERIALIZED (
          SELECT DISTINCT c.run_id, c.thread_id
          FROM orchestration_v2_projection_checkpoints c
          JOIN orchestration_v2_projection_threads t ON t.thread_id = c.thread_id
          WHERE t.project_id = ${projectId}
            AND c.run_id IS NOT NULL
            AND c.captured_at >= ${since}
            AND json_array_length(c.payload_json, '$.files') > 0
        ), own AS MATERIALIZED (
          SELECT
            changed.run_id,
            i.type,
            CASE WHEN i.type = 'file_change' THEN i.payload_json END AS edit,
            -- T3's own "Preparing workspace" step is a command no agent ran.
            CASE
              WHEN i.type = 'command_execution'
                AND json_extract(i.payload_json, '$.nativeItemRef') IS NOT NULL
              THEN json_extract(i.payload_json, '$.input')
            END AS command
          FROM changed
          CROSS JOIN orchestration_v2_projection_turn_items i
          WHERE i.run_id = changed.run_id AND i.type IN ('file_change', 'command_execution')
          UNION ALL
          SELECT
            changed.run_id,
            i.type,
            CASE WHEN i.type = 'file_change' THEN i.payload_json END,
            CASE
              WHEN i.type = 'command_execution'
                AND json_extract(i.payload_json, '$.nativeItemRef') IS NOT NULL
              THEN json_extract(i.payload_json, '$.input')
            END
          FROM changed
          CROSS JOIN orchestration_v2_projection_subagents s
          CROSS JOIN orchestration_v2_projection_turn_items i
          WHERE s.thread_id = changed.thread_id
            AND s.run_id = changed.run_id
            AND i.thread_id = s.child_thread_id
            AND i.type IN ('file_change', 'command_execution')
        )
        SELECT run_id AS "runId", NULL AS edited, command FROM own WHERE command IS NOT NULL
        UNION
        SELECT run_id, json_extract(edit, '$.fileName'), NULL FROM own WHERE edit IS NOT NULL
        UNION
        SELECT own.run_id, json_extract(change.value, '$.path'), NULL
        FROM own, json_each(own.edit, '$.changes') change
        WHERE json_extract(change.value, '$.path') IS NOT NULL
      `,
    );
    const publishes = yield* readPublishes(projectId, since, nowIso);
    return {
      touches: assembleTouches({
        threads,
        entries,
        runStartedAtMs: new Map(runs.map((row) => [row.runId, Date.parse(row.requestedAt)])),
        runWork: collectRunWork(work, workspaceRoot),
        checkpoints: checkpoints.map((checkpoint) => ({
          threadId: checkpoint.threadId,
          runId: checkpoint.runId,
          capturedAtMs: Date.parse(checkpoint.capturedAt),
          paths: checkpoint.paths,
        })),
      }),
      entries,
      publishes,
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
            const [status, remotes] = yield* Effect.all(
              [run(cwd, "status", statusArgs), run(cwd, "remotes", ["remote"])],
              { concurrency: 2 },
            );
            if (status === null) return [];
            const hasRemote = (remotes ?? "").trim() !== "";
            const unpushed = hasRemote
              ? // The same commits the project's change list marks as not pushed.
                yield* run(cwd, "unpushedCount", [
                  "rev-list",
                  "--count",
                  "--no-merges",
                  `--since=${since}`,
                  "HEAD",
                  "--not",
                  "--remotes",
                ])
              : null;
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

  const logArgs = (since: string, format: string, extra: ReadonlyArray<string>) => [
    "-c",
    "core.quotepath=off",
    "log",
    "--no-merges",
    `--since=${since}`,
    `--format=${format}`,
    ...extra,
    "HEAD",
  ];
  /**
   * The owner's commits with their bodies and files. A busy upstream must not crowd them out of
   * the cap, so other authors' commits are read apart.
   */
  const readOwnCommits = Effect.fn("ProjectChangesService.readOwnCommits")(function* (
    cwd: string,
    since: string,
  ) {
    const email = (yield* run(cwd, "user", ["config", "user.email"]))?.trim() || null;
    const log = yield* run(
      cwd,
      "ownLog",
      logArgs(since, "%x1e%H%x1f%ct%x1f%an%x1f%ae%x1f%s%x1f%b%x1d", [
        `--max-count=${OWN_COMMITS_MAX}`,
        "--name-only",
        ...(email === null ? [] : ["--fixed-strings", `--author=<${email}>`]),
      ]),
    );
    return {
      email,
      commits: parseGitLogWithFiles(log ?? "", email).filter((commit) => commit.own),
    };
  });

  const readUnpushed = Effect.fn("ProjectChangesService.readUnpushed")(function* (
    cwd: string,
    since: string,
  ) {
    const remotes = yield* run(cwd, "remotes", ["remote"]);
    if ((remotes ?? "").trim() === "") return { hasRemote: false, shas: new Set<string>() };
    // On no remote branch at all, so a branch without an upstream still reads right.
    const unpushed = yield* run(cwd, "unpushed", [
      "rev-list",
      `--since=${since}`,
      "HEAD",
      "--not",
      "--remotes",
    ]);
    return {
      hasRemote: true,
      shas: new Set((unpushed ?? "").split("\n").filter((sha) => sha !== "")),
    };
  });

  const readDigests = Effect.fn("ProjectChangesService.readDigests")(function* (
    projectId: ProjectId,
  ) {
    const rows = yield* decodeDigests(
      yield* sql`
        SELECT period_key AS key, digest_json AS digest
        FROM tide_change_digests
        WHERE project_id = ${projectId}
      `,
    );
    return new Map(rows.map((row) => [row.key, row.digest]));
  });

  const historyWindow = DateTime.now.pipe(
    Effect.map((now) => ({
      nowIso: DateTime.formatIso(now),
      since: DateTime.formatIso(DateTime.subtract(now, { days: HISTORY_DAYS })),
    })),
  );

  const read: ProjectChangesService["Service"]["read"] = Effect.fn("ProjectChangesService.read")(
    function* ({ projectId }) {
      const project = yield* projects.getById(projectId);
      if (Option.isNone(project)) return EMPTY;
      const cwd = project.value.workspaceRoot;
      const branch = yield* run(cwd, "branch", ["rev-parse", "--abbrev-ref", "HEAD"]);
      if (branch === null) return EMPTY;
      const { since, nowIso } = yield* historyWindow;
      const [status, own, allLog, unpushed, evidence, digests] = yield* Effect.all(
        [
          run(cwd, "status", statusArgs),
          readOwnCommits(cwd, since),
          run(
            cwd,
            "allLog",
            logArgs(since, "%x1e%H%x1f%ct%x1f%an%x1f%ae%x1f%s", [`--max-count=${ALL_COMMITS_MAX}`]),
          ),
          readUnpushed(cwd, since),
          loadEvidence(projectId, cwd, since, nowIso),
          readDigests(projectId),
        ],
        { concurrency: "unbounded" },
      );
      const changes = buildProjectChanges({
        touches: evidence.touches,
        dirtyPaths: parseGitStatusPaths(status ?? ""),
        commits: [
          ...own.commits,
          ...(own.email === null
            ? []
            : parseGitLogWithFiles(allLog ?? "", own.email).filter((commit) => !commit.own)),
        ],
        unpushedShas: unpushed.shas,
        publishedAtMs: evidence.publishes.map((publish) => publish.publishedAtMs),
      });
      const named = projectChangeEntryIds(changes);
      return {
        branch: branch.trim() === "HEAD" ? null : branch.trim(),
        isRepository: true,
        hasRemote: unpushed.hasRemote,
        ...changes,
        entries: evidence.entries
          .filter((entry) => named.has(entry.id))
          .map(({ runs: _runs, ...entry }) => entry),
        periods: changePeriods({
          ownCommits: own.commits,
          publishedAtMs: evidence.publishes,
        }).map((period) => {
          const shas = period.commits.map((commit) => commit.sha).toReversed();
          const own = digests.get(period.key);
          const earlier = own === undefined ? earlierChangelog(shas, digests) : null;
          const changelog = own ?? earlier?.changelog;
          return {
            key: period.key,
            publishedAt: period.publishedAtMs === null ? null : iso(period.publishedAtMs),
            startedAt: iso(period.commits[0]!.committedAtMs),
            endedAt: iso(period.commits.at(-1)!.committedAtMs),
            shas,
            items: changelog?.items ?? null,
            labels: changelog?.labels ?? {},
            ...(earlier === null ? {} : { stale: true }),
          };
        }),
      };
    },
    Effect.mapError(failed("read")),
  );

  const summarizing = yield* Ref.make<ReadonlySet<ProjectId>>(new Set());

  const summarize: ProjectChangesService["Service"]["summarize"] = Effect.fn(
    "ProjectChangesService.summarize",
  )(
    function* ({ projectId }) {
      const settings = yield* serverSettings.getSettings;
      if (settings.threadReplySummariesEnabled !== true) return { summarized: 0 };
      const project = yield* projects.getById(projectId);
      if (Option.isNone(project)) return { summarized: 0 };
      // A second window asking while the first is still writing must not pay for the same call.
      const claimed = yield* Ref.modify(summarizing, (held) =>
        held.has(projectId) ? [false, held] : [true, new Set([...held, projectId])],
      );
      if (!claimed) return { summarized: 0 };
      return yield* Effect.gen(function* () {
        const cwd = project.value.workspaceRoot;
        const { since, nowIso } = yield* historyWindow;
        const [own, publishedAtMs, digests] = yield* Effect.all([
          readOwnCommits(cwd, since),
          readPublishes(projectId, since, nowIso),
          readDigests(projectId),
        ]);
        const periods = changePeriods({ ownCommits: own.commits, publishedAtMs });
        const missing = periods
          .filter((period) => !digests.has(period.key))
          .slice(0, SUMMARIZE_PERIODS_MAX);
        // Providers run in a working directory; a changelog must not read the checkout.
        const scratch = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-changelog-" });
        const writeChangelog = Effect.fn("ProjectChangesService.writeChangelog")(function* (
          period: (typeof periods)[number],
        ) {
          const store = Effect.fn("ProjectChangesService.storeChangelog")(function* (
            changelog: typeof Digest.Type,
          ) {
            yield* sql`
                INSERT INTO tide_change_digests (project_id, period_key, digest_json, generated_at)
                VALUES (
                  ${projectId}, ${period.key}, ${yield* encodeDigest(changelog)},
                  ${DateTime.formatIso(yield* DateTime.now)}
                )
                ON CONFLICT (project_id, period_key) DO UPDATE SET
                  digest_json = excluded.digest_json,
                  generated_at = excluded.generated_at
              `;
            return period.key;
          });
          // Commits aging out of the window only shrink a period; its old changelog still fits.
          const earlier = earlierChangelog(
            period.commits.map((commit) => commit.sha),
            digests,
          )?.changelog;
          const coveredByEarlier = new Set(earlier?.items.flatMap((item) => item.shas));
          if (earlier && period.commits.every((commit) => coveredByEarlier.has(commit.sha))) {
            return yield* store(earlier);
          }
          const commits = period.commits.slice(-CHANGELOG_COMMITS_MAX).map((commit) => ({
            sha: commit.sha,
            subject: commit.subject,
            body: commit.body,
            files: commit.files.length,
            folders: changelogFolders(commit.files),
          }));
          const generated = yield* textGeneration.generateTranscriptionPostProcessing({
            cwd: scratch,
            prompt: buildProjectChangelogPrompt(commits),
            modelSelection: settings.threadReplySummaryModelSelection,
          });
          // The prompt numbers these commits, so the reply's numbers index the same list.
          const parsed = parseProjectChangelog(generated.transcription, commits);
          if (parsed === null) return null;
          // Commits past the cap were never shown to the model; they still belong in the list.
          const uncounted = period.commits.slice(0, -CHANGELOG_COMMITS_MAX);
          const changelog =
            uncounted.length === 0
              ? parsed
              : {
                  ...parsed,
                  items: [
                    ...parsed.items,
                    {
                      title: "Earlier commits",
                      summary: "",
                      shas: uncounted.map((commit) => commit.sha),
                    },
                  ],
                };
          return yield* store(changelog);
        });
        const written = yield* Effect.forEach(missing, writeChangelog, {
          concurrency: SUMMARIZE_PERIODS_MAX,
        });
        const done = new Set(written.filter((key) => key !== null));
        // A period's key moves with every commit, so old rows pile up. One stays while it is
        // still what a period without its own changelog shows.
        const kept = periods.flatMap((period) => {
          if (digests.has(period.key) || done.has(period.key)) return [period.key];
          const shas = period.commits.map((commit) => commit.sha);
          const earlier = earlierChangelog(shas, digests);
          return earlier === null ? [period.key] : [period.key, earlier.key];
        });
        if (kept.length > 0) {
          yield* sql`
            DELETE FROM tide_change_digests
            WHERE project_id = ${projectId} AND period_key NOT IN ${sql.in(kept)}
          `;
        }
        return { summarized: done.size };
      }).pipe(
        Effect.scoped,
        Effect.ensuring(
          Ref.update(summarizing, (held) => new Set([...held].filter((id) => id !== projectId))),
        ),
      );
    },
    Effect.mapError(failed("summarize")),
  );

  return ProjectChangesService.of({ counts, read, summarize });
});

export const layer = Layer.effect(ProjectChangesService, make);
