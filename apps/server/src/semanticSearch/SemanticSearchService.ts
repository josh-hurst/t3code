import {
  IsoDateTime,
  MessageId,
  OrchestrationThreadSearchSource,
  ProjectId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";
import * as Stream from "effect/Stream";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import { indexedMessageCondition } from "../orchestration-v2/messageSearchIndex.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  buildThreadSemanticChunks,
  decodeFloat32Vector,
  encodeFloat32Vector,
  isSemanticSearchQuery,
  rankSemanticVectors,
  SEMANTIC_DEFAULT_LIMIT,
  SEMANTIC_MIN_SCORE,
  type SemanticChunk,
  type SemanticVectorEntry,
} from "./chunks.ts";
import * as SemanticEmbedder from "./SemanticEmbedder.ts";

export interface SemanticThreadMatch {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly source: OrchestrationThreadSearchSource;
  readonly snippet: string;
  readonly messageId: MessageId | null;
  readonly messageCreatedAt: IsoDateTime | null;
  readonly score: number;
}

export interface SemanticSearchInput {
  readonly query: string;
  readonly limit?: number | undefined;
  readonly projectIds?: ReadonlyArray<ProjectId> | undefined;
  readonly excludedThreadIds?: ReadonlySet<ThreadId> | undefined;
  readonly minScore?: number | undefined;
}

export class SemanticSearchService extends Context.Service<
  SemanticSearchService,
  {
    /** Searches indexed thread embeddings by meaning. Never fails: degrades quietly to []. */
    readonly search: (
      input: SemanticSearchInput,
    ) => Effect.Effect<ReadonlyArray<SemanticThreadMatch>>;
    /** Re-indexes one thread: embeds missing/changed chunks and removes stale or ineligible ones. */
    readonly syncThread: (threadId: ThreadId) => Effect.Effect<void>;
    /** Removes orphan vectors and embeds missing/changed chunks across eligible threads. */
    readonly sweep: (options?: {
      readonly batchSize?: number;
    }) => Effect.Effect<{ readonly embedded: number; readonly deleted: number }>;
    /**
     * Starts the startup backfill, the settings watch and, from `eventSink`, updates as runs end.
     * The sink is passed in because the orchestration runtime is built after this service.
     */
    readonly start: (eventSink?: EventSink.EventSinkV2["Service"]) => Effect.Effect<void>;
  }
>()("t3/semanticSearch/SemanticSearchService") {}

const STARTUP_BACKFILL_DELAY = Duration.seconds(10);
const INCREMENTAL_DEBOUNCE = Duration.seconds(3);
const BACKFILL_BATCH_PAUSE = Duration.millis(25);
const DEFAULT_EMBED_BATCH_SIZE = 16;
const THREAD_PAGE_SIZE = 100;

const TokenList = Schema.fromJsonString(Schema.Array(Schema.String));
const decodeCardTopics = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Array(Schema.String)),
);

const EligibleThreadRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  projectTitle: Schema.String,
  cardLine: Schema.Unknown,
  cardTopics: Schema.Unknown,
});

const ThreadEntryRow = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  outcome: Schema.String,
});

const ThreadMessageRow = Schema.Struct({
  threadId: ThreadId,
  messageId: MessageId,
  role: Schema.Literals(["user", "assistant"]),
  text: Schema.String,
  createdAt: Schema.NullOr(IsoDateTime),
});

const ExistingChunkRow = Schema.Struct({
  threadId: ThreadId,
  chunkKey: Schema.String,
  contentHash: Schema.String,
  modelId: Schema.String,
});

const LoadedVectorRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  chunkKey: Schema.String,
  embedding: Schema.Uint8Array,
});

const HitMetadataRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  title: Schema.String,
  chunkKey: Schema.String,
  chunkKind: OrchestrationThreadSearchSource,
  messageId: Schema.NullOr(MessageId),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
  snippet: Schema.String,
});

const TERMINAL_RUN_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
  "rolled_back",
]);

/**
 * Contiguous Float32Array index kept in RAM once loaded so query scans touch a single typed array
 * with O(1) swap-remove deletes and in-place updates.
 */
class VectorCache {
  private vectors: Float32Array;
  private entries: SemanticVectorEntry[] = [];
  private keyToSlot = new Map<string, number>();
  private keysByThread = new Map<ThreadId, Set<string>>();
  private capacity: number;
  readonly dimensions: number;

  constructor(dimensions: number, initialCapacity = 256) {
    this.dimensions = dimensions;
    this.capacity = Math.max(16, initialCapacity);
    this.vectors = new Float32Array(this.capacity * dimensions);
  }

  private slotKey(threadId: ThreadId, chunkKey: string): string {
    return `${threadId}\0${chunkKey}`;
  }

  private ensureCapacity(minCapacity: number) {
    if (minCapacity <= this.capacity) return;
    let nextCapacity = this.capacity;
    while (nextCapacity < minCapacity) nextCapacity *= 2;
    const grown = new Float32Array(nextCapacity * this.dimensions);
    grown.set(this.vectors.subarray(0, this.entries.length * this.dimensions));
    this.vectors = grown;
    this.capacity = nextCapacity;
  }

  upsert(entry: SemanticVectorEntry, vector: Float32Array) {
    if (vector.length !== this.dimensions) return;
    const key = this.slotKey(entry.threadId, entry.chunkKey);
    const existing = this.keyToSlot.get(key);
    if (existing !== undefined) {
      this.entries[existing] = entry;
      this.vectors.set(vector, existing * this.dimensions);
      return;
    }
    const slot = this.entries.length;
    this.ensureCapacity(slot + 1);
    this.entries.push(entry);
    this.vectors.set(vector, slot * this.dimensions);
    this.keyToSlot.set(key, slot);
    let threadKeys = this.keysByThread.get(entry.threadId);
    if (threadKeys === undefined) {
      threadKeys = new Set();
      this.keysByThread.set(entry.threadId, threadKeys);
    }
    threadKeys.add(entry.chunkKey);
  }

  remove(threadId: ThreadId, chunkKey: string) {
    const key = this.slotKey(threadId, chunkKey);
    const slot = this.keyToSlot.get(key);
    if (slot === undefined) return;
    const lastSlot = this.entries.length - 1;
    if (slot !== lastSlot) {
      const moved = this.entries[lastSlot]!;
      this.entries[slot] = moved;
      this.vectors.copyWithin(
        slot * this.dimensions,
        lastSlot * this.dimensions,
        (lastSlot + 1) * this.dimensions,
      );
      this.keyToSlot.set(this.slotKey(moved.threadId, moved.chunkKey), slot);
    }
    this.entries.pop();
    this.keyToSlot.delete(key);
    const threadKeys = this.keysByThread.get(threadId);
    if (threadKeys !== undefined) {
      threadKeys.delete(chunkKey);
      if (threadKeys.size === 0) this.keysByThread.delete(threadId);
    }
  }

  removeThread(threadId: ThreadId) {
    const keys = this.keysByThread.get(threadId);
    if (keys === undefined) return;
    for (const chunkKey of keys) {
      this.remove(threadId, chunkKey);
    }
  }

  snapshot(): {
    readonly vectors: Float32Array;
    readonly entries: ReadonlyArray<SemanticVectorEntry>;
  } {
    return { vectors: this.vectors, entries: this.entries };
  }
}

const isHiddenMessageCondition = (sql: SqlClient.SqlClient) => sql`
  messages.message_id NOT LIKE 'async-answer:%'
  AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_runs AS runs
    WHERE runs.run_id = messages.run_id
      AND (
        runs.status = 'rolled_back'
        OR (
          runs.status = 'cancelled'
          AND NOT EXISTS (
            SELECT 1 FROM orchestration_v2_projection_turn_items AS items
            WHERE items.run_id = runs.run_id
              AND json_extract(items.payload_json, '$.messageId') = messages.message_id
              AND json_extract(items.payload_json, '$.inputIntent') IS NOT 'queued_turn'
          )
        )
      )
  )
`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const embedder = yield* SemanticEmbedder.SemanticEmbedder;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const scope = yield* Effect.scope;

  let cache: VectorCache | null = null;
  const cacheLoadLock = yield* Semaphore.make(1);
  const indexLock = yield* Semaphore.make(1);
  let backfillFiber: Fiber.Fiber<void> | null = null;
  let dirtyFlushFiber: Fiber.Fiber<void> | null = null;
  const dirtyThreads = new Set<ThreadId>();

  const isEnabled = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.semanticSearchEnabled !== false),
    Effect.orElseSucceed(() => true),
  );

  const readOnly = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    sql.withTransaction(effect).pipe(NodeSqliteClient.readOnly);

  const eligibleThreadIdsQuery = SqlSchema.findAll({
    Request: Schema.Void,
    Result: Schema.Struct({ threadId: ThreadId }),
    execute: () => sql`
      SELECT threads.thread_id AS "threadId"
      FROM orchestration_v2_projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
        AND projects.deleted_at IS NULL
        AND json_extract(threads.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND json_extract(threads.payload_json, '$.lineage.sideChat') IS NOT 1
      ORDER BY threads.updated_at DESC, threads.thread_id ASC
    `,
  });

  const eligibleThreadsByIdsQuery = SqlSchema.findAll({
    Request: Schema.Struct({ threadIds: TokenList }),
    Result: EligibleThreadRow,
    execute: ({ threadIds }) => sql`
      SELECT
        threads.thread_id AS "threadId",
        threads.project_id AS "projectId",
        COALESCE(json_extract(threads.payload_json, '$.title'), '') AS title,
        projects.title AS "projectTitle",
        json_extract(threads.payload_json, '$.card.line') AS "cardLine",
        json_extract(threads.payload_json, '$.card.topics') AS "cardTopics"
      FROM orchestration_v2_projection_threads AS threads
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE threads.thread_id IN (SELECT value FROM json_each(${threadIds}))
        AND threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
        AND projects.deleted_at IS NULL
        AND json_extract(threads.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND json_extract(threads.payload_json, '$.lineage.sideChat') IS NOT 1
    `,
  });

  const activeEntriesByThreadIdsQuery = SqlSchema.findAll({
    Request: Schema.Struct({ threadIds: TokenList }),
    Result: ThreadEntryRow,
    execute: ({ threadIds }) => sql`
      SELECT thread_id AS "threadId", title, outcome
      FROM tide_thread_entries
      WHERE thread_id IN (SELECT value FROM json_each(${threadIds}))
        AND status = 'active'
      ORDER BY ended_at DESC
    `,
  });

  const userMessagesByThreadIdsQuery = SqlSchema.findAll({
    Request: Schema.Struct({ threadIds: TokenList }),
    Result: ThreadMessageRow,
    execute: ({ threadIds }) => sql`
      SELECT
        messages.thread_id AS "threadId",
        messages.message_id AS "messageId",
        messages.role AS role,
        COALESCE(messages.search_text, json_extract(messages.payload_json, '$.text'), '') AS text,
        messages.created_at AS "createdAt"
      FROM orchestration_v2_projection_messages AS messages
      WHERE messages.thread_id IN (SELECT value FROM json_each(${threadIds}))
        AND ${indexedMessageCondition(sql)}
        AND messages.role = 'user'
        AND COALESCE(json_extract(messages.payload_json, '$.createdBy'), 'user') = 'user'
        AND ${isHiddenMessageCondition(sql)}
      ORDER BY messages.created_at ASC, messages.message_id ASC
    `,
  });

  const latestAssistantMessagesByThreadIdsQuery = SqlSchema.findAll({
    Request: Schema.Struct({ threadIds: TokenList }),
    Result: ThreadMessageRow,
    execute: ({ threadIds }) => sql`
      SELECT "threadId", "messageId", role, text, "createdAt"
      FROM (
        SELECT
          messages.thread_id AS "threadId",
          messages.message_id AS "messageId",
          messages.role AS role,
          COALESCE(messages.search_text, json_extract(messages.payload_json, '$.text'), '') AS text,
          messages.created_at AS "createdAt",
          ROW_NUMBER() OVER (
            PARTITION BY messages.thread_id
            ORDER BY messages.created_at DESC, messages.message_id DESC
          ) AS rn
        FROM orchestration_v2_projection_messages AS messages
        WHERE messages.thread_id IN (SELECT value FROM json_each(${threadIds}))
          AND ${indexedMessageCondition(sql)}
          AND messages.role = 'assistant'
          AND ${isHiddenMessageCondition(sql)}
      )
      WHERE rn = 1
    `,
  });

  const existingChunksByThreadIdsQuery = SqlSchema.findAll({
    Request: Schema.Struct({ threadIds: TokenList }),
    Result: ExistingChunkRow,
    execute: ({ threadIds }) => sql`
      SELECT
        thread_id AS "threadId",
        chunk_key AS "chunkKey",
        content_hash AS "contentHash",
        model_id AS "modelId"
      FROM thread_search_embeddings
      WHERE thread_id IN (SELECT value FROM json_each(${threadIds}))
    `,
  });

  const loadAllVectorsQuery = SqlSchema.findAll({
    Request: Schema.Struct({ modelId: Schema.String }),
    Result: LoadedVectorRow,
    execute: ({ modelId }) => sql`
      SELECT
        emb.thread_id AS "threadId",
        threads.project_id AS "projectId",
        emb.chunk_key AS "chunkKey",
        emb.embedding AS embedding
      FROM thread_search_embeddings AS emb
      INNER JOIN orchestration_v2_projection_threads AS threads
        ON threads.thread_id = emb.thread_id
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE emb.model_id = ${modelId}
        AND threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
        AND projects.deleted_at IS NULL
        AND json_extract(threads.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND json_extract(threads.payload_json, '$.lineage.sideChat') IS NOT 1
    `,
  });

  const hitMetadataQuery = SqlSchema.findAll({
    Request: Schema.Struct({ threadIds: TokenList, modelId: Schema.String }),
    Result: HitMetadataRow,
    execute: ({ threadIds, modelId }) => sql`
      SELECT
        emb.thread_id AS "threadId",
        threads.project_id AS "projectId",
        COALESCE(json_extract(threads.payload_json, '$.title'), '') AS title,
        emb.chunk_key AS "chunkKey",
        emb.chunk_kind AS "chunkKind",
        emb.message_id AS "messageId",
        emb.message_created_at AS "messageCreatedAt",
        emb.snippet AS snippet
      FROM thread_search_embeddings AS emb
      INNER JOIN orchestration_v2_projection_threads AS threads
        ON threads.thread_id = emb.thread_id
      INNER JOIN projection_projects AS projects
        ON projects.project_id = threads.project_id
      WHERE emb.thread_id IN (SELECT value FROM json_each(${threadIds}))
        AND emb.model_id = ${modelId}
        AND threads.deleted_at IS NULL
        AND threads.archived_at IS NULL
        AND projects.deleted_at IS NULL
        AND json_extract(threads.payload_json, '$.lineage.relationshipToParent') IS NOT 'subagent'
        AND json_extract(threads.payload_json, '$.lineage.sideChat') IS NOT 1
    `,
  });

  const ensureCacheLoaded = Effect.fn("SemanticSearchService.ensureCacheLoaded")(function* () {
    if (cache !== null) return cache;
    return yield* cacheLoadLock.withPermits(1)(
      Effect.gen(function* () {
        if (cache !== null) return cache;
        const rows = yield* readOnly(loadAllVectorsQuery({ modelId: embedder.modelId }));
        const loaded = new VectorCache(embedder.dimensions, Math.max(256, rows.length));
        for (const row of rows) {
          const vector = decodeFloat32Vector(row.embedding, embedder.dimensions);
          if (vector === null) continue;
          loaded.upsert(
            { threadId: row.threadId, projectId: row.projectId, chunkKey: row.chunkKey },
            vector,
          );
        }
        cache = loaded;
        return loaded;
      }),
    );
  });

  const deleteThreadVectors = Effect.fn("SemanticSearchService.deleteThreadVectors")(function* (
    threadId: ThreadId,
  ) {
    yield* sql`DELETE FROM thread_search_embeddings WHERE thread_id = ${threadId}`;
    cache?.removeThread(threadId);
  });

  const readChunkPlanForThreads = Effect.fn("SemanticSearchService.readChunkPlan")(function* (
    threadIds: ReadonlyArray<ThreadId>,
  ) {
    if (threadIds.length === 0) {
      return {
        toEmbed: [] as Array<{ readonly chunk: SemanticChunk; readonly projectId: ProjectId }>,
        toDelete: [] as Array<{ readonly threadId: ThreadId; readonly chunkKey: string }>,
        ineligibleThreadIds: [] as ThreadId[],
      };
    }
    return yield* readOnly(
      Effect.gen(function* () {
        const [threads, entries, userMessages, assistantMessages, existing] = yield* Effect.all([
          eligibleThreadsByIdsQuery({ threadIds }),
          activeEntriesByThreadIdsQuery({ threadIds }),
          userMessagesByThreadIdsQuery({ threadIds }),
          latestAssistantMessagesByThreadIdsQuery({ threadIds }),
          existingChunksByThreadIdsQuery({ threadIds }),
        ]);

        const entriesByThread = new Map<ThreadId, Array<{ title: string; outcome: string }>>();
        for (const entry of entries) {
          let list = entriesByThread.get(entry.threadId);
          if (list === undefined) {
            list = [];
            entriesByThread.set(entry.threadId, list);
          }
          list.push({ title: entry.title, outcome: entry.outcome });
        }

        const usersByThread = new Map<
          ThreadId,
          Array<{ messageId: MessageId; text: string; createdAt: IsoDateTime | null }>
        >();
        for (const message of userMessages) {
          let list = usersByThread.get(message.threadId);
          if (list === undefined) {
            list = [];
            usersByThread.set(message.threadId, list);
          }
          list.push({
            messageId: message.messageId,
            text: message.text,
            createdAt: message.createdAt,
          });
        }

        const assistantByThread = new Map<
          ThreadId,
          { messageId: MessageId; text: string; createdAt: IsoDateTime | null }
        >();
        for (const message of assistantMessages) {
          assistantByThread.set(message.threadId, {
            messageId: message.messageId,
            text: message.text,
            createdAt: message.createdAt,
          });
        }

        const existingByThread = new Map<ThreadId, Map<string, typeof ExistingChunkRow.Type>>();
        for (const row of existing) {
          let map = existingByThread.get(row.threadId);
          if (map === undefined) {
            map = new Map();
            existingByThread.set(row.threadId, map);
          }
          map.set(row.chunkKey, row);
        }

        const eligibleSet = new Set(threads.map((thread) => thread.threadId));
        const ineligibleThreadIds = threadIds.filter(
          (id) => !eligibleSet.has(id) && existingByThread.has(id),
        );

        const toEmbed: Array<{ readonly chunk: SemanticChunk; readonly projectId: ProjectId }> = [];
        const toDelete: Array<{ readonly threadId: ThreadId; readonly chunkKey: string }> = [];

        for (const thread of threads) {
          const desired = buildThreadSemanticChunks({
            threadId: thread.threadId,
            projectId: thread.projectId,
            title: thread.title,
            projectTitle: thread.projectTitle,
            cardLine: typeof thread.cardLine === "string" ? thread.cardLine : null,
            topics: Option.getOrElse(decodeCardTopics(thread.cardTopics), () => []),
            entries: entriesByThread.get(thread.threadId) ?? [],
            userMessages: usersByThread.get(thread.threadId) ?? [],
            latestAssistantMessage: assistantByThread.get(thread.threadId) ?? null,
          });

          const existingMap = existingByThread.get(thread.threadId) ?? new Map();
          const desiredKeys = new Set<string>();
          for (const chunk of desired) {
            desiredKeys.add(chunk.chunkKey);
            const prior = existingMap.get(chunk.chunkKey);
            if (
              prior === undefined ||
              prior.contentHash !== chunk.contentHash ||
              prior.modelId !== embedder.modelId
            ) {
              toEmbed.push({ chunk, projectId: thread.projectId });
            }
          }
          for (const chunkKey of existingMap.keys()) {
            if (!desiredKeys.has(chunkKey)) {
              toDelete.push({ threadId: thread.threadId, chunkKey });
            }
          }
        }

        return { toEmbed, toDelete, ineligibleThreadIds };
      }),
    );
  });

  const writeBatch = Effect.fn("SemanticSearchService.writeBatch")(function* (input: {
    readonly items: ReadonlyArray<{
      readonly chunk: SemanticChunk;
      readonly projectId: ProjectId;
      readonly vector: Float32Array;
    }>;
    readonly deletes: ReadonlyArray<{ readonly threadId: ThreadId; readonly chunkKey: string }>;
    readonly deleteThreads: ReadonlyArray<ThreadId>;
  }) {
    if (
      input.items.length === 0 &&
      input.deletes.length === 0 &&
      input.deleteThreads.length === 0
    ) {
      return;
    }
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    yield* sql.withTransaction(
      Effect.gen(function* () {
        for (const threadId of input.deleteThreads) {
          yield* sql`DELETE FROM thread_search_embeddings WHERE thread_id = ${threadId}`;
        }
        for (const target of input.deletes) {
          yield* sql`
            DELETE FROM thread_search_embeddings
            WHERE thread_id = ${target.threadId} AND chunk_key = ${target.chunkKey}
          `;
        }
        for (const { chunk, vector } of input.items) {
          const blob = encodeFloat32Vector(vector);
          yield* sql`
            INSERT INTO thread_search_embeddings (
              thread_id,
              chunk_key,
              chunk_kind,
              message_id,
              message_created_at,
              content_hash,
              model_id,
              snippet,
              embedding,
              updated_at
            ) VALUES (
              ${chunk.threadId},
              ${chunk.chunkKey},
              ${chunk.chunkKind},
              ${chunk.messageId},
              ${chunk.messageCreatedAt},
              ${chunk.contentHash},
              ${embedder.modelId},
              ${chunk.snippet},
              ${blob},
              ${updatedAt}
            )
            ON CONFLICT(thread_id, chunk_key) DO UPDATE SET
              chunk_kind = excluded.chunk_kind,
              message_id = excluded.message_id,
              message_created_at = excluded.message_created_at,
              content_hash = excluded.content_hash,
              model_id = excluded.model_id,
              snippet = excluded.snippet,
              embedding = excluded.embedding,
              updated_at = excluded.updated_at
          `;
        }
      }),
    );
    if (cache !== null) {
      for (const threadId of input.deleteThreads) cache.removeThread(threadId);
      for (const target of input.deletes) cache.remove(target.threadId, target.chunkKey);
      for (const { chunk, projectId, vector } of input.items) {
        cache.upsert({ threadId: chunk.threadId, projectId, chunkKey: chunk.chunkKey }, vector);
      }
    }
  });

  const indexThreads = Effect.fn("SemanticSearchService.indexThreads")(function* (
    threadIds: ReadonlyArray<ThreadId>,
    options: { readonly batchSize: number },
  ) {
    let embedded = 0;
    let deleted = 0;
    for (let pageStart = 0; pageStart < threadIds.length; pageStart += THREAD_PAGE_SIZE) {
      if (!(yield* isEnabled)) break;
      const page = threadIds.slice(pageStart, pageStart + THREAD_PAGE_SIZE);
      const plan = yield* readChunkPlanForThreads(page);

      if (plan.toDelete.length > 0 || plan.ineligibleThreadIds.length > 0) {
        yield* writeBatch({
          items: [],
          deletes: plan.toDelete,
          deleteThreads: plan.ineligibleThreadIds,
        });
        deleted += plan.toDelete.length + plan.ineligibleThreadIds.length;
      }

      for (let start = 0; start < plan.toEmbed.length; start += options.batchSize) {
        if (!(yield* isEnabled)) return { embedded, deleted };
        const slice = plan.toEmbed.slice(start, start + options.batchSize);
        const vectors = yield* embedder.embedPassages(
          slice.map((entry) => entry.chunk.embeddingText),
        );
        yield* writeBatch({
          items: slice.map((entry, index) => ({
            chunk: entry.chunk,
            projectId: entry.projectId,
            vector: vectors[index]!,
          })),
          deletes: [],
          deleteThreads: [],
        });
        embedded += slice.length;
        if (start + options.batchSize < plan.toEmbed.length) {
          yield* Effect.sleep(BACKFILL_BATCH_PAUSE);
        }
      }
    }
    return { embedded, deleted };
  });

  const removeOrphanThreads = Effect.fn("SemanticSearchService.removeOrphanThreads")(function* () {
    const orphans = yield* readOnly(
      sql<{ readonly threadId: ThreadId }>`
        SELECT DISTINCT emb.thread_id AS "threadId"
        FROM thread_search_embeddings AS emb
        LEFT JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = emb.thread_id
        LEFT JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.thread_id IS NULL
          OR threads.deleted_at IS NOT NULL
          OR threads.archived_at IS NOT NULL
          OR projects.project_id IS NULL
          OR projects.deleted_at IS NOT NULL
          OR json_extract(threads.payload_json, '$.lineage.relationshipToParent') = 'subagent'
          OR json_extract(threads.payload_json, '$.lineage.sideChat') = 1
      `,
    );
    if (orphans.length === 0) return 0;
    const orphanIds = orphans.map((row) => row.threadId);
    yield* writeBatch({ items: [], deletes: [], deleteThreads: orphanIds });
    return orphanIds.length;
  });

  const sweep: SemanticSearchService["Service"]["sweep"] = Effect.fn("SemanticSearchService.sweep")(
    function* (options) {
      if (!(yield* isEnabled)) return { embedded: 0, deleted: 0 };
      return yield* indexLock.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* isEnabled)) return { embedded: 0, deleted: 0 };
          const orphanCount = yield* removeOrphanThreads();
          const eligible = yield* readOnly(eligibleThreadIdsQuery());
          const result = yield* indexThreads(
            eligible.map((row) => row.threadId),
            { batchSize: options?.batchSize ?? DEFAULT_EMBED_BATCH_SIZE },
          );
          return { embedded: result.embedded, deleted: result.deleted + orphanCount };
        }),
      );
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logDebug("Semantic search sweep skipped", { cause }).pipe(
            Effect.as({ embedded: 0, deleted: 0 }),
          ),
    ),
  );

  const syncThread: SemanticSearchService["Service"]["syncThread"] = Effect.fn(
    "SemanticSearchService.syncThread",
  )(
    function* (threadId) {
      if (!(yield* isEnabled)) return;
      yield* indexLock.withPermits(1)(
        indexThreads([threadId], { batchSize: DEFAULT_EMBED_BATCH_SIZE }),
      );
    },
    Effect.asVoid,
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logDebug("Semantic search thread sync skipped", { cause }),
    ),
  );

  const search: SemanticSearchService["Service"]["search"] = Effect.fn(
    "SemanticSearchService.search",
  )(
    function* (input) {
      if (!(yield* isEnabled)) return [];
      const query = input.query.trim();
      if (!isSemanticSearchQuery(query)) return [];
      const loaded = yield* ensureCacheLoaded();
      const { vectors, entries } = loaded.snapshot();
      if (entries.length === 0) return [];
      const queryVector = yield* embedder.embedQuery(query);
      const limit = input.limit ?? SEMANTIC_DEFAULT_LIMIT;
      const projectIdSet =
        input.projectIds !== undefined && input.projectIds.length > 0
          ? new Set(input.projectIds)
          : null;
      const ranked = rankSemanticVectors({
        queryVector,
        vectors,
        entries,
        dimensions: embedder.dimensions,
        limit,
        minScore: input.minScore ?? SEMANTIC_MIN_SCORE,
        projectIds: projectIdSet,
        excludedThreadIds: input.excludedThreadIds ?? null,
      });
      if (ranked.length === 0) return [];
      const metaRows = yield* readOnly(
        hitMetadataQuery({
          threadIds: ranked.map((hit) => hit.threadId),
          modelId: embedder.modelId,
        }),
      );
      const metaByKey = new Map(
        metaRows.map((row) => [`${row.threadId}\0${row.chunkKey}`, row] as const),
      );
      return ranked.flatMap((hit): ReadonlyArray<SemanticThreadMatch> => {
        const meta = metaByKey.get(`${hit.threadId}\0${hit.chunkKey}`);
        if (meta === undefined) return [];
        return [
          {
            threadId: meta.threadId,
            projectId: meta.projectId,
            title: meta.title,
            source: meta.chunkKind,
            snippet: meta.snippet,
            messageId: meta.messageId,
            messageCreatedAt: meta.messageCreatedAt,
            score: hit.score,
          },
        ];
      });
    },
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logDebug("Semantic search query unavailable", { cause }).pipe(Effect.as([])),
    ),
  );

  const flushDirtyThreads = Effect.gen(function* () {
    yield* Effect.sleep(INCREMENTAL_DEBOUNCE);
    dirtyFlushFiber = null;
    if (!(yield* isEnabled) || dirtyThreads.size === 0) {
      dirtyThreads.clear();
      return;
    }
    const batch = [...dirtyThreads];
    dirtyThreads.clear();
    yield* indexLock
      .withPermits(1)(indexThreads(batch, { batchSize: DEFAULT_EMBED_BATCH_SIZE }))
      .pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : Effect.logDebug("Semantic search incremental sync skipped", { cause }),
        ),
      );
  });

  const scheduleDirtyThread = Effect.fn("SemanticSearchService.scheduleDirtyThread")(function* (
    threadId: ThreadId,
  ) {
    if (!(yield* isEnabled)) return;
    dirtyThreads.add(threadId);
    if (dirtyFlushFiber !== null) return;
    dirtyFlushFiber = yield* Effect.forkIn(flushDirtyThreads, scope);
  });

  const handleDomainEvent = (event: OrchestrationV2DomainEvent) => {
    switch (event.type) {
      case "thread.archived":
      case "thread.deleted":
        dirtyThreads.delete(event.threadId);
        return deleteThreadVectors(event.threadId).pipe(Effect.ignore);
      case "thread.created":
      case "thread.unarchived":
      case "thread.metadata-updated":
      case "thread.card-updated":
      case "thread.entries-updated":
        return scheduleDirtyThread(event.threadId);
      case "run.updated":
        return TERMINAL_RUN_STATUSES.has(event.payload.status)
          ? scheduleDirtyThread(event.threadId)
          : Effect.void;
      default:
        return Effect.void;
    }
  };

  const stopBackgroundWork = Effect.gen(function* () {
    dirtyThreads.clear();
    if (dirtyFlushFiber !== null) {
      const fiber = dirtyFlushFiber;
      dirtyFlushFiber = null;
      yield* Fiber.interrupt(fiber);
    }
    if (backfillFiber !== null) {
      const fiber = backfillFiber;
      backfillFiber = null;
      yield* Fiber.interrupt(fiber);
    }
    cache = null;
    yield* embedder.shutdown;
  });

  const startBackfill = Effect.fn("SemanticSearchService.startBackfill")(function* (
    delay: Duration.Duration,
  ) {
    if (backfillFiber !== null) {
      yield* Fiber.interrupt(backfillFiber);
      backfillFiber = null;
    }
    backfillFiber = yield* Effect.sleep(delay).pipe(
      Effect.andThen(sweep()),
      Effect.asVoid,
      Effect.ensuring(
        Effect.sync(() => {
          backfillFiber = null;
        }),
      ),
      Effect.forkIn(scope),
    );
  });

  const start: SemanticSearchService["Service"]["start"] = Effect.fn("SemanticSearchService.start")(
    function* (eventSink) {
      yield* forkParked(
        Effect.gen(function* () {
          if (yield* isEnabled) {
            yield* startBackfill(STARTUP_BACKFILL_DELAY);
          }

          if (eventSink !== undefined) {
            const sink = eventSink;
            // The startup sweep covers history; without afterSequence this replays every event.
            yield* sink.latestSequence().pipe(
              Effect.flatMap((afterSequence) =>
                sink
                  .stream({ bounded: false, afterSequence })
                  .pipe(Stream.runForEach((stored) => handleDomainEvent(stored.event))),
              ),
              Effect.catchCause((cause) =>
                Cause.hasInterruptsOnly(cause)
                  ? Effect.interrupt
                  : Effect.logWarning("Semantic search event listener stopped", { cause }),
              ),
              Effect.forkIn(scope),
            );
          }

          let wasEnabled = yield* isEnabled;
          yield* serverSettings.streamChanges.pipe(
            Stream.runForEach((settings) => {
              const nowEnabled = settings.semanticSearchEnabled !== false;
              if (nowEnabled === wasEnabled) return Effect.void;
              wasEnabled = nowEnabled;
              return nowEnabled ? startBackfill(Duration.seconds(1)) : stopBackgroundWork;
            }),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.interrupt
                : Effect.logDebug("Semantic search settings watch stopped", { cause }),
            ),
            Effect.forkIn(scope),
          );
        }),
      ).pipe(Effect.provideService(Scope.Scope, scope));
    },
  );

  return SemanticSearchService.of({
    search,
    syncThread,
    sweep,
    start,
  });
});

export const layer = Layer.effect(SemanticSearchService, make);
