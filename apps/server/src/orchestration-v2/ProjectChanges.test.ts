import { RunId, ThreadEntryId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  assembleTouches,
  buildProjectChanges,
  type ChangeTouch,
  type GitCommitFacts,
  parseGitLogWithFiles,
  parseGitStatusPaths,
} from "./ProjectChanges.ts";

const HOUR = 3_600_000;
const isoAtHour = (hour: number) => DateTime.formatIso(DateTime.makeUnsafe(hour * HOUR));
const store = ThreadEntryId.make("thread:a:e1");
const ranked = ThreadEntryId.make("thread:b:e1");
const touch = (
  entryId: ThreadEntryId,
  path: string,
  startHour: number,
  endHour: number,
): ChangeTouch => ({ path, entryId, startMs: startHour * HOUR, endMs: endHour * HOUR });
const commit = (
  sha: string,
  hour: number,
  files: ReadonlyArray<string>,
  own = true,
): GitCommitFacts => ({
  sha,
  subject: sha,
  author: own ? "Owner" : "Friend",
  own,
  committedAtMs: hour * HOUR,
  files,
});
const build = (input: Partial<Parameters<typeof buildProjectChanges>[0]>) =>
  buildProjectChanges({
    touches: [],
    dirtyPaths: [],
    commits: [],
    unpushedShas: new Set(),
    publishedAtMs: [],
    ...input,
  });

describe("buildProjectChanges", () => {
  it("counts every dirty file and commit once, under the last topic to change the file", () => {
    const changes = build({
      touches: [
        touch(store, "Shop.luau", 1, 2),
        touch(ranked, "Shop.luau", 5, 6),
        touch(ranked, "Ranked.luau", 5, 6),
      ],
      dirtyPaths: ["Shop.luau", "Ranked.luau", "notes.txt"],
      commits: [commit("c1", 3, ["Shop.luau", "README.md"])],
      unpushedShas: new Set(["c1"]),
    });
    expect(changes.commits).toMatchObject([
      {
        sha: "c1",
        pushed: false,
        files: 2,
        topics: [
          { entryId: store, files: 1 },
          { entryId: null, files: 1 },
        ],
      },
    ]);
    expect(changes.unpushedCommits).toBe(1);
    // Shop.luau was committed at hour 3, so its dirt is the later run's, not the store work.
    expect(changes.uncommitted).toEqual({
      files: 3,
      topics: [
        { entryId: ranked, files: 2 },
        { entryId: null, files: 1 },
      ],
    });
  });

  it("credits a commit made partway through a run to that run", () => {
    const changes = build({
      touches: [touch(store, "Shop.luau", 1, 9)],
      commits: [commit("c1", 4, ["Shop.luau"])],
    });
    expect(changes.commits[0]?.topics).toEqual([{ entryId: store, files: 1 }]);
    expect(changes.commits[0]?.pushed).toBe(true);
  });

  it("prefers the run that ended with the commit over a longer one still going beside it", () => {
    const changes = build({
      touches: [touch(ranked, "Shop.luau", 1, 9), touch(store, "Shop.luau", 3, 4.05)],
      commits: [commit("c1", 4, ["Shop.luau"])],
    });
    expect(changes.commits[0]?.topics).toEqual([{ entryId: store, files: 1 }]);
  });

  it("gives another author's commit no topic, though a run recorded its files", () => {
    const changes = build({
      touches: [touch(store, "Maps.luau", 1, 4)],
      commits: [commit("pulled", 2, ["Maps.luau"], false)],
    });
    expect(changes.commits[0]).toMatchObject({ own: false, files: 1, topics: [] });
  });

  it("lists what changed after the last publish, committed or not, one path once", () => {
    const changes = build({
      touches: [
        touch(store, "Shop.luau", 1, 2),
        touch(ranked, "Ranked.luau", 6, 7),
        touch(store, "Ranked.luau", 8, 9),
      ],
      commits: [commit("c1", 10, ["Shop.luau", "Ranked.luau"])],
      publishedAtMs: [3 * HOUR, 5 * HOUR],
    });
    expect(changes.sincePublish).toEqual({
      publishedAt: isoAtHour(5),
      topics: [{ entryId: store, files: 1 }],
    });
    expect(changes.publishes).toEqual([isoAtHour(5), isoAtHour(3)]);
    expect(build({}).sincePublish).toBeNull();
  });
});

describe("assembleTouches", () => {
  const lead = ThreadId.make("thread:lead");
  const worker = ThreadId.make("thread:worker");
  const apart = ThreadId.make("thread:apart");
  const run = (name: string) => RunId.make(`run:${name}`);
  const touches = assembleTouches({
    threads: [
      { threadId: lead, parentThreadId: null, worktreePath: null },
      { threadId: worker, parentThreadId: lead, worktreePath: null },
      { threadId: apart, parentThreadId: null, worktreePath: "/worktrees/apart" },
    ],
    entries: [
      { id: store, threadId: lead, runs: [{ runId: run("lead-1") }] },
      {
        id: ranked,
        threadId: lead,
        runs: [{ runId: run("lead-2") }, { runId: run("lead-1"), second: true }],
      },
    ],
    runStartedAtMs: new Map([
      [run("lead-1"), 1 * HOUR],
      [run("lead-2"), 5 * HOUR],
    ]),
    checkpoints: [
      { threadId: lead, runId: run("lead-1"), capturedAtMs: 2 * HOUR, paths: ["Shop.luau"] },
      // A subagent's run is filed nowhere; it counts for the topic its lead was on by then.
      { threadId: worker, runId: run("worker-1"), capturedAtMs: 6 * HOUR, paths: ["Ranked.luau"] },
      { threadId: apart, runId: run("apart-1"), capturedAtMs: 6 * HOUR, paths: ["Other.luau"] },
    ],
  });

  it("files a run under its first topic, a subagent under its lead's, and skips worktrees", () => {
    expect(touches).toEqual([
      { path: "Shop.luau", entryId: store, startMs: 1 * HOUR, endMs: 2 * HOUR },
      { path: "Ranked.luau", entryId: ranked, startMs: 6 * HOUR, endMs: 6 * HOUR },
    ]);
  });
});

describe("git output", () => {
  it("reads log records with their files, marking the checkout's own author", () => {
    const stdout = [
      "\x1eaaa\x1f1700000000\x1fOwner\x1fOwner@Example.com\x1ffix: a | b",
      "",
      "src/a.ts",
      "src/b c.ts",
      "",
      "\x1ebbb\x1f1700003600\x1fFriend\x1ffriend@example.com\x1fmaps",
      "",
    ].join("\n");
    expect(parseGitLogWithFiles(stdout, "owner@example.com")).toEqual([
      {
        sha: "aaa",
        subject: "fix: a | b",
        author: "Owner",
        own: true,
        committedAtMs: 1_700_000_000_000,
        files: ["src/a.ts", "src/b c.ts"],
      },
      {
        sha: "bbb",
        subject: "maps",
        author: "Friend",
        own: false,
        committedAtMs: 1_700_003_600_000,
        files: [],
      },
    ]);
  });

  it("reads status paths, taking a rename's new path and skipping its old one", () => {
    expect(parseGitStatusPaths(" M src/a.ts\0R  new name.ts\0old.ts\0?? notes.txt\0")).toEqual([
      "src/a.ts",
      "new name.ts",
      "notes.txt",
    ]);
  });
});
