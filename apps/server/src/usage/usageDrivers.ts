import type { UsageLimitDrivers } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

const LARGE_CONTEXT_TOKENS = 150_000;
const PARALLEL_SESSIONS = 4;
// Sessions with a call this close together count as running at the same time.
const PARALLEL_WINDOW_MS = 5 * 60_000;
const LONG_SESSION_MS = 8 * 60 * 60_000;
// A session is subagent-heavy once its subagents spend at least this share of it.
const SUBAGENT_HEAVY_SHARE = 0.5;
const MAX_SOURCES = 20;

interface Call {
  readonly timestampMs: number;
  readonly sessionId: string;
  readonly costUsd: number;
}

interface SessionTotals {
  firstMs: number;
  lastMs: number;
  costUsd: number;
  subagentCostUsd: number;
}

/**
 * Weighs each counted call by its API list price, the closest local measure of what a call takes
 * from a subscription limit. The measures overlap, so their shares do not add up to one.
 */
export class UsageDriversCollector {
  readonly #calls: Call[] = [];
  readonly #sessions = new Map<string, SessionTotals>();
  readonly #sources = new Map<
    string,
    { kind: "subagent" | "mcp" | "skill"; name: string; costUsd: number }
  >();
  #costUsd = 0;
  #largeContextUsd = 0;

  add(record: UsageRecord, costUsd: number): void {
    if (costUsd <= 0) return;
    this.#costUsd += costUsd;
    const { totals, attribution } = record;
    const context =
      totals.uncachedInputTokens + totals.cachedInputTokens + totals.cacheCreationTokens;
    if (context > LARGE_CONTEXT_TOKENS) this.#largeContextUsd += costUsd;
    this.#calls.push({ timestampMs: record.timestampMs, sessionId: record.sessionId, costUsd });

    let session = this.#sessions.get(record.sessionId);
    if (session === undefined) {
      session = {
        firstMs: record.timestampMs,
        lastMs: record.timestampMs,
        costUsd: 0,
        subagentCostUsd: 0,
      };
      this.#sessions.set(record.sessionId, session);
    }
    session.firstMs = Math.min(session.firstMs, record.timestampMs);
    session.lastMs = Math.max(session.lastMs, record.timestampMs);
    session.costUsd += costUsd;
    if (attribution?.agent !== undefined) session.subagentCostUsd += costUsd;

    if (attribution?.agent !== undefined) this.#addSource("subagent", attribution.agent, costUsd);
    if (attribution?.mcpServer !== undefined)
      this.#addSource("mcp", attribution.mcpServer, costUsd);
    if (attribution?.skill !== undefined) this.#addSource("skill", attribution.skill, costUsd);
  }

  #addSource(kind: "subagent" | "mcp" | "skill", name: string, costUsd: number): void {
    const key = `${kind}\u0000${name}`;
    const source = this.#sources.get(key);
    if (source === undefined) this.#sources.set(key, { kind, name, costUsd });
    else source.costUsd += costUsd;
  }

  finish(): UsageLimitDrivers {
    const total = this.#costUsd;
    const share = (costUsd: number) => (total > 0 ? costUsd / total : 0);

    let subagentHeavyUsd = 0;
    let longSessionUsd = 0;
    for (const session of this.#sessions.values()) {
      if (session.subagentCostUsd >= session.costUsd * SUBAGENT_HEAVY_SHARE) {
        subagentHeavyUsd += session.costUsd;
      }
      if (session.lastMs - session.firstMs >= LONG_SESSION_MS) longSessionUsd += session.costUsd;
    }

    return {
      costUsd: total,
      largeContextShare: share(this.#largeContextUsd),
      subagentHeavyShare: share(subagentHeavyUsd),
      parallelShare: share(this.#parallelUsd()),
      longSessionShare: share(longSessionUsd),
      sources: [...this.#sources.values()]
        .sort((left, right) => right.costUsd - left.costUsd)
        .slice(0, MAX_SOURCES)
        .map(({ kind, name, costUsd }) => ({ kind, name, share: share(costUsd) })),
    };
  }

  /** Cost of calls made while enough distinct sessions had a call within the window around them. */
  #parallelUsd(): number {
    const calls = [...this.#calls].sort((left, right) => left.timestampMs - right.timestampMs);
    const inWindow = new Map<string, number>();
    const enter = (sessionId: string) =>
      inWindow.set(sessionId, (inWindow.get(sessionId) ?? 0) + 1);
    const leave = (sessionId: string) => {
      const count = (inWindow.get(sessionId) ?? 0) - 1;
      if (count <= 0) inWindow.delete(sessionId);
      else inWindow.set(sessionId, count);
    };
    let costUsd = 0;
    let start = 0;
    let end = 0;
    for (const call of calls) {
      while (
        end < calls.length &&
        calls[end]!.timestampMs <= call.timestampMs + PARALLEL_WINDOW_MS
      ) {
        enter(calls[end]!.sessionId);
        end += 1;
      }
      while (calls[start]!.timestampMs < call.timestampMs - PARALLEL_WINDOW_MS) {
        leave(calls[start]!.sessionId);
        start += 1;
      }
      if (inWindow.size >= PARALLEL_SESSIONS) costUsd += call.costUsd;
    }
    return costUsd;
  }
}
