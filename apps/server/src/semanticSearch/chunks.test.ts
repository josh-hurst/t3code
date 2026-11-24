import { assert, describe, it } from "@effect/vitest";
import { IsoDateTime, MessageId, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  buildSemanticSnippet,
  buildThreadSemanticChunks,
  cleanSemanticText,
  decodeFloat32Vector,
  encodeFloat32Vector,
  isSemanticSearchQuery,
  rankSemanticVectors,
  SEMANTIC_MAX_MESSAGE_CHARS,
} from "./chunks.ts";

const iso = Schema.decodeSync(IsoDateTime);

describe("semanticSearch chunks", () => {
  it("cleans context links, pasted content blocks, short XML tags, and collapses whitespace", () => {
    const raw = [
      "See [notes](t3-context://file/abc) and ![shot](t3-context://image/1)",
      "<pasted_content>very large pasted block\nwith lines</pasted_content>",
      "<system-reminder>keep me</system-reminder>",
      "   add   telemetry\n\tfor   buttons  ",
    ].join(" ");
    assert.equal(cleanSemanticText(raw), "See and keep me add telemetry for buttons");
  });

  it("strips markdown emphasis and truncates snippets without splitting surrogate pairs", () => {
    assert.equal(
      buildSemanticSnippet("Use **bold** with `code` and [link](https://example.com)"),
      "Use bold with code and link",
    );
    const emojiSnippet = buildSemanticSnippet(`x${"🚀".repeat(200)}`, 20);
    assert.isAtMost(emojiSnippet.length, 20);
    assert.isTrue(emojiSnippet.endsWith("…"));
    assert.notMatch(
      emojiSnippet,
      /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/,
    );
  });

  it("gates semantic search on queries with at least three words", () => {
    assert.isFalse(isSemanticSearchQuery(""));
    assert.isFalse(isSemanticSearchQuery("volleyball"));
    assert.isFalse(isSemanticSearchQuery("button layout"));
    assert.isFalse(isSemanticSearchQuery("   ---   "));
    assert.isTrue(isSemanticSearchQuery("button layout telemetry"));
    assert.isTrue(isSemanticSearchQuery("using ml to read the button layouts on slap volleyball"));
  });

  it("builds summary, eligible user chunks, and latest assistant chunk with prefix and caps", () => {
    const threadId = ThreadId.make("thread:1");
    const projectId = ProjectId.make("project:slap");
    const longBody = "telemetry ".repeat(200);
    const chunks = buildThreadSemanticChunks({
      threadId,
      projectId,
      title: "Customizable Button Layout Telemetry",
      projectTitle: "Slap Volleyball",
      cardLine: "Collect button press positions for ML layout tuning",
      topics: ["telemetry", "controls"],
      entries: [{ title: "Layout metrics", outcome: "Added touch coordinate logging" }],
      userMessages: [
        {
          messageId: MessageId.make("u-short"),
          text: "sounds good", // < 15 chars -> skipped
          createdAt: iso("2026-09-01T00:00:00.000Z"),
        },
        {
          messageId: MessageId.make("u-main"),
          text: `Let's log button presses so ML can optimize layouts. ${longBody}`,
          createdAt: iso("2026-09-01T00:01:00.000Z"),
        },
      ],
      latestAssistantMessage: {
        messageId: MessageId.make("a-latest"),
        text: "Added touch coordinate telemetry and exported a dataset for model training.",
        createdAt: iso("2026-09-01T00:02:00.000Z"),
      },
    });

    assert.deepEqual(
      chunks.map((chunk) => [chunk.chunkKey, chunk.chunkKind, chunk.messageId]),
      [
        ["summary", "summary", null],
        ["user:u-main", "user", MessageId.make("u-main")],
        ["assistant:a-latest", "assistant", MessageId.make("a-latest")],
      ],
    );
    assert.include(chunks[0]!.embeddingText, "Customizable Button Layout Telemetry");
    assert.include(chunks[0]!.embeddingText, "Project: Slap Volleyball");
    assert.include(chunks[0]!.embeddingText, "Layout metrics: Added touch coordinate logging");
    assert.isTrue(
      chunks[1]!.embeddingText.startsWith(
        "Customizable Button Layout Telemetry (Slap Volleyball): ",
      ),
    );
    assert.equal(
      chunks[1]!.embeddingText.length,
      "Customizable Button Layout Telemetry (Slap Volleyball): ".length +
        SEMANTIC_MAX_MESSAGE_CHARS,
    );
    assert.isTrue(
      chunks[2]!.embeddingText.startsWith(
        "Customizable Button Layout Telemetry (Slap Volleyball): ",
      ),
    );
    assert.equal(
      chunks[2]!.snippet,
      "Added touch coordinate telemetry and exported a dataset for model training.",
    );
  });

  it("ranks by max cosine similarity per thread and respects exclusions, project filters, and threshold", () => {
    const projectA = ProjectId.make("project:a");
    const projectB = ProjectId.make("project:b");
    const thread1 = ThreadId.make("thread:1");
    const thread2 = ThreadId.make("thread:2");
    const thread3 = ThreadId.make("thread:3");

    const entries = [
      { threadId: thread1, projectId: projectA, chunkKey: "u:weak" },
      { threadId: thread1, projectId: projectA, chunkKey: "u:strong" },
      { threadId: thread2, projectId: projectB, chunkKey: "summary" },
      { threadId: thread3, projectId: projectA, chunkKey: "u:below-threshold" },
    ];
    // 2D unit vectors
    const vectors = new Float32Array([
      0.5,
      0.8660254, // thread1 weak -> 0.5
      0.95,
      0.3122499, // thread1 strong -> 0.95
      0.85,
      0.5267827, // thread2 -> 0.85
      0.3,
      0.9539392, // thread3 -> 0.3 (below minScore 0.64)
    ]);
    const queryVector = new Float32Array([1, 0]);

    const ranked = rankSemanticVectors({
      queryVector,
      vectors,
      dimensions: 2,
      entries,
      limit: 10,
      minScore: 0.64,
    });
    assert.deepEqual(
      ranked.map((hit) => [hit.threadId, hit.chunkKey]),
      [
        [thread1, "u:strong"],
        [thread2, "summary"],
      ],
    );

    const filtered = rankSemanticVectors({
      queryVector,
      vectors,
      dimensions: 2,
      entries,
      projectIds: new Set([projectA]),
      excludedThreadIds: new Set([thread1]),
      limit: 10,
      minScore: 0.2,
    });
    assert.deepEqual(
      filtered.map((hit) => hit.threadId),
      [thread3],
    );
  });

  it("round-trips Float32 vectors through SQLite BLOB buffers", () => {
    const vector = new Float32Array([0.125, -0.5, 0.75, 1]);
    const encoded = encodeFloat32Vector(vector);
    const decoded = decodeFloat32Vector(encoded, 4);
    assert.isNotNull(decoded);
    assert.deepEqual(Array.from(decoded!), Array.from(vector));
    assert.isNull(decodeFloat32Vector(encoded, 3));
  });
});
