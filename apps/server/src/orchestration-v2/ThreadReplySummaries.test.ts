import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  DEFAULT_SERVER_SETTINGS,
  MessageId,
  ProjectId,
  TextGenerationError,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import {
  REPLY_SUMMARY_CACHE_FILE_NAME,
  ReplySummaryLru,
  make as makeReplySummaries,
} from "./ThreadReplySummaries.ts";

const threadId = ThreadId.make("thread:reply-summary");
const projectId = ProjectId.make("project:reply-summary");
const replyId = (n: number) => MessageId.make(`message:reply-${n}`);

type ThreadRecords = Effect.Success<
  ReturnType<ThreadManagementService.ThreadManagementService["Service"]["getThreadRecords"]>
>;

function records(
  messageId: MessageId,
  overrides: { role?: "user" | "assistant"; streaming?: boolean } = {},
) {
  return {
    thread: { id: threadId, projectId },
    messages: [
      {
        id: messageId,
        role: overrides.role ?? "assistant",
        text: `Reply ${messageId}`,
        streaming: overrides.streaming ?? false,
      },
    ],
  } as unknown as ThreadRecords;
}

function makeLayer(input: {
  readonly generate: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"];
  readonly message?: (messageId: MessageId) => ThreadRecords;
  readonly enabled?: boolean;
}) {
  return Layer.mergeAll(
    Layer.mock(ThreadManagementService.ThreadManagementService)({
      getThreadRecords: (_threadId, _fields, filter) =>
        Effect.succeed((input.message ?? records)(filter!.messageIds![0]!)),
    }),
    Layer.mock(TextGeneration.TextGeneration)({
      generateTranscriptionPostProcessing: input.generate,
    }),
    ServerSettings.layerTest({
      threadReplySummariesEnabled: input.enabled ?? true,
      textGenerationModelSelection: { model: "title-model" },
    }),
  );
}

const withState = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-reply-summaries-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
  );

describe("ReplySummaryLru", () => {
  it("evicts the least recently used entry and persists only summaries", () => {
    const cache = new ReplySummaryLru(2);
    cache.set(["t", "a"], "A");
    cache.set(["t", "b"], null);
    assert.strictEqual(cache.get(["t", "a"]), "A");
    cache.set(["t", "c"], "C");
    assert.strictEqual(cache.get(["t", "b"]), undefined);
    assert.strictEqual(cache.size, 2);
    assert.deepStrictEqual(cache.persisted(), [
      ["t", "a", "A"],
      ["t", "c", "C"],
    ]);
    // Same message id in another thread is a different entry.
    cache.set(["u", "a"], "other");
    assert.strictEqual(cache.get(["t", "c"]), "C");
    assert.strictEqual(cache.get(["t", "a"]), undefined);
  });
});

describe("ThreadReplySummaries", () => {
  it.effect("persists summaries and reloads them without generating again", () =>
    withState(
      Effect.gen(function* () {
        let calls = 0;
        const models: Array<string> = [];
        const generate: TextGeneration.TextGeneration["Service"]["generateTranscriptionPostProcessing"] =
          (input) =>
            Effect.sync(() => {
              calls += 1;
              models.push(input.modelSelection.model);
              return { transcription: '"Fixed login test; 2 retries removed."' };
            });
        const service = yield* makeReplySummaries().pipe(Effect.provide(makeLayer({ generate })));
        assert.strictEqual(
          yield* service.summarize({ threadId, messageId: replyId(1) }),
          "Fixed login test; 2 retries removed",
        );
        assert.strictEqual(calls, 1);
        // Summaries use their own cheap model, not the thread title model.
        assert.deepStrictEqual(models, [
          DEFAULT_SERVER_SETTINGS.threadReplySummaryModelSelection.model,
        ]);

        const config = yield* ServerConfig.ServerConfig;
        const path = yield* Path.Path;
        const stored = yield* (yield* FileSystem.FileSystem).readFileString(
          path.join(config.stateDir, REPLY_SUMMARY_CACHE_FILE_NAME),
        );
        assert.include(stored, "Fixed login test");

        const reloaded = yield* makeReplySummaries().pipe(Effect.provide(makeLayer({ generate })));
        assert.strictEqual(
          yield* reloaded.summarize({ threadId, messageId: replyId(1) }),
          "Fixed login test; 2 retries removed",
        );
        assert.strictEqual(calls, 1);
      }),
    ),
  );

  it.effect("skips user and streaming messages, and does not retry failures", () =>
    withState(
      Effect.gen(function* () {
        let calls = 0;
        const service = yield* makeReplySummaries().pipe(
          Effect.provide(
            makeLayer({
              generate: () =>
                Effect.suspend(() => {
                  calls += 1;
                  return Effect.fail(
                    new TextGenerationError({
                      operation: "generateTranscriptionPostProcessing",
                      detail: "boom",
                    }),
                  );
                }),
              message: (messageId) =>
                records(messageId, {
                  ...(messageId === replyId(1) ? { role: "user" as const } : {}),
                  ...(messageId === replyId(2) ? { streaming: true } : {}),
                }),
            }),
          ),
        );
        assert.strictEqual(yield* service.summarize({ threadId, messageId: replyId(1) }), null);
        assert.strictEqual(yield* service.summarize({ threadId, messageId: replyId(2) }), null);
        assert.strictEqual(calls, 0);
        assert.strictEqual(yield* service.summarize({ threadId, messageId: replyId(3) }), null);
        assert.strictEqual(yield* service.summarize({ threadId, messageId: replyId(3) }), null);
        assert.strictEqual(calls, 1);
      }),
    ),
  );

  it.effect("returns null without generating while the setting is off", () =>
    withState(
      Effect.gen(function* () {
        let calls = 0;
        const service = yield* makeReplySummaries().pipe(
          Effect.provide(
            makeLayer({
              enabled: false,
              generate: () =>
                Effect.sync(() => {
                  calls += 1;
                  return { transcription: "Summary" };
                }),
            }),
          ),
        );
        assert.strictEqual(yield* service.summarize({ threadId, messageId: replyId(1) }), null);
        assert.strictEqual(calls, 0);
      }),
    ),
  );

  it.effect("shares one run per reply and runs at most two at once", () =>
    withState(
      Effect.gen(function* () {
        const started = yield* Queue.unbounded<string>();
        const gates = new Map<string, Deferred.Deferred<void>>();
        let active = 0;
        let maxActive = 0;
        const service = yield* makeReplySummaries().pipe(
          Effect.provide(
            makeLayer({
              generate: (input) =>
                Effect.gen(function* () {
                  const id = /<reply>\n(.*)\n<\/reply>/.exec(input.prompt)![1]!;
                  const gate = Deferred.makeUnsafe<void>();
                  gates.set(id, gate);
                  active += 1;
                  maxActive = Math.max(maxActive, active);
                  yield* Queue.offer(started, id);
                  yield* Deferred.await(gate);
                  active -= 1;
                  return { transcription: `Summary of ${id}` };
                }),
            }),
          ),
        );
        const requests = [1, 1, 1, 2, 3, 4].map((n) => ({ threadId, messageId: replyId(n) }));
        const fibers = yield* Effect.forEach(requests, (request) =>
          Effect.forkChild(service.summarize(request)),
        );
        const release = (id: string) => Deferred.succeed(gates.get(id)!, undefined);

        const firstTwo = [yield* Queue.take(started), yield* Queue.take(started)];
        yield* release(firstTwo[0]!);
        const third = yield* Queue.take(started);
        yield* Effect.forEach([firstTwo[1]!, third], release);
        yield* release(yield* Queue.take(started));

        const results = yield* Fiber.joinAll(fibers);
        assert.deepStrictEqual(
          results,
          requests.map((request) => `Summary of Reply ${request.messageId}`),
        );
        assert.strictEqual(gates.size, 4);
        assert.strictEqual(maxActive, 2);
      }),
    ),
  );
});
