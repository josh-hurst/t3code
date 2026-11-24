// @effect-diagnostics nodeBuiltinImport:off - SHA-256 content hashes for chunk deduplication.
import * as NodeCrypto from "node:crypto";
import type {
  IsoDateTime,
  MessageId,
  OrchestrationThreadSearchSource,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

// A shorter message embeds as little more than its title prefix and outranks real matches.
const SEMANTIC_MIN_CHUNK_LENGTH = 30;
export const SEMANTIC_MAX_MESSAGE_CHARS = 1_000;
const SEMANTIC_SNIPPET_LENGTH = 240;
const SEMANTIC_MIN_QUERY_WORDS = 3;
export const SEMANTIC_DEFAULT_LIMIT = 8;
// BGE-small-en-v1.5 unrelated pairs cluster around 0.55-0.62; real paraphrases score >= 0.64.
export const SEMANTIC_MIN_SCORE = 0.64;

const NOISE_PATTERN =
  /!?\[[^\]]*\]\(t3-context:\/\/[^)]*\)|<pasted_content[\s\S]*?<\/pasted_content>|<[^>]{1,80}>/g;
const MARKDOWN_LINK = /!?\[([^\]\n]*)\]\([^)\s]*\)/g;
const QUERY_WORD = /[\p{L}\p{N}]+/gu;

export interface SemanticThreadChunkInput {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly projectTitle: string;
  readonly cardLine: string | null;
  readonly topics: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<{ readonly title: string; readonly outcome: string }>;
  readonly userMessages: ReadonlyArray<{
    readonly messageId: MessageId;
    readonly text: string;
    readonly createdAt: IsoDateTime | null;
  }>;
  readonly latestAssistantMessage: {
    readonly messageId: MessageId;
    readonly text: string;
    readonly createdAt: IsoDateTime | null;
  } | null;
}

export interface SemanticChunk {
  readonly threadId: ThreadId;
  readonly chunkKey: string;
  readonly chunkKind: OrchestrationThreadSearchSource;
  readonly messageId: MessageId | null;
  readonly messageCreatedAt: IsoDateTime | null;
  readonly embeddingText: string;
  readonly snippet: string;
  readonly contentHash: string;
}

export function cleanSemanticText(text: string): string {
  return text.replace(NOISE_PATTERN, " ").replace(/\s+/g, " ").trim();
}

const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff;

export function buildSemanticSnippet(text: string, maxLength = SEMANTIC_SNIPPET_LENGTH): string {
  const shown = text
    .replace(MARKDOWN_LINK, "$1")
    .replace(/\*\*|`+/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (shown.length <= maxLength) return shown;
  let end = maxLength - 1;
  if (isLowSurrogate(shown.charCodeAt(end))) end -= 1;
  return `${shown.slice(0, end).trimEnd()}…`;
}

function hashSemanticText(text: string): string {
  return NodeCrypto.createHash("sha256").update(text).digest("hex");
}

function semanticQueryWordCount(query: string): number {
  return query.match(QUERY_WORD)?.length ?? 0;
}

export function isSemanticSearchQuery(query: string): boolean {
  return semanticQueryWordCount(query) >= SEMANTIC_MIN_QUERY_WORDS;
}

function buildThreadSummaryText(
  input: Pick<
    SemanticThreadChunkInput,
    "title" | "projectTitle" | "cardLine" | "topics" | "entries"
  >,
): string {
  const parts: string[] = [input.title, `Project: ${input.projectTitle}`];
  if (input.cardLine && input.cardLine.trim().length > 0) {
    parts.push(input.cardLine.trim());
  }
  if (input.topics.length > 0) {
    parts.push(input.topics.join(", "));
  }
  for (const entry of input.entries) {
    parts.push(entry.outcome ? `${entry.title}: ${entry.outcome}` : entry.title);
  }
  return parts.join(". ");
}

/**
 * Pure chunk builder matching the validated retrieval configuration:
 * one summary chunk, one chunk per user-written message prefixed with `<title> (<project>): `,
 * and one chunk for the thread's latest assistant message.
 */
export function buildThreadSemanticChunks(
  input: SemanticThreadChunkInput,
): ReadonlyArray<SemanticChunk> {
  const chunks: SemanticChunk[] = [];
  const summaryText = buildThreadSummaryText(input).replace(/\s+/g, " ").trim();
  if (summaryText.length > 0) {
    const firstEntry = input.entries[0];
    const summarySnippetSource =
      input.cardLine?.trim() ||
      (firstEntry
        ? firstEntry.outcome
          ? `${firstEntry.title}: ${firstEntry.outcome}`
          : firstEntry.title
        : input.topics.length > 0
          ? input.topics.join(", ")
          : input.title);
    chunks.push({
      threadId: input.threadId,
      chunkKey: "summary",
      chunkKind: "summary",
      messageId: null,
      messageCreatedAt: null,
      embeddingText: summaryText,
      snippet: buildSemanticSnippet(summarySnippetSource),
      contentHash: hashSemanticText(summaryText),
    });
  }

  const head = `${input.title} (${input.projectTitle}): `;
  for (const message of input.userMessages) {
    const cleaned = cleanSemanticText(message.text);
    if (cleaned.length < SEMANTIC_MIN_CHUNK_LENGTH) continue;
    const embeddingText = `${head}${cleaned.slice(0, SEMANTIC_MAX_MESSAGE_CHARS)}`;
    chunks.push({
      threadId: input.threadId,
      chunkKey: `user:${message.messageId}`,
      chunkKind: "user",
      messageId: message.messageId,
      messageCreatedAt: message.createdAt,
      embeddingText,
      snippet: buildSemanticSnippet(cleaned),
      contentHash: hashSemanticText(embeddingText),
    });
  }

  if (input.latestAssistantMessage !== null) {
    const cleaned = cleanSemanticText(input.latestAssistantMessage.text);
    if (cleaned.length >= SEMANTIC_MIN_CHUNK_LENGTH) {
      const embeddingText = `${head}${cleaned.slice(0, SEMANTIC_MAX_MESSAGE_CHARS)}`;
      chunks.push({
        threadId: input.threadId,
        chunkKey: `assistant:${input.latestAssistantMessage.messageId}`,
        chunkKind: "assistant",
        messageId: input.latestAssistantMessage.messageId,
        messageCreatedAt: input.latestAssistantMessage.createdAt,
        embeddingText,
        snippet: buildSemanticSnippet(cleaned),
        contentHash: hashSemanticText(embeddingText),
      });
    }
  }

  return chunks;
}

export interface SemanticVectorEntry {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly chunkKey: string;
}

export interface RankedSemanticChunk {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly chunkKey: string;
  readonly score: number;
}

/**
 * Brute-force cosine similarity scan over L2-normalized vectors held in one contiguous
 * Float32Array. A thread's score is the maximum cosine similarity across its chunks.
 */
export function rankSemanticVectors(input: {
  readonly queryVector: Float32Array;
  readonly vectors: Float32Array;
  readonly entries: ReadonlyArray<SemanticVectorEntry>;
  readonly dimensions: number;
  readonly limit: number;
  readonly minScore?: number;
  readonly projectIds?: ReadonlySet<ProjectId> | null;
  readonly excludedThreadIds?: ReadonlySet<ThreadId> | null;
}): ReadonlyArray<RankedSemanticChunk> {
  const { queryVector, vectors, entries, dimensions, limit } = input;
  const minScore = input.minScore ?? SEMANTIC_MIN_SCORE;
  const projectIds = input.projectIds ?? null;
  const excludedThreadIds = input.excludedThreadIds ?? null;
  if (entries.length === 0 || limit <= 0 || queryVector.length !== dimensions) return [];

  const bestByThread = new Map<ThreadId, RankedSemanticChunk>();
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (projectIds !== null && !projectIds.has(entry.projectId)) continue;
    if (excludedThreadIds !== null && excludedThreadIds.has(entry.threadId)) continue;
    const base = index * dimensions;
    let dot = 0;
    for (let d = 0; d < dimensions; d += 1) {
      dot += queryVector[d]! * vectors[base + d]!;
    }
    if (dot < minScore) continue;
    const current = bestByThread.get(entry.threadId);
    if (current === undefined || dot > current.score) {
      bestByThread.set(entry.threadId, {
        threadId: entry.threadId,
        projectId: entry.projectId,
        chunkKey: entry.chunkKey,
        score: dot,
      });
    }
  }

  return [...bestByThread.values()]
    .sort((left, right) => right.score - left.score || left.threadId.localeCompare(right.threadId))
    .slice(0, limit);
}

export function encodeFloat32Vector(vector: Float32Array): Uint8Array {
  return new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength).slice();
}

export function decodeFloat32Vector(blob: Uint8Array, dimensions: number): Float32Array | null {
  if (blob.byteLength !== dimensions * Float32Array.BYTES_PER_ELEMENT) return null;
  const copy = new Uint8Array(blob.byteLength);
  copy.set(blob);
  return new Float32Array(copy.buffer);
}
