import { assert, it } from "@effect/vitest";
import {
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type ThreadCard,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";

import type * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SemanticEmbedder from "./SemanticEmbedder.ts";
import * as SemanticSearchService from "./SemanticSearchService.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const at = (minute: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 1, 0, minute));

/**
 * Deterministic bag-of-concepts fake embedder (4 dims):
 * [volleyball/button/ml/telemetry, auth/oauth/token, database/sql/migration, ui/css/layout]
 */
function conceptVector(text: string): Float32Array {
  const lower = text.toLowerCase();
  const raw = [
    /(volleyball|slap|button|telemetry|ml\b|machine learning|controls)/.test(lower) ? 1 : 0.05,
    /(oauth|token|login|session|auth)/.test(lower) ? 1 : 0.05,
    /(sqlite|migration|schema|index|query)/.test(lower) ? 1 : 0.05,
    /(sidebar|palette|theme|css)/.test(lower) ? 1 : 0.05,
  ];
  let norm = 0;
  for (const v of raw) norm += v * v;
  const inv = 1 / Math.sqrt(norm);
  return Float32Array.from(raw, (v) => v * inv);
}

const makeFakeEmbedder = (options?: { readonly modelId?: string; readonly fail?: boolean }) => {
  const embeddedPassages: string[] = [];
  const embeddedQueries: string[] = [];
  const layer = Layer.succeed(
    SemanticEmbedder.SemanticEmbedder,
    SemanticEmbedder.SemanticEmbedder.of({
      modelId: options?.modelId ?? "fake/bge-small-v1",
      dimensions: 4,
      embedPassages: (texts) => {
        if (options?.fail) {
          return Effect.fail(new SemanticEmbedder.SemanticEmbedderError({ stage: "embed" }));
        }
        embeddedPassages.push(...texts);
        return Effect.succeed(texts.map(conceptVector));
      },
      embedQuery: (query) => {
        if (options?.fail) {
          return Effect.fail(new SemanticEmbedder.SemanticEmbedderError({ stage: "embed" }));
        }
        embeddedQueries.push(query);
        return Effect.succeed(conceptVector(query));
      },
      shutdown: Effect.void,
    }),
  );
  return { layer, embeddedPassages, embeddedQueries };
};

const makeTestLayer = (options?: {
  readonly embedder?: Layer.Layer<SemanticEmbedder.SemanticEmbedder>;
  readonly semanticSearchEnabled?: boolean;
}) => {
  const embedderLayer = options?.embedder ?? makeFakeEmbedder().layer;
  const settingsLayer = ServerSettings.layerTest(
    options?.semanticSearchEnabled === undefined
      ? {}
      : { semanticSearchEnabled: options.semanticSearchEnabled },
  );
  return Layer.mergeAll(
    SemanticSearchService.layer.pipe(Layer.provide(Layer.mergeAll(embedderLayer, settingsLayer))),
    ProjectionStore.layer,
    ProjectStore.layer,
  ).pipe(Layer.provideMerge(SqlitePersistence.layerMemory));
};

const createProject = (projectId: ProjectId, title: string) =>
  Effect.flatMap(ProjectStore.ProjectStoreV2, (projects) =>
    projects.apply({
      sequence: 0,
      eventId: EventId.make(`created:${projectId}`),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: DateTime.formatIso(at(0)),
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.created",
      payload: {
        projectId,
        title,
        workspaceRoot: `/work/${projectId}`,
        defaultModelSelection: null,
        scripts: [],
        createdAt: DateTime.formatIso(at(0)),
        updatedAt: DateTime.formatIso(at(0)),
      },
    }),
  );

const makeThreadEvent = (
  threadId: ThreadId,
  projectId: ProjectId,
  title: string,
  overrides: {
    readonly archivedAt?: DateTime.Utc;
    readonly deletedAt?: DateTime.Utc;
    readonly subagentOf?: ThreadId;
    readonly sideChatOf?: ThreadId;
    readonly card?: Pick<ThreadCard, "line" | "topics">;
  } = {},
): Extract<OrchestrationV2DomainEvent, { readonly type: "thread.created" }> => ({
  id: EventId.make(`created:${threadId}`),
  type: "thread.created",
  threadId,
  providerInstanceId,
  occurredAt: at(0),
  payload: {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title,
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    linkedPullRequest: null,
    branchPullRequest: null,
    activeProviderThreadId: null,
    lineage: overrides.subagentOf
      ? {
          parentThreadId: overrides.subagentOf,
          relationshipToParent: "subagent",
          rootThreadId: overrides.subagentOf,
        }
      : overrides.sideChatOf
        ? {
            parentThreadId: overrides.sideChatOf,
            relationshipToParent: "fork",
            rootThreadId: overrides.sideChatOf,
            sideChat: true,
          }
        : { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at(0),
    updatedAt: at(0),
    archivedAt: overrides.archivedAt ?? null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: overrides.deletedAt ?? null,
    ...(overrides.card
      ? {
          card: {
            ...overrides.card,
            open: [],
            messageId: MessageId.make(`card:${threadId}`),
            at: DateTime.formatIso(at(0)),
            runId: RunId.make(`run:${threadId}:card`),
          },
        }
      : {}),
  },
});

const makeMessageEvent = (
  threadId: ThreadId,
  id: string,
  role: "user" | "assistant",
  text: string,
  options: {
    readonly minute?: number;
    readonly streaming?: boolean;
    readonly createdBy?: "user" | "agent";
  } = {},
): OrchestrationV2DomainEvent => ({
  id: EventId.make(`msg:${id}:${options.minute ?? 1}`),
  type: "message.updated",
  threadId,
  providerInstanceId,
  occurredAt: at(options.minute ?? 1),
  payload: {
    createdBy: options.createdBy ?? (role === "user" ? "user" : "agent"),
    creationSource: role === "user" ? "web" : "provider",
    id: MessageId.make(id),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdAt: at(options.minute ?? 1),
    updatedAt: at(options.minute ?? 1),
  },
});

it.effect("sweep indexes eligible threads, skips ineligible ones, and searches by meaning", () => {
  const fake = makeFakeEmbedder();
  return Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const semantic = yield* SemanticSearchService.SemanticSearchService;

    const projectA = ProjectId.make("project:slap");
    const projectB = ProjectId.make("project:auth");
    const telemetryThread = ThreadId.make("thread:telemetry");
    const authThread = ThreadId.make("thread:auth");
    const archivedThread = ThreadId.make("thread:archived");
    const deletedThread = ThreadId.make("thread:deleted");
    const subagentThread = ThreadId.make("thread:subagent");
    const sideChatThread = ThreadId.make("thread:sidechat");

    yield* createProject(projectA, "Slap Volleyball");
    yield* createProject(projectB, "Auth Service");
    yield* Effect.forEach(
      [
        makeThreadEvent(telemetryThread, projectA, "Customizable Button Layout Telemetry", {
          card: {
            line: "Captured control positions for training",
            topics: ["button telemetry"],
          },
        }),
        makeMessageEvent(
          telemetryThread,
          "u-1",
          "user",
          "Add telemetry so ML can find optimal button layouts on mobile screens",
          { minute: 1 },
        ),
        makeMessageEvent(
          telemetryThread,
          "u-agent",
          "user",
          "Automated agent user prompt should be skipped",
          { minute: 2, createdBy: "agent" },
        ),
        makeMessageEvent(
          telemetryThread,
          "a-1",
          "assistant",
          "Earlier assistant reply should be superseded by latest assistant message",
          { minute: 3 },
        ),
        makeMessageEvent(
          telemetryThread,
          "a-2",
          "assistant",
          "Implemented touch telemetry capture for customizable button controls.",
          { minute: 4 },
        ),
        makeThreadEvent(authThread, projectB, "OAuth Refresh Flow"),
        makeMessageEvent(
          authThread,
          "u-auth",
          "user",
          "Fix OAuth token refresh race when session expires",
          { minute: 1 },
        ),
        makeThreadEvent(archivedThread, projectA, "Archived Volleyball Thread", {
          archivedAt: at(1),
        }),
        makeThreadEvent(deletedThread, projectA, "Deleted Volleyball Thread", {
          deletedAt: at(1),
        }),
        makeThreadEvent(subagentThread, projectA, "Subagent Volleyball Thread", {
          subagentOf: telemetryThread,
        }),
        makeThreadEvent(sideChatThread, projectA, "Side Chat Volleyball Thread", {
          sideChatOf: telemetryThread,
        }),
      ],
      projections.apply,
      { discard: true },
    );

    const firstSweep = yield* semantic.sweep();
    // telemetryThread: summary + u-1 + a-2 (3 chunks); authThread: summary + u-auth (2 chunks)
    assert.equal(firstSweep.embedded, 5);
    assert.equal(firstSweep.deleted, 0);

    // Second sweep is a no-op because hashes and model ID match.
    const countBefore = fake.embeddedPassages.length;
    const secondSweep = yield* semantic.sweep();
    assert.deepEqual(secondSweep, { embedded: 0, deleted: 0 });
    assert.equal(fake.embeddedPassages.length, countBefore);

    // Search surfaces the telemetry thread first and respects exclusions & project filters.
    const hits = yield* semantic.search({
      query: "using ml to read the button layouts on slap volleyball",
    });
    assert.deepEqual(
      hits.map((hit) => hit.threadId),
      [telemetryThread],
    );
    assert.equal(hits[0]?.title, "Customizable Button Layout Telemetry");

    // Exclusions suppress already-shown exact matches.
    const excluded = yield* semantic.search({
      query: "using ml to read the button layouts on slap volleyball",
      excludedThreadIds: new Set([telemetryThread]),
    });
    assert.deepEqual(excluded, []);

    // Queries under 3 words do not invoke the embedder.
    const queriesBefore = fake.embeddedQueries.length;
    const shortResult = yield* semantic.search({ query: "button layout" });
    assert.deepEqual(shortResult, []);
    assert.equal(fake.embeddedQueries.length, queriesBefore);

    // Project filter scopes results.
    const scopedToAuth = yield* semantic.search({
      query: "using ml to read the button layouts on slap volleyball",
      projectIds: [projectB],
    });
    assert.deepEqual(scopedToAuth, []);
  }).pipe(Effect.provide(makeTestLayer({ embedder: fake.layer })));
});

it.effect("re-embeds changed content or model versions and removes orphaned vectors", () => {
  const fake = makeFakeEmbedder({ modelId: "fake/bge-v2" });
  return Effect.gen(function* () {
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const semantic = yield* SemanticSearchService.SemanticSearchService;

    const projectId = ProjectId.make("project:reindex");
    const threadId = ThreadId.make("thread:reindex");
    const orphanThreadId = ThreadId.make("thread:orphan");
    yield* createProject(projectId, "Reindex Project");
    yield* Effect.forEach(
      [
        makeThreadEvent(threadId, projectId, "SQLite Schema Setup"),
        makeMessageEvent(threadId, "u-1", "user", "Create initial sqlite migration table", {
          minute: 1,
        }),
      ],
      projections.apply,
      { discard: true },
    );

    // Seed an orphan thread row and a stale model_id row directly in SQLite.
    const staleVec = new Uint8Array(new Float32Array([1, 0, 0, 0]).buffer);
    yield* sql`
      INSERT INTO thread_search_embeddings (
        thread_id, chunk_key, chunk_kind, message_id, message_created_at,
        content_hash, model_id, snippet, embedding, updated_at
      ) VALUES (
        ${orphanThreadId}, 'summary', 'summary', NULL, NULL,
        'hash-orphan', 'fake/bge-v2', 'Orphan', ${staleVec}, '2026-09-01T00:00:00.000Z'
      ), (
        ${threadId}, 'summary', 'summary', NULL, NULL,
        'old-hash', 'fake/bge-v1', 'Old', ${staleVec}, '2026-09-01T00:00:00.000Z'
      )
    `;

    const swept = yield* semantic.sweep();
    assert.equal(swept.deleted, 1);
    assert.equal(swept.embedded, 2);

    // Updating the message content re-embeds only the changed chunk.
    const embeddedBeforeUpdate = fake.embeddedPassages.length;
    yield* projections.apply(
      makeMessageEvent(
        threadId,
        "u-1",
        "user",
        "Now using ML button telemetry on slap volleyball controls",
        { minute: 2 },
      ),
    );
    yield* semantic.syncThread(threadId);
    assert.equal(fake.embeddedPassages.length, embeddedBeforeUpdate + 1);

    const hits = yield* semantic.search({
      query: "using ml to read button layouts on slap volleyball",
    });
    assert.deepEqual(
      hits.map((hit) => hit.threadId),
      [threadId],
    );

    // Deleting the thread removes all of its vectors on sync.
    const deletedBase = makeThreadEvent(threadId, projectId, "SQLite Schema Setup");
    yield* projections.apply({
      id: EventId.make("delete:thread:reindex"),
      type: "thread.deleted",
      threadId,
      providerInstanceId,
      occurredAt: at(3),
      payload: {
        ...deletedBase.payload,
        deletedAt: at(3),
      },
    });
    yield* semantic.syncThread(threadId);
    const remaining = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM thread_search_embeddings
    `;
    assert.equal(remaining[0]?.count, 0);
  }).pipe(Effect.provide(makeTestLayer({ embedder: fake.layer })));
});

it.effect(
  "does not embed or search when semanticSearchEnabled is false and degrades quietly on failure",
  () => {
    const disabledFake = makeFakeEmbedder();
    const failingFake = makeFakeEmbedder({ fail: true });
    return Effect.gen(function* () {
      // 1. Disabled setting: neither sweep nor search calls the embedder.
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const semantic = yield* SemanticSearchService.SemanticSearchService;
        const projectId = ProjectId.make("project:off");
        const threadId = ThreadId.make("thread:off");
        yield* createProject(projectId, "Disabled Project");
        yield* projections.apply(makeThreadEvent(threadId, projectId, "Button Layout Telemetry"));
        yield* projections.apply(
          makeMessageEvent(threadId, "u-1", "user", "Add telemetry for button layouts using ML"),
        );
        const swept = yield* semantic.sweep();
        assert.deepEqual(swept, { embedded: 0, deleted: 0 });
        const hits = yield* semantic.search({
          query: "using ml to read button layouts on slap volleyball",
        });
        assert.deepEqual(hits, []);
        assert.equal(disabledFake.embeddedPassages.length, 0);
        assert.equal(disabledFake.embeddedQueries.length, 0);
      }).pipe(
        Effect.provide(
          makeTestLayer({ embedder: disabledFake.layer, semanticSearchEnabled: false }),
        ),
      );

      // 2. Embedder error: search and sweep degrade quietly without throwing.
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const semantic = yield* SemanticSearchService.SemanticSearchService;
        const projectId = ProjectId.make("project:fail");
        const threadId = ThreadId.make("thread:fail");
        yield* createProject(projectId, "Fail Project");
        yield* projections.apply(makeThreadEvent(threadId, projectId, "Button Layout Telemetry"));
        const swept = yield* semantic.sweep();
        assert.deepEqual(swept, { embedded: 0, deleted: 0 });
        const hits = yield* semantic.search({
          query: "using ml to read button layouts on slap volleyball",
        });
        assert.deepEqual(hits, []);
      }).pipe(Effect.provide(makeTestLayer({ embedder: failingFake.layer })));
    });
  },
);

it.effect("listens for events after the latest sequence instead of replaying history", () =>
  Effect.gen(function* () {
    const semantic = yield* SemanticSearchService.SemanticSearchService;
    const requested = yield* Deferred.make<number | undefined>();
    const sink = {
      latestSequence: () => Effect.succeed(42),
      stream: (input) =>
        Stream.unwrap(
          Deferred.succeed(requested, input?.afterSequence).pipe(Effect.as(Stream.never)),
        ),
    } as Pick<EventSink.EventSinkV2["Service"], "latestSequence" | "stream">;
    yield* semantic.start(sink as EventSink.EventSinkV2["Service"]);
    assert.equal(yield* Deferred.await(requested), 42);
  }).pipe(Effect.provide(makeTestLayer())),
);
