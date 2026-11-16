import {
  type CommandId,
  type RunId,
  THREAD_ENTRY_OUTCOME_MAX,
  THREAD_ENTRY_RUNS_MAX,
  THREAD_ENTRY_TITLE_MAX,
  type ThreadContentsTopic,
  type ThreadEntriesUpdate,
  type ThreadEntry,
  ThreadEntryId,
  type ThreadEntryRun,
  type ThreadId,
  type ThreadRunLine,
} from "@t3tools/contracts";

import type { PendingOrchestrationEffectV2 } from "./EffectOutbox.ts";
import {
  compareEntries,
  EMPTY_STATE,
  rehomeOpenItems,
  type ThreadContents,
  withSpan,
} from "./ThreadEntries.ts";

/** Owner runs a thread needs before it is regrouped; the regroup query repeats it as a literal. */
export const THREAD_REGROUP_MIN_OWNER_RUNS = 10;

/**
 * Enqueued only when a regroup is due, never for later: a pending text effect holds every later
 * text effect of its thread, cards included, whatever its time.
 */
export function threadRegroupEffect(input: {
  readonly commandId: CommandId;
  readonly threadId: ThreadId;
  readonly kind: "mark" | "idle" | "manual";
  /** Makes the id unique per trigger: a run id, a run ordinal or a command id. */
  readonly key: string;
}): PendingOrchestrationEffectV2 {
  return {
    id: `effect:thread-contents.regroup:${input.threadId}:${input.key}`,
    commandId: input.commandId,
    threadId: input.threadId,
    request: { type: "thread-contents.regroup", kind: input.kind },
  };
}

const REPORT_MARKER = "(background task or subagent reported back)";
const MATCH_MIN = 0.25;
const TITLE_KEEP_MIN = 0.5;
const TOPICS_PER_RUN_MAX = 2;

/** One topic as a model returned it: run numbers are the outline's `r1`…`rN`. */
export interface RegroupTopic {
  readonly title: string;
  readonly outcome: string;
  readonly runs: ReadonlyArray<number>;
}

/** The user's side of a run as an outline or a headlines call shows it. */
export function runSaid(run: Pick<ThreadRunLine, "startedBy" | "ownerText">): string {
  // A report's stored text is only what the owner typed while it ran.
  if (run.startedBy === "report") {
    return run.ownerText === null ? REPORT_MARKER : `${REPORT_MARKER} / also: ${run.ownerText}`;
  }
  return run.ownerText ?? REPORT_MARKER;
}

/** One line per run in ordinal order; `runIds[n - 1]` is the run the outline calls `rn`. */
export function buildOutline(runLines: ReadonlyArray<ThreadRunLine>): {
  readonly text: string;
  readonly runIds: ReadonlyArray<RunId>;
} {
  const shown = runLines
    .filter((run) => run.line !== null || run.ownerText !== null)
    .toSorted((left, right) => left.ordinal - right.ordinal);
  const text = shown
    .map((run, index) => `r${index + 1} | ${runSaid(run)} | ${run.line ?? ""}`.trimEnd())
    .join("\n");
  return { text, runIds: shown.map((run) => run.runId) };
}

const clamp = (text: string, max: number) => text.trim().slice(0, max).trim();

/**
 * Port of the experiment's tolerant parser: an optional `topic:` label, fields split on `|`, the
 * last field holds run numbers, a trailing open/done field is dropped (open state never comes
 * from this model), and `Title: outcome` in one field is accepted. Null when no topic parses.
 */
export function parseTopics(raw: string, runCount: number): ReadonlyArray<RegroupTopic> | null {
  const topics: Array<RegroupTopic> = [];
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine
      .trim()
      .replace(/^[-*]\s+/, "")
      .replace(/^topic\s*:\s*/i, "");
    const fields = line.split("|").map((field) => field.trim());
    if (fields.length < 2) continue;
    const last = fields.at(-1)!;
    if (last.replace(/[r\d\s,]/gi, "") !== "") continue;
    const runs = [
      ...new Set(
        [...last.matchAll(/\br?(\d+)\b/gi)]
          .map((match) => Number(match[1]))
          .filter((run) => run >= 1 && run <= runCount),
      ),
    ];
    if (runs.length === 0) continue;
    let body = fields.slice(0, -1);
    const state = body.at(-1)?.toLowerCase();
    if (state === "open" || state === "done") body = body.slice(0, -1);
    if (body.length === 1 && body[0]!.includes(":")) {
      const split = body[0]!.indexOf(":");
      body = [body[0]!.slice(0, split), body[0]!.slice(split + 1)];
    }
    const title = clamp(body[0] ?? "", THREAD_ENTRY_TITLE_MAX);
    if (title === "") continue;
    topics.push({ title, outcome: clamp(body[1] ?? "", THREAD_ENTRY_OUTCOME_MAX), runs });
  }
  return topics.length === 0 ? null : topics;
}

/**
 * Every run in one or two topics: a run the model dropped takes the previous run's first topic
 * (the first run takes the next run's), and a run in more than two keeps its first two.
 */
export function repairTopics(
  topics: ReadonlyArray<RegroupTopic>,
  runCount: number,
): { readonly topics: ReadonlyArray<RegroupTopic>; readonly repaired: number } {
  const byRun: Array<Array<number>> = Array.from({ length: runCount + 1 }, () => []);
  topics.forEach((topic, index) => {
    for (const run of topic.runs) {
      const held = byRun[run]!;
      if (held.length < TOPICS_PER_RUN_MAX && !held.includes(index)) held.push(index);
    }
  });
  const missing: Array<number> = [];
  for (let run = 1; run <= runCount; run++) if (byRun[run]!.length === 0) missing.push(run);
  for (const run of missing) {
    const previous = byRun.slice(1, run).findLast((held) => held.length > 0);
    const next = byRun.slice(run + 1).find((held) => held.length > 0);
    const from = previous ?? next;
    if (from !== undefined) byRun[run] = [from[0]!];
  }
  const runsOf = topics.map((): Array<number> => []);
  for (let run = 1; run <= runCount; run++)
    for (const index of byRun[run]!) runsOf[index]!.push(run);
  return {
    topics: topics.flatMap((topic, index) =>
      runsOf[index]!.length === 0 ? [] : [{ ...topic, runs: runsOf[index]! }],
    ),
    repaired: missing.length,
  };
}

/**
 * One sample: as it is. Two or three: two runs share a topic when at least two samples put them
 * together, and topics are the connected groups, so each run ends in exactly one. A group takes
 * the title and outcome of the sample topic sharing most runs with it (earliest on a tie).
 * Only a run's first topic votes: a status check in two topics would join them in every sample.
 */
export function combineSamples(
  samples: ReadonlyArray<ReadonlyArray<RegroupTopic>>,
  runCount: number,
): ReadonlyArray<RegroupTopic> {
  if (samples.length === 1) return samples[0]!;
  const memberships = samples.map((sample) => {
    const byRun: Array<Set<number>> = Array.from({ length: runCount + 1 }, () => new Set());
    sample.forEach((topic, index) =>
      topic.runs.forEach((run) => {
        if (byRun[run]?.size === 0) byRun[run]!.add(index);
      }),
    );
    return byRun;
  });
  const parent = Array.from({ length: runCount + 1 }, (_, run) => run);
  const find = (run: number): number => {
    while (parent[run] !== run) {
      parent[run] = parent[parent[run]!]!;
      run = parent[run]!;
    }
    return run;
  };
  const together = (byRun: ReadonlyArray<Set<number>>, left: number, right: number) =>
    [...byRun[left]!].some((topic) => byRun[right]!.has(topic));
  for (let left = 1; left <= runCount; left++) {
    for (let right = left + 1; right <= runCount; right++) {
      const votes = memberships.filter((byRun) => together(byRun, left, right)).length;
      if (votes >= 2) parent[find(left)] = find(right);
    }
  }
  const groups = new Map<number, Array<number>>();
  for (let run = 1; run <= runCount; run++) {
    if (memberships.every((byRun) => byRun[run]!.size === 0)) continue;
    const root = find(run);
    groups.set(root, [...(groups.get(root) ?? []), run]);
  }
  return [...groups.values()].map((runs) => {
    const members = new Set(runs);
    let best: RegroupTopic | undefined;
    let bestShared = 0;
    for (const sample of samples) {
      for (const topic of sample) {
        const shared = topic.runs.filter((run) => members.has(run)).length;
        if (shared > bestShared) {
          best = topic;
          bestShared = shared;
        }
      }
    }
    return { title: best?.title ?? "", outcome: best?.outcome ?? "", runs };
  });
}

const jaccard = (left: ReadonlySet<RunId>, right: ReadonlySet<RunId>) => {
  let shared = 0;
  for (const run of left) if (right.has(run)) shared++;
  const union = left.size + right.size - shared;
  return union === 0 ? 0 : shared / union;
};

const hasOwnerMark = (entry: ThreadEntry) =>
  entry.titleSource === "owner" || entry.runs.some((link) => link.source === "owner");

const sameEntry = (left: ThreadEntry, right: ThreadEntry) =>
  JSON.stringify(left) === JSON.stringify(right);

/**
 * Aligns a regroup's topics to the thread's entries as they are now. Hand edits win: a run the
 * owner placed stays put, an owner title never changes, and an entry with an owner mark is never
 * retired. Open items are never taken from the topics; they follow their runs.
 */
export function applyRegroup(input: {
  readonly contents: ThreadContents;
  /** The thread's run lines now. */
  readonly runLines: ReadonlyArray<ThreadRunLine>;
  readonly topics: ReadonlyArray<ThreadContentsTopic>;
  readonly at: string;
}): ThreadEntriesUpdate | null {
  const { contents } = input;
  const state = contents.state;
  if (state === null) return null;
  const lines = new Map(input.runLines.map((line) => [line.runId, line]));
  const ordinal = (runId: RunId) => lines.get(runId)?.ordinal ?? Number.MAX_SAFE_INTEGER;

  // A run rolled back since the outline was read has no line and is left out.
  const seen = new Map<RunId, number>();
  const given = input.topics.map((topic) => ({
    title: topic.title,
    outcome: topic.outcome,
    runs: [...new Set(topic.runIds)].filter((runId) => {
      if (!lines.has(runId)) return false;
      const count = seen.get(runId) ?? 0;
      seen.set(runId, count + 1);
      return count < TOPICS_PER_RUN_MAX;
    }),
  }));
  const coveredThrough = Math.max(0, ...given.flatMap((topic) => topic.runs.map(ordinal)));

  const active = contents.entries.filter((entry) => entry.status === "active");
  const ownerPlaced = new Set(
    active.flatMap((entry) =>
      entry.runs.flatMap((link) => (link.source === "owner" ? [link.runId] : [])),
    ),
  );
  // Entries the regroup leaves exactly as they are: every link owner-placed, or (added below) an
  // owner-marked entry no topic matched.
  const frozen = new Set(
    active
      .filter(
        (entry) => entry.runs.length > 0 && entry.runs.every((link) => link.source === "owner"),
      )
      .map((entry) => entry.id),
  );
  let topics = given
    .map((topic) => ({ ...topic, runs: topic.runs.filter((runId) => !ownerPlaced.has(runId)) }))
    .filter((topic) => topic.runs.length > 0);

  let matchOf = new Map<ThreadEntryId, number>();
  for (;;) {
    const placed = new Set(topics.flatMap((topic) => topic.runs));
    const candidates = active.filter((entry) => !frozen.has(entry.id));
    const pairs = candidates.flatMap((entry) => {
      const runs = new Set(
        entry.runs.flatMap((link) => (placed.has(link.runId) ? [link.runId] : [])),
      );
      const first = [...runs].toSorted((left, right) => ordinal(left) - ordinal(right))[0];
      return topics.map((topic, index) => ({
        entry,
        index,
        marked: hasOwnerMark(entry),
        score: jaccard(runs, new Set(topic.runs)),
        holdsFirst: first !== undefined && topic.runs.includes(first),
      }));
    });
    const order = (left: (typeof pairs)[number], right: (typeof pairs)[number]) =>
      right.score - left.score ||
      Number(right.holdsFirst) - Number(left.holdsFirst) ||
      compareEntries(left.entry, right.entry) ||
      left.index - right.index;
    matchOf = new Map();
    const taken = new Set<number>();
    for (const [marked, minimum] of [
      [true, Number.MIN_VALUE],
      [false, MATCH_MIN],
    ] as const) {
      for (const pair of pairs.filter((candidate) => candidate.marked === marked).sort(order)) {
        if (pair.score < minimum || matchOf.has(pair.entry.id) || taken.has(pair.index)) continue;
        matchOf.set(pair.entry.id, pair.index);
        taken.add(pair.index);
      }
    }
    // An owner-marked entry no topic matched keeps all its runs this round; match again without them.
    const unmatchedMarked = candidates.filter(
      (entry) => hasOwnerMark(entry) && !matchOf.has(entry.id),
    );
    if (unmatchedMarked.length === 0) break;
    for (const entry of unmatchedMarked) {
      frozen.add(entry.id);
      for (const link of entry.runs) ownerPlaced.add(link.runId);
    }
    topics = topics
      .map((topic) => ({ ...topic, runs: topic.runs.filter((runId) => !ownerPlaced.has(runId)) }))
      .filter((topic) => topic.runs.length > 0);
  }

  const placed = new Set(topics.flatMap((topic) => topic.runs));
  let nextEntrySeq = state.nextEntrySeq;
  const idOf = topics.map((topic, index): ThreadEntryId => {
    for (const [entryId, matched] of matchOf) if (matched === index) return entryId;
    return ThreadEntryId.make(`${lines.get(topic.runs[0]!)!.threadId}:e${nextEntrySeq++}`);
  });
  const linksFor = new Map<ThreadEntryId, Array<ThreadEntryRun>>();
  const primaryDone = new Set<RunId>();
  topics.forEach((topic, index) => {
    for (const runId of topic.runs) {
      const second = primaryDone.has(runId);
      primaryDone.add(runId);
      linksFor.set(idOf[index]!, [
        ...(linksFor.get(idOf[index]!) ?? []),
        { runId, source: "regroup", ...(second ? { second: true as const } : {}) },
      ]);
    }
  });
  const byLinkOrder = (left: ThreadEntryRun, right: ThreadEntryRun) =>
    ordinal(left.runId) - ordinal(right.runId);

  const rebuilt: Array<ThreadEntry> = contents.entries.map((entry) => {
    if (entry.status !== "active" || frozen.has(entry.id)) return entry;
    const kept = entry.runs.filter((link) => !placed.has(link.runId));
    // A run the regroup leaves where it was keeps its link, so agreeing costs no churn.
    const regrouped = (linksFor.get(entry.id) ?? []).map(
      (link) =>
        entry.runs.find(
          (old) => old.runId === link.runId && (old.second === true) === (link.second === true),
        ) ?? link,
    );
    const runs = [...kept, ...regrouped].sort(byLinkOrder).slice(-THREAD_ENTRY_RUNS_MAX);
    const index = matchOf.get(entry.id);
    if (index === undefined) {
      if (runs.length > 0) return withSpan({ ...entry, runs }, lines);
      // Retired below, once every topic has its id.
      return { ...entry, runs, status: "retired" as const };
    }
    const topic = topics[index]!;
    const before = new Set(entry.runs.map((link) => link.runId));
    const after = new Set(runs.map((link) => link.runId));
    const unchanged = jaccard(before, after) === 1;
    return withSpan(
      {
        ...entry,
        title:
          entry.titleSource === "owner" ||
          jaccard(before, after) >= TITLE_KEEP_MIN ||
          topic.title === ""
            ? entry.title
            : topic.title,
        outcome: unchanged || topic.outcome === "" ? entry.outcome : topic.outcome,
        runs,
      },
      lines,
    );
  });
  const fresh: Array<ThreadEntry> = topics.flatMap((topic, index) => {
    const id = idOf[index]!;
    if (contents.entries.some((entry) => entry.id === id)) return [];
    const runs = (linksFor.get(id) ?? []).toSorted(byLinkOrder).slice(-THREAD_ENTRY_RUNS_MAX);
    const firstLine = lines.get(runs[0]!.runId)!;
    const lastLine = lines.get(runs.at(-1)!.runId)!;
    return [
      withSpan(
        {
          id,
          threadId: firstLine.threadId,
          title: clamp(topic.title || firstLine.line || "Topic", THREAD_ENTRY_TITLE_MAX),
          titleSource: "model",
          outcome: clamp(topic.outcome || lastLine.line || "", THREAD_ENTRY_OUTCOME_MAX),
          open: [],
          runs,
          startMessageId: firstLine.userMessageId,
          endMessageId: lastLine.replyMessageId,
          startedAt: firstLine.startedAt,
          endedAt: lastLine.repliedAt,
          status: "active",
        },
        lines,
      ),
    ];
  });

  // A retired entry points at the entry that took most of its runs, and every pointer is one hop.
  const all = [...rebuilt, ...fresh];
  const holder = new Map<RunId, ThreadEntryId>();
  for (const entry of all) {
    if (entry.status !== "active") continue;
    for (const link of entry.runs) if (link.second !== true) holder.set(link.runId, entry.id);
  }
  const successor = new Map<ThreadEntryId, ThreadEntryId>();
  rebuilt.forEach((entry, index) => {
    const original = contents.entries[index]!;
    if (entry.status !== "retired" || original.status !== "active") return;
    const counts = new Map<ThreadEntryId, number>();
    for (const link of original.runs) {
      const to = holder.get(link.runId);
      if (to !== undefined) counts.set(to, (counts.get(to) ?? 0) + 1);
    }
    const target = [...counts].sort((left, right) => right[1] - left[1])[0]?.[0];
    if (target !== undefined) successor.set(entry.id, target);
  });
  const byId = new Map(all.map((entry) => [entry.id, entry]));
  const pointerOf = (entry: ThreadEntry) => successor.get(entry.id) ?? entry.mergedInto;
  const activeTarget = (entry: ThreadEntry): ThreadEntryId | undefined => {
    const visited = new Set([entry.id]);
    let target = pointerOf(entry);
    while (target !== undefined && !visited.has(target)) {
      const next = byId.get(target);
      if (next === undefined || next.status === "active") return target;
      visited.add(target);
      target = pointerOf(next);
    }
    return undefined;
  };
  const pointed = all.map((entry): ThreadEntry => {
    if (entry.status !== "retired") return entry;
    const target = activeTarget(entry);
    return target === undefined || target === entry.mergedInto
      ? entry
      : { ...entry, mergedInto: target };
  });
  const rehomed = rehomeOpenItems(pointed);
  const changed = rehomed.filter(
    (entry, index) =>
      index >= contents.entries.length || !sameEntry(entry, contents.entries[index]!),
  );
  const regroupedThrough = Math.max(state.regroupedThrough, coveredThrough);
  return {
    entries: changed,
    runLines: [],
    state: {
      ...state,
      revision: state.revision + 1,
      nextEntrySeq,
      regroupedThrough,
      runsSinceRegroup: input.runLines.filter((line) => line.ordinal > regroupedThrough).length,
      regroupedAt: input.at,
    },
  };
}

const byOrdinal = (left: ThreadRunLine, right: ThreadRunLine) => left.ordinal - right.ordinal;

/**
 * Files older runs that have no line yet. With topics they are regrouped with the rest of the
 * thread (so hand edits and stored ids hold, as in any regroup); without, they join the thread's
 * earliest topic, or one new topic named like the thread. A run already lined is never rewritten,
 * and nothing here touches the card, its open items or the thread's activity.
 */
export function applyBackfill(input: {
  readonly contents: ThreadContents;
  /** The thread's run lines now. */
  readonly runLines: ReadonlyArray<ThreadRunLine>;
  readonly added: ReadonlyArray<ThreadRunLine>;
  readonly topics: ReadonlyArray<ThreadContentsTopic> | undefined;
  readonly threadTitle: string;
  readonly at: string;
}): ThreadEntriesUpdate | null {
  const stored = new Set(input.runLines.map((line) => line.runId));
  const added = [...new Map(input.added.map((line) => [line.runId, line])).values()]
    .filter((line) => !stored.has(line.runId))
    .sort(byOrdinal);
  if (added.length === 0) return null;
  const all = [...input.runLines, ...added].sort(byOrdinal);
  const lines = new Map(all.map((line) => [line.runId, line]));
  const ordinalOf = (link: ThreadEntryRun) =>
    lines.get(link.runId)?.ordinal ?? Number.MAX_SAFE_INTEGER;
  const byLinkOrdinal = (left: ThreadEntryRun, right: ThreadEntryRun) =>
    ordinalOf(left) - ordinalOf(right);
  const contents: ThreadContents = {
    ...input.contents,
    state: input.contents.state ?? EMPTY_STATE,
  };

  let entries = [...contents.entries];
  let state = contents.state!;
  if (input.topics !== undefined && input.topics.length > 0) {
    const regrouped = applyRegroup({
      contents,
      runLines: all,
      topics: input.topics,
      at: input.at,
    })!;
    const replaced = new Map(regrouped.entries.map((entry) => [entry.id, entry]));
    entries = [
      ...entries.map((entry) => replaced.get(entry.id) ?? entry),
      ...regrouped.entries.filter((entry) => !contents.entries.some((old) => old.id === entry.id)),
    ];
    state = regrouped.state;
  }

  const held = new Set(
    entries.flatMap((entry) =>
      entry.status === "active" ? entry.runs.map((link) => link.runId) : [],
    ),
  );
  const unlinked = added.filter((line) => !held.has(line.runId));
  let nextEntrySeq = state.nextEntrySeq;
  if (unlinked.length > 0) {
    const links = unlinked.map((line): ThreadEntryRun => ({
      runId: line.runId,
      source: "regroup",
    }));
    const home = entries.filter((entry) => entry.status === "active").toSorted(compareEntries)[0];
    if (home !== undefined) {
      entries = entries.map((entry) =>
        entry.id === home.id
          ? withSpan(
              {
                ...entry,
                runs: [...entry.runs, ...links].sort(byLinkOrdinal).slice(-THREAD_ENTRY_RUNS_MAX),
              },
              lines,
            )
          : entry,
      );
    } else {
      const first = unlinked[0]!;
      const last = unlinked.at(-1)!;
      entries.push({
        id: ThreadEntryId.make(`${first.threadId}:e${nextEntrySeq++}`),
        threadId: first.threadId,
        title: clamp(input.threadTitle || first.line || "Topic", THREAD_ENTRY_TITLE_MAX),
        titleSource: "model",
        outcome: clamp(last.line ?? "", THREAD_ENTRY_OUTCOME_MAX),
        open: [],
        runs: links.slice(-THREAD_ENTRY_RUNS_MAX),
        startMessageId: first.userMessageId,
        endMessageId: last.replyMessageId,
        startedAt: first.startedAt,
        endedAt: last.repliedAt,
        status: "active",
      });
    }
  }

  const before = new Map(contents.entries.map((entry) => [entry.id, entry]));
  return {
    entries: entries.filter((entry) => before.get(entry.id) !== entry),
    runLines: added,
    state: {
      ...state,
      revision: contents.state!.revision + 1,
      nextEntrySeq,
      ownerRuns: all.filter((line) => line.startedBy === "owner").length,
      lastRunOrdinal: Math.max(...all.map((line) => line.ordinal)),
      lastReplyAt: all.reduce<string | null>(
        (latest, line) => (latest === null || line.repliedAt > latest ? line.repliedAt : latest),
        null,
      ),
      runsSinceRegroup: all.filter((line) => line.ordinal > state.regroupedThrough).length,
    },
  };
}
