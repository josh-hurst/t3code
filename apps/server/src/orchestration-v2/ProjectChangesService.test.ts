// @effect-diagnostics nodeBuiltinImport:off - Fixtures drive git directly in temp repositories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { type Project, ProjectId, RunId, ThreadEntryId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../config.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as ProjectChangesService from "./ProjectChangesService.ts";

const OWNER_EMAIL = "owner@example.com";

function git(cwd: string, args: ReadonlyArray<string>, env?: Record<string, string>) {
  return NodeChildProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Owner",
      GIT_AUTHOR_EMAIL: OWNER_EMAIL,
      GIT_COMMITTER_NAME: "Owner",
      GIT_COMMITTER_EMAIL: OWNER_EMAIL,
      ...env,
    },
  }).trim();
}

function initRepo(dir: string) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.name", "Owner"]);
  git(dir, ["config", "user.email", OWNER_EMAIL]);
}

function commitFile(dir: string, filename: string, content: string, message: string, iso: string) {
  NodeFS.writeFileSync(NodePath.join(dir, filename), content);
  git(dir, ["add", filename]);
  git(dir, ["commit", "-m", message], {
    GIT_AUTHOR_DATE: iso,
    GIT_COMMITTER_DATE: iso,
  });
  return git(dir, ["rev-parse", "HEAD"]);
}

function makeLayer(projects: ReadonlyMap<ProjectId, string>) {
  const layerDatabase = SqlitePersistence.layerMemory;
  const layerChanges = ProjectChangesService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerDatabase,
        Layer.mock(ProjectService.ProjectService)({
          getById: (id) => {
            const workspaceRoot = projects.get(id);
            return Effect.succeed(
              workspaceRoot === undefined
                ? Option.none()
                : Option.some({ id, workspaceRoot } as Project),
            );
          },
        }),
        GitVcsDriver.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-changes-cfg-" }).pipe(
                Layer.provide(NodeServices.layer),
              ),
              NodeCrypto.layer,
              NodeServices.layer,
            ),
          ),
        ),
        ServerSettings.layerTest({}),
        Layer.mock(TextGeneration.TextGeneration)({}),
        NodeServices.layer,
      ),
    ),
  );
  return Layer.mergeAll(layerDatabase, layerChanges, NodeServices.layer);
}

describe("ProjectChangesService", () => {
  it.live(
    "treats a local-only repo with no remote as having zero unpushed commits, and includes publish-turn commits in that publish",
    () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem;
        const root = yield* fsService.makeTempDirectoryScoped({ prefix: "t3-project-changes-" });
        const localRepo = NodePath.join(root, "local-only");
        const remoteRepo = NodePath.join(root, "with-remote");
        const bareRemote = NodePath.join(root, "remote.git");
        NodeFS.mkdirSync(localRepo);
        NodeFS.mkdirSync(remoteRepo);
        NodeFS.mkdirSync(bareRemote);

        const now = yield* DateTime.now;
        const at = (secondsOffset: number) =>
          DateTime.formatIso(DateTime.add(now, { seconds: secondsOffset }));

        initRepo(localRepo);
        const publishRunRequestedAt = at(-120);
        const publishedAt = at(-100);
        const publishCommitAt = at(-60);
        const publishRunCompletedAt = at(-40);
        const publishSha = commitFile(
          localRepo,
          "update.txt",
          "v2",
          "Publish update",
          publishCommitAt,
        );

        git(bareRemote, ["init", "--bare", "-b", "main"]);
        initRepo(remoteRepo);
        git(remoteRepo, ["remote", "add", "origin", bareRemote]);
        commitFile(remoteRepo, "base.txt", "v1", "Base", at(-300));
        git(remoteRepo, ["push", "-u", "origin", "main"]);
        const unpushedSha = commitFile(remoteRepo, "next.txt", "v2", "Unpushed work", at(-60));

        const localId = ProjectId.make("project:local-only");
        const remoteId = ProjectId.make("project:with-remote");
        const threadId = ThreadId.make("thread:publish");
        const runId = RunId.make("run:publish");
        const remoteThreadId = ThreadId.make("thread:remote");
        const remoteRunId = RunId.make("run:remote");

        const layer = makeLayer(
          new Map([
            [localId, localRepo],
            [remoteId, remoteRepo],
          ]),
        );

        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const service = yield* ProjectChangesService.ProjectChangesService;
          const seedThread = (
            id: ThreadId,
            projectId: ProjectId,
            run: RunId,
            requestedAt: string,
            completedAt: string,
          ) =>
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO orchestration_v2_projection_threads (
                  thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
                  payload_json, created_at, updated_at, deleted_at
                ) VALUES (
                  ${id}, ${projectId}, 'Thread', 'codex', 'full-access', 'default',
                  '{}', ${requestedAt}, ${completedAt}, NULL
                )`;
              yield* sql`
                INSERT INTO orchestration_v2_projection_runs (
                  run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
                ) VALUES (
                  ${run}, ${id}, 1, 'codex', 'completed', ${requestedAt}, ${completedAt}, '{}'
                )`;
            });

          yield* seedThread(threadId, localId, runId, publishRunRequestedAt, publishRunCompletedAt);
          yield* seedThread(remoteThreadId, remoteId, remoteRunId, at(-120), at(-40));
          yield* sql`
            INSERT INTO tide_publish_markers (
              marker_id, project_id, published_at, source_thread_id, cleared_json, undone_at
            ) VALUES (
              'publish:local', ${localId}, ${publishedAt}, ${threadId}, '[]', NULL
            )`;

          const local = yield* service.read({ projectId: localId });
          assert.strictEqual(local.hasRemote, false);
          assert.strictEqual(local.unpushedCommits, 0);
          assert.deepEqual(
            local.commits.map((commit) => [commit.sha, commit.pushed]),
            [[publishSha, true]],
          );
          assert.deepEqual(
            local.periods?.map((period) => [period.publishedAt, period.shas]),
            [[publishedAt, [publishSha]]],
          );

          const remote = yield* service.read({ projectId: remoteId });
          assert.strictEqual(remote.hasRemote, true);
          assert.strictEqual(remote.unpushedCommits, 1);
          assert.strictEqual(
            remote.commits.find((commit) => commit.sha === unpushedSha)?.pushed,
            false,
          );

          const counts = yield* service.counts();
          assert.deepEqual(
            counts.find((row) => row.projectId === localId),
            { projectId: localId, uncommittedFiles: 0, unpushedCommits: 0 },
          );
          assert.deepEqual(
            counts.find((row) => row.projectId === remoteId),
            { projectId: remoteId, uncommittedFiles: 0, unpushedCommits: 1 },
          );
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.live(
    "credits a run only with files it edited, and keeps that once its turn items are gone",
    () =>
      Effect.gen(function* () {
        const fsService = yield* FileSystem.FileSystem;
        const repo = yield* fsService.makeTempDirectoryScoped({ prefix: "t3-project-changes-" });
        const now = yield* DateTime.now;
        const at = (seconds: number) => DateTime.formatIso(DateTime.add(now, { seconds }));
        initRepo(repo);
        commitFile(repo, "README.md", "v1", "Base", at(-600));
        NodeFS.writeFileSync(NodePath.join(repo, "Shop.luau"), "v2");
        // Another session's output, which the run's checkpoint also lists.
        NodeFS.writeFileSync(NodePath.join(repo, "Thumb.png"), "png");

        const projectId = ProjectId.make("project:shop");
        const threadId = ThreadId.make("thread:shop");
        const runId = RunId.make("run:shop");
        const entryId = ThreadEntryId.make("thread:shop:e1");
        yield* Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const service = yield* ProjectChangesService.ProjectChangesService;
          yield* sql`
          INSERT INTO orchestration_v2_projection_threads (
            thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
            payload_json, created_at, updated_at, deleted_at
          ) VALUES (
            ${threadId}, ${projectId}, 'Thread', 'claudeAgent', 'full-access', 'default',
            '{}', ${at(-300)}, ${at(-200)}, NULL
          )`;
          yield* sql`
          INSERT INTO orchestration_v2_projection_runs (
            run_id, thread_id, ordinal, provider, status, requested_at, completed_at, payload_json
          ) VALUES (
            ${runId}, ${threadId}, 1, 'claudeAgent', 'completed', ${at(-300)}, ${at(-200)}, '{}'
          )`;
          yield* sql`
          INSERT INTO orchestration_v2_projection_checkpoints (
            checkpoint_id, thread_id, scope_id, run_id, node_id, parent_checkpoint_id,
            ordinal_within_scope, app_run_ordinal, status, captured_at, payload_json
          ) VALUES (
            'checkpoint:shop', ${threadId}, 'scope:shop', ${runId}, 'node:root', NULL, 1, 1,
            'ready', ${at(-200)}, '{"files":[{"path":"Shop.luau"},{"path":"Thumb.png"}]}'
          )`;
          yield* sql`
          INSERT INTO orchestration_v2_projection_turn_items (
            turn_item_id, thread_id, run_id, node_id, provider_thread_id, provider_turn_id,
            parent_item_id, ordinal, type, status, updated_at, payload_json
          ) VALUES (
            'item:edit', ${threadId}, ${runId}, 'node:edit', NULL, NULL, NULL, 1, 'file_change',
            'completed', ${at(-250)},
            ${`{"type":"file_change","fileName":${JSON.stringify(NodePath.join(repo, "Shop.luau"))}}`}
          )`;
          yield* sql`
          INSERT INTO tide_thread_entries (
            entry_id, thread_id, title, title_source, outcome, open_json, open_count, runs_json,
            start_message_id, end_message_id, started_at, ended_at, status, merged_into
          ) VALUES (
            ${entryId}, ${threadId}, 'Shop', 'model', '', '[]', 0,
            ${`[{"runId":"${runId}","source":"online"}]`}, 'message:start', 'message:end',
            ${at(-300)}, ${at(-200)}, 'active', NULL
          )`;
          const expected = [
            { entryId, files: 1 },
            { entryId: null, files: 1 },
          ];
          assert.deepEqual((yield* service.read({ projectId })).uncommitted.topics, expected);
          // Turn items are read once per finished run; later views use what was kept.
          yield* sql`DELETE FROM orchestration_v2_projection_turn_items`;
          assert.deepEqual((yield* service.read({ projectId })).uncommitted.topics, expected);
        }).pipe(Effect.provide(makeLayer(new Map([[projectId, repo]]))));
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});
