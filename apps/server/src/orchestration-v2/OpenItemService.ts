import {
  CommandId,
  type MarkPublishedResult,
  type MessageId,
  type OpenItemCountsResult,
  ProjectId,
  PublishMarkerId,
  type ThreadCardOpenKind,
  threadCardOpenItemKey,
  ThreadEntryOpenItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectService from "../project/ProjectService.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as VcsStatusBroadcaster from "../vcs/VcsStatusBroadcaster.ts";
import * as ProjectChangesService from "./ProjectChangesService.ts";
import * as RunFinalization from "./RunFinalizationService.ts";
import * as ThreadEntryStore from "./ThreadEntryStore.ts";
import * as ThreadFollowUp from "./ThreadFollowUpService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

/** A second publish this soon after one does not run the project's standing check again. */
const STANDING_CHECK_REPEAT_MINUTES = 5;

export class OpenItemServiceError extends Schema.TaggedError<OpenItemServiceError>()(
  "OpenItemServiceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Open item operation '${this.operation}' failed.`;
  }
}

const ClearedItems = Schema.Array(Schema.Struct({ threadId: ThreadId, item: ThreadEntryOpenItem }));
type ClearedItems = typeof ClearedItems.Type;
const decodeMarkerRows = Schema.decodeUnknownEffect(
  Schema.Array(
    Schema.Struct({
      publishedAt: Schema.String,
      cleared: Schema.fromJsonString(ClearedItems),
    }),
  ),
);
const decodeLatestRows = Schema.decodeUnknownEffect(
  Schema.Array(Schema.Struct({ projectId: ProjectId, publishedAt: Schema.String })),
);
const encodeCleared = Schema.encodeEffect(Schema.fromJsonString(ClearedItems));

/** One owed item, with the thread and message to open for it. */
export interface OpenItem {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly threadTitle: string;
  readonly threadSettled: boolean;
  readonly entryTitle: string;
  readonly messageId: MessageId;
  readonly kind: ThreadCardOpenKind;
  readonly text: string;
  readonly dueAt?: string | undefined;
  /** What `resolveItem` takes. */
  readonly key: string;
}

export class OpenItemService extends Context.Service<
  OpenItemService,
  {
    readonly list: (input: {
      readonly projectIds: ReadonlyArray<ProjectId>;
    }) => Effect.Effect<
      { readonly items: ReadonlyArray<OpenItem>; readonly lastPublishedAt: string | null },
      OpenItemServiceError
    >;
    readonly counts: () => Effect.Effect<OpenItemCountsResult, OpenItemServiceError>;
    /** Clears the projects' `ship` items, records one marker for Undo, and starts what waits on a publish. */
    readonly markPublished: (input: {
      readonly projectIds: ReadonlyArray<ProjectId>;
      readonly threadId?: ThreadId | undefined;
    }) => Effect.Effect<MarkPublishedResult, OpenItemServiceError>;
    /** Puts the cleared items back on threads whose card has not been rewritten since. */
    readonly undoPublished: (
      markerId: PublishMarkerId,
    ) => Effect.Effect<{ readonly restored: number }, OpenItemServiceError>;
    readonly resolveItem: (input: {
      readonly threadId: ThreadId;
      readonly key: string;
    }) => Effect.Effect<void, OpenItemServiceError>;
    /** Clears `commit` items of threads working in `cwd`, which has no working-tree changes. */
    readonly resolveForCheckout: (cwd: string) => Effect.Effect<number, OpenItemServiceError>;
    /** Re-reads the projects' checkouts that owe a commit and clears those that are clean. */
    readonly refresh: (
      projectIds: ReadonlyArray<ProjectId>,
    ) => Effect.Effect<number, OpenItemServiceError>;
  }
>()("t3/orchestration-v2/OpenItemService") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const store = yield* ThreadEntryStore.ThreadEntryStore;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const followUps = yield* ThreadFollowUp.ThreadFollowUpService;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const vcsStatus = yield* VcsStatusBroadcaster.VcsStatusBroadcaster;
  const projectChanges = yield* ProjectChangesService.ProjectChangesService;
  const random = yield* SecureRandom.SecureRandom;
  const failed = (operation: string) => (cause: unknown) =>
    new OpenItemServiceError({ operation, cause });

  /** One thread's command failing must not stop the others. The rows that went through. */
  const dispatchEach = <A, E>(
    rows: ReadonlyArray<A>,
    dispatch: (row: A) => Effect.Effect<unknown, E>,
  ) =>
    Effect.forEach(rows, (row) =>
      dispatch(row).pipe(
        Effect.as([row]),
        Effect.catch((cause) =>
          Effect.logWarning("Open item command failed", { cause }).pipe(Effect.as([])),
        ),
      ),
    ).pipe(Effect.map((sent) => sent.flat()));

  const latestPublishes = (projectIds: ReadonlyArray<ProjectId> | undefined) =>
    sql`
      SELECT project_id AS "projectId", MAX(published_at) AS "publishedAt"
      FROM tide_publish_markers
      WHERE ${sql.and([
        sql`undone_at IS NULL`,
        ...(projectIds === undefined ? [] : [sql`project_id IN ${sql.in(projectIds)}`]),
      ])}
      GROUP BY project_id
    `.pipe(Effect.flatMap(decodeLatestRows));

  const list: OpenItemService["Service"]["list"] = Effect.fn("OpenItemService.list")(
    function* ({ projectIds }) {
      const rows = yield* store.openItems({ projectIds });
      const latest = projectIds.length === 0 ? [] : yield* latestPublishes(projectIds);
      return {
        items: rows.map(
          ({ item, worktreePath: _worktreePath, cardAt: _cardAt, entryId: _entryId, ...row }) => ({
            ...row,
            kind: item.kind,
            text: item.text,
            ...(item.dueAt === undefined ? {} : { dueAt: item.dueAt }),
            key: threadCardOpenItemKey(item),
          }),
        ),
        lastPublishedAt: latest.reduce<string | null>(
          (last, row) => (last === null || row.publishedAt > last ? row.publishedAt : last),
          null,
        ),
      };
    },
    Effect.mapError(failed("list")),
  );

  const counts: OpenItemService["Service"]["counts"] = Effect.fn("OpenItemService.counts")(
    function* () {
      const [byProject, latest, changed] = yield* Effect.all([
        store.counts(),
        latestPublishes(undefined),
        // Git being unreadable must not take the open items with it.
        projectChanges
          .counts()
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Reading project change counts failed", { cause }).pipe(
                Effect.as([]),
              ),
            ),
          ),
      ]);
      const published = new Map(latest.map((row) => [row.projectId, row.publishedAt]));
      const changesOf = new Map(
        changed.map(({ projectId, ...changes }) => [projectId, changes] as const),
      );
      const projectIds = new Set([
        ...byProject.map((row) => row.projectId),
        ...published.keys(),
        ...changed
          .filter((row) => row.uncommittedFiles > 0 || row.unpushedCommits > 0)
          .map((row) => row.projectId),
      ]);
      const countsOf = new Map(byProject.map((row) => [row.projectId, row.counts]));
      return {
        projects: [...projectIds].map((projectId) => {
          const changes = changesOf.get(projectId);
          return {
            projectId,
            counts: countsOf.get(projectId) ?? {
              ask: 0,
              verify: 0,
              commit: 0,
              ship: 0,
              followup: 0,
            },
            lastPublishedAt: published.get(projectId) ?? null,
            ...(changes === undefined ? {} : { changes }),
          };
        }),
      };
    },
    Effect.mapError(failed("counts")),
  );

  /** Runs the scheduled task bound to each project's standing-check thread. */
  const runStandingChecks = Effect.fn("OpenItemService.runStandingChecks")(function* (
    due: ReadonlyArray<ProjectId>,
  ) {
    if (due.length === 0) return;
    const { tasks } = yield* scheduledTasks.list();
    const bound = tasks.filter(
      (task) => task.enabled && task.threadId !== null && due.includes(task.projectId),
    );
    yield* dispatchEach(bound, (task) =>
      Effect.gen(function* () {
        const shell = yield* threads.getThreadShell(task.threadId!);
        if (shell?.standingCheck !== true || shell.deletedAt !== null) return;
        yield* scheduledTasks.runNow({ id: task.id });
      }),
    );
  });

  const markPublished: OpenItemService["Service"]["markPublished"] = Effect.fn(
    "OpenItemService.markPublished",
  )(
    function* ({ projectIds, threadId }) {
      const now = yield* DateTime.now;
      const publishedAt = DateTime.formatIso(now);
      const markerId = PublishMarkerId.make(`publish:${yield* random.uuidV4()}`);
      const ship = yield* store.openItems({ projectIds, kind: "ship" });
      const recent = DateTime.formatIso(
        DateTime.subtract(now, { minutes: STANDING_CHECK_REPEAT_MINUTES }),
      );
      const justPublished = new Set(
        (yield* latestPublishes(projectIds))
          .filter((row) => row.publishedAt > recent)
          .map((row) => row.projectId),
      );
      for (const projectId of new Set(projectIds)) {
        const cleared = ship
          .filter((row) => row.projectId === projectId)
          .map((row) => ({ threadId: row.threadId, item: row.item }));
        yield* sql`
          INSERT INTO tide_publish_markers (
            marker_id, project_id, published_at, source_thread_id, cleared_json, undone_at
          ) VALUES (
            ${`${markerId}:${projectId}`}, ${projectId}, ${publishedAt}, ${threadId ?? null},
            ${yield* encodeCleared(cleared)}, NULL
          )
        `;
      }
      const threadIds = [...new Set(ship.map((row) => row.threadId))];
      yield* dispatchEach(threadIds, (shipThreadId) =>
        threads.dispatch({
          type: "thread.open-items.resolve",
          commandId: CommandId.make(`publish:${markerId}:${shipThreadId}`),
          threadId: shipThreadId,
          kinds: ["ship"],
        }),
      );
      const followUpsStarted = yield* followUps
        .releaseForProjects(projectIds, now)
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Releasing after-publish follow-ups failed", { cause }).pipe(
              Effect.as(0),
            ),
          ),
        );
      yield* runStandingChecks(
        [...new Set(projectIds)].filter((projectId) => !justPublished.has(projectId)),
      ).pipe(
        Effect.catch((cause) =>
          Effect.logWarning("Running standing checks after a publish failed", { cause }),
        ),
      );
      return { markerId, cleared: ship.length, followUpsStarted };
    },
    Effect.mapError(failed("markPublished")),
  );

  // One row per project, `${markerId}:${projectId}`; a range, as LIKE would read `%` in an id.
  const markerRows = (markerId: PublishMarkerId) =>
    sql`marker_id > ${`${markerId}:`} AND marker_id < ${`${markerId};`}`;

  const undoPublished: OpenItemService["Service"]["undoPublished"] = Effect.fn(
    "OpenItemService.undoPublished",
  )(
    function* (markerId) {
      const rows = yield* decodeMarkerRows(
        yield* sql`
          SELECT published_at AS "publishedAt", cleared_json AS "cleared"
          FROM tide_publish_markers
          WHERE ${markerRows(markerId)} AND undone_at IS NULL
        `,
      );
      const byThread = new Map<ThreadId, Array<ThreadEntryOpenItem>>();
      for (const row of rows) {
        for (const { threadId, item } of row.cleared) {
          byThread.set(threadId, [...(byThread.get(threadId) ?? []), item]);
        }
      }
      const publishedAt = rows[0]?.publishedAt;
      const restorable: Array<[ThreadId, Array<ThreadEntryOpenItem>]> = [];
      for (const [threadId, items] of byThread) {
        const shell = yield* threads.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null) continue;
        // A card written since the publish already says what is still owed.
        const cardAt = shell.card?.at;
        if (publishedAt === undefined || (cardAt !== undefined && cardAt > publishedAt)) continue;
        restorable.push([threadId, items]);
      }
      const sent = yield* dispatchEach(restorable, ([threadId, items]) =>
        threads.dispatch({
          type: "thread.open-items.restore",
          commandId: CommandId.make(`publish-undo:${markerId}:${threadId}`),
          threadId,
          items,
        }),
      );
      yield* sql`
        UPDATE tide_publish_markers SET undone_at = ${DateTime.formatIso(yield* DateTime.now)}
        WHERE ${markerRows(markerId)} AND undone_at IS NULL
      `;
      return { restored: sent.reduce((total, [, items]) => total + items.length, 0) };
    },
    Effect.mapError(failed("undoPublished")),
  );

  const resolveItem: OpenItemService["Service"]["resolveItem"] = Effect.fn(
    "OpenItemService.resolveItem",
  )(
    function* ({ threadId, key }) {
      yield* threads.dispatch({
        type: "thread.open-items.resolve",
        commandId: CommandId.make(`open-items:done:${yield* random.uuidV4()}`),
        threadId,
        key,
      });
    },
    Effect.mapError(failed("resolveItem")),
  );

  /** Where each thread owing a commit works: its worktree, else its project's root. */
  const commitCheckouts = Effect.fn("OpenItemService.commitCheckouts")(function* (
    projectIds?: ReadonlyArray<ProjectId>,
  ) {
    const rows = yield* store.openItems({
      ...(projectIds === undefined ? {} : { projectIds }),
      kind: "commit",
    });
    const roots = new Map<ProjectId, string | null>();
    const checkouts = new Map<ThreadId, { readonly cwd: string; readonly cardAt: string | null }>();
    for (const row of rows) {
      if (checkouts.has(row.threadId)) continue;
      let cwd = row.worktreePath;
      if (cwd === null) {
        if (!roots.has(row.projectId)) {
          const project = yield* projects.getById(row.projectId);
          roots.set(row.projectId, Option.isSome(project) ? project.value.workspaceRoot : null);
        }
        cwd = roots.get(row.projectId) ?? null;
      }
      if (cwd !== null) checkouts.set(row.threadId, { cwd, cardAt: row.cardAt });
    }
    return checkouts;
  });

  const clearCommits = (
    checkouts: ReadonlyMap<ThreadId, { readonly cwd: string; readonly cardAt: string | null }>,
    clean: (cwd: string) => boolean,
  ) =>
    dispatchEach(
      [...checkouts].filter(([, checkout]) => clean(checkout.cwd)),
      ([threadId, checkout]) =>
        threads.dispatch({
          type: "thread.open-items.resolve",
          commandId: CommandId.make(`open-items:clean:${threadId}:${checkout.cardAt ?? "none"}`),
          threadId,
          kinds: ["commit"],
        }),
    );

  const resolveForCheckout: OpenItemService["Service"]["resolveForCheckout"] = Effect.fn(
    "OpenItemService.resolveForCheckout",
  )(
    function* (cwd) {
      const cleared = yield* clearCommits(yield* commitCheckouts(), (checkout) => checkout === cwd);
      return cleared.length;
    },
    Effect.mapError(failed("resolveForCheckout")),
  );

  const refresh: OpenItemService["Service"]["refresh"] = Effect.fn("OpenItemService.refresh")(
    function* (projectIds) {
      if (projectIds.length === 0) return 0;
      const checkouts = yield* commitCheckouts(projectIds);
      const clean = new Set<string>();
      for (const cwd of new Set([...checkouts.values()].map((checkout) => checkout.cwd))) {
        const local = yield* vcsStatus
          .refreshLocalStatus(cwd)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Could not read a checkout's status", { cwd, cause }).pipe(
                Effect.as(null),
              ),
            ),
          );
        if (local?.isRepo === true && !local.hasWorkingTreeChanges) clean.add(cwd);
      }
      return (yield* clearCommits(checkouts, (cwd) => clean.has(cwd))).length;
    },
    Effect.mapError(failed("refresh")),
  );

  return OpenItemService.of({
    list,
    counts,
    markPublished,
    undoPublished,
    resolveItem,
    resolveForCheckout,
    refresh,
  });
});

export const layer = Layer.effect(OpenItemService, make);

/** What run finalization calls when a turn leaves its checkout clean. */
export const layerCleanCheckout = Layer.effect(
  RunFinalization.RunFinalizationCleanCheckout,
  Effect.gen(function* () {
    const openItems = yield* OpenItemService;
    return (cwd: string) =>
      openItems.resolveForCheckout(cwd).pipe(
        Effect.asVoid,
        Effect.catch((cause) =>
          Effect.logWarning("Clearing commit items for a clean checkout failed", { cwd, cause }),
        ),
      );
  }),
);
