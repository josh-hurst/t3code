import type {
  ProjectChangeCommit,
  ProjectChangeTopic,
  RunId,
  ThreadEntryId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** One run's record that it changed a path, as the window the change fell in. */
export interface ChangeTouch {
  readonly path: string;
  readonly entryId: ThreadEntryId;
  readonly startMs: number;
  readonly endMs: number;
}

export interface GitCommitFacts {
  readonly sha: string;
  readonly subject: string;
  readonly body: string;
  readonly author: string;
  /** Made by this checkout's own git user; another author's commit carries no topic. */
  readonly own: boolean;
  readonly committedAtMs: number;
  readonly files: ReadonlyArray<string>;
}

/** How long after a commit its own run may still be wrapping up. */
const RUN_END_SLACK_MS = 10 * 60 * 1_000;

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));

/**
 * Which run changed which path, each under the topic its top-level thread was on. A subagent's
 * edits count for the topic its top-level thread was on when they were captured. Threads
 * working in their own worktree are left out: the list is about the project's root checkout.
 */
export function assembleTouches(input: {
  readonly threads: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly parentThreadId: ThreadId | null;
    readonly worktreePath: string | null;
  }>;
  /** Topics of top-level threads, each with the runs filed under it. */
  readonly entries: ReadonlyArray<{
    readonly id: ThreadEntryId;
    readonly threadId: ThreadId;
    readonly runs: ReadonlyArray<{ readonly runId: RunId; readonly second?: true | undefined }>;
  }>;
  readonly runStartedAtMs: ReadonlyMap<RunId, number>;
  readonly checkpoints: ReadonlyArray<{
    readonly threadId: ThreadId;
    readonly runId: RunId;
    readonly capturedAtMs: number;
    readonly paths: ReadonlyArray<string>;
  }>;
}): Array<ChangeTouch> {
  const threadOf = new Map(input.threads.map((thread) => [thread.threadId, thread]));
  const topOf = (threadId: ThreadId) => {
    let current = threadId;
    const seen = new Set<ThreadId>();
    for (;;) {
      const parent = threadOf.get(current)?.parentThreadId ?? null;
      if (parent === null || seen.has(current) || !threadOf.has(parent)) return current;
      seen.add(current);
      current = parent;
    }
  };
  const entryOfRun = new Map<RunId, ThreadEntryId>();
  const starts = new Map<ThreadId, Array<{ atMs: number; entryId: ThreadEntryId }>>();
  for (const entry of input.entries) {
    for (const link of entry.runs) {
      // A run that gave a result on two topics changed files for the first.
      if (link.second === true) continue;
      entryOfRun.set(link.runId, entry.id);
      const atMs = input.runStartedAtMs.get(link.runId);
      if (atMs === undefined) continue;
      const list = starts.get(entry.threadId) ?? [];
      list.push({ atMs, entryId: entry.id });
      starts.set(entry.threadId, list);
    }
  }
  for (const list of starts.values()) list.sort((left, right) => left.atMs - right.atMs);

  const touches: Array<ChangeTouch> = [];
  for (const checkpoint of input.checkpoints) {
    const top = topOf(checkpoint.threadId);
    if ((threadOf.get(top)?.worktreePath ?? null) !== null) continue;
    const entryId =
      entryOfRun.get(checkpoint.runId) ??
      (starts.get(top) ?? []).findLast((start) => start.atMs <= checkpoint.capturedAtMs)?.entryId;
    if (entryId === undefined) continue;
    const startMs = input.runStartedAtMs.get(checkpoint.runId) ?? checkpoint.capturedAtMs;
    for (const path of checkpoint.paths) {
      touches.push({ path, entryId, startMs, endMs: checkpoint.capturedAtMs });
    }
  }
  return touches;
}

function tally(labels: ReadonlyArray<ThreadEntryId | null>): Array<ProjectChangeTopic> {
  const files = new Map<ThreadEntryId | null, number>();
  for (const label of labels) files.set(label, (files.get(label) ?? 0) + 1);
  return [...files]
    .map(([entryId, count]) => ({ entryId, files: count }))
    .sort(
      (left, right) =>
        Number(left.entryId === null) - Number(right.entryId === null) ||
        right.files - left.files ||
        (left.entryId ?? "").localeCompare(right.entryId ?? ""),
    );
}

/**
 * Git says exactly which files are uncommitted and which commits exist; this adds which topic
 * each belongs to. A file takes the topic of the last run that changed it since the file's
 * previous commit. That is a best guess: a run's record also lists files a concurrent session
 * changed in the same checkout, so totals are exact and labels are not.
 */
export function buildProjectChanges(input: {
  readonly touches: ReadonlyArray<ChangeTouch>;
  readonly dirtyPaths: ReadonlyArray<string>;
  readonly commits: ReadonlyArray<GitCommitFacts>;
  readonly unpushedShas: ReadonlySet<string>;
  readonly publishedAtMs: ReadonlyArray<number>;
}) {
  const touchesOf = new Map<string, Array<ChangeTouch>>();
  for (const touch of input.touches) {
    const list = touchesOf.get(touch.path);
    if (list === undefined) touchesOf.set(touch.path, [touch]);
    else list.push(touch);
  }
  /**
   * The last run to change `path` after `afterMs` that had begun by `untilMs`. A run that had
   * finished by then, or did within minutes, wins over one still going: the run that commits
   * its work ends soon after, while a long run beside it only saw the file change.
   */
  const labelOf = (path: string, afterMs: number, untilMs: number): ThreadEntryId | null => {
    let finished: ChangeTouch | null = null;
    let ongoing: ChangeTouch | null = null;
    for (const touch of touchesOf.get(path) ?? []) {
      if (touch.endMs <= afterMs || touch.startMs > untilMs) continue;
      if (touch.endMs <= untilMs + RUN_END_SLACK_MS) {
        if (finished === null || touch.endMs > finished.endMs) finished = touch;
      } else if (ongoing === null || touch.endMs > ongoing.endMs) {
        ongoing = touch;
      }
    }
    return (finished ?? ongoing)?.entryId ?? null;
  };

  const lastCommitAt = new Map<string, number>();
  const oldestFirst = input.commits.toSorted(
    (left, right) => left.committedAtMs - right.committedAtMs,
  );
  const commits: Array<ProjectChangeCommit> = [];
  for (const commit of oldestFirst) {
    const labels = commit.files.map((path) =>
      commit.own ? labelOf(path, lastCommitAt.get(path) ?? 0, commit.committedAtMs) : null,
    );
    for (const path of commit.files) lastCommitAt.set(path, commit.committedAtMs);
    commits.push({
      sha: commit.sha,
      subject: commit.subject,
      author: commit.author,
      own: commit.own,
      committedAt: iso(commit.committedAtMs),
      pushed: !input.unpushedShas.has(commit.sha),
      files: commit.files.length,
      topics: commit.own ? tally(labels) : [],
    });
  }
  commits.reverse();

  return {
    uncommitted: {
      files: input.dirtyPaths.length,
      topics: tally(
        input.dirtyPaths.map((path) =>
          labelOf(path, lastCommitAt.get(path) ?? 0, Number.POSITIVE_INFINITY),
        ),
      ),
    },
    unpushedCommits: commits.filter((commit) => !commit.pushed).length,
    commits,
    publishes: input.publishedAtMs.toSorted((left, right) => right - left).map(iso),
  };
}

/** The entry ids a result names, so the service loads only those. */
export function projectChangeEntryIds(
  changes: ReturnType<typeof buildProjectChanges>,
): ReadonlySet<ThreadEntryId> {
  const ids = new Set<ThreadEntryId>();
  const add = (topics: ReadonlyArray<ProjectChangeTopic>) => {
    for (const topic of topics) if (topic.entryId !== null) ids.add(topic.entryId);
  };
  add(changes.uncommitted.topics);
  for (const commit of changes.commits) add(commit.topics);
  return ids;
}

/**
 * Splits `git log --format=%x1e<fields joined by %x1f>[%x1d] [--name-only]` output. A record is
 * its fields, the last of them the body when the format asks for one, then after `%x1d` one path
 * per line. With no `ownEmail` every commit counts as the owner's.
 */
export function parseGitLogWithFiles(
  stdout: string,
  ownEmail: string | null,
): Array<GitCommitFacts> {
  const commits: Array<GitCommitFacts> = [];
  for (const record of stdout.split("\x1e")) {
    const [head = "", names = ""] = record.split("\x1d");
    const [sha, committedAt, author, email, subject, body] = head.split("\x1f");
    const committedAtMs = Number(committedAt) * 1_000;
    if (!sha || !Number.isFinite(committedAtMs)) continue;
    commits.push({
      sha,
      subject: (subject ?? "").trim(),
      body: (body ?? "").trim(),
      author: author ?? "",
      own: ownEmail === null || email?.toLowerCase() === ownEmail.toLowerCase(),
      committedAtMs,
      files: names
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== ""),
    });
  }
  return commits;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1_000;
// 1970-01-01 was a Thursday; weeks here start on Monday, in UTC.
const FIRST_MONDAY_MS = 4 * 24 * 60 * 60 * 1_000;

export interface ChangePeriod {
  /** Names this exact set of commits: a new commit, an amend or a rebase gives another key. */
  readonly key: string;
  readonly publishedAtMs: number | null;
  /** Oldest first. */
  readonly commits: ReadonlyArray<GitCommitFacts>;
}

/**
 * The owner's commits cut at each publish, newest period first. A project never marked
 * published is cut by week, so its changelog is not one list of a month's work.
 */
export function changePeriods(input: {
  readonly ownCommits: ReadonlyArray<GitCommitFacts>;
  readonly publishedAtMs: ReadonlyArray<number>;
}): Array<ChangePeriod> {
  const commits = input.ownCommits.toSorted(
    (left, right) => left.committedAtMs - right.committedAtMs,
  );
  const publishes = input.publishedAtMs.toSorted((left, right) => left - right);
  const groups = new Map<number, { publishedAtMs: number | null; commits: GitCommitFacts[] }>();
  for (const commit of commits) {
    const closedBy = publishes.find((at) => at >= commit.committedAtMs) ?? null;
    const slot =
      publishes.length === 0
        ? Math.floor((commit.committedAtMs - FIRST_MONDAY_MS) / WEEK_MS)
        : (closedBy ?? Number.POSITIVE_INFINITY);
    const group = groups.get(slot) ?? { publishedAtMs: closedBy, commits: [] };
    group.commits.push(commit);
    groups.set(slot, group);
  }
  return [...groups.entries()]
    .sort((left, right) => right[0] - left[0])
    .map(([, group]) => ({
      // A commit id fixes its whole ancestry, so the ends and the count fix the set.
      key: `${group.commits.at(-1)!.sha}:${group.commits[0]!.sha}:${group.commits.length}`,
      publishedAtMs: group.publishedAtMs,
      commits: group.commits,
    }));
}

/** Paths from `git status --porcelain=v1 -z`: `XY path`, with a rename's old path as the next field. */
export function parseGitStatusPaths(stdout: string): Array<string> {
  const paths: Array<string> = [];
  const fields = stdout.split("\0");
  for (let index = 0; index < fields.length; index += 1) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    paths.push(field.slice(3));
    if (field[0] === "R" || field[0] === "C") index += 1;
  }
  return paths;
}
