import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  THREAD_CARD_LINE_MAX,
  THREAD_CARD_OPEN_MAX,
  ThreadCardOpenItem,
  ThreadCardOpenKind,
} from "./threadCard.ts";

/** `${threadId}:e${seq}`, never reused. The model only ever sees per-call `e1`, `e2`, … */
export const ThreadEntryId = TrimmedNonEmptyString.pipe(Schema.brand("ThreadEntryId"));
export type ThreadEntryId = typeof ThreadEntryId.Type;

export const THREAD_ENTRY_TITLE_MAX = 80;
export const THREAD_ENTRY_OUTCOME_MAX = 120;
export const THREAD_ENTRY_RUNS_MAX = 1_000;
export const THREAD_RUN_OWNER_TEXT_MAX = 400;
/** Owner-run counts at which a thread is regrouped as soon as it reaches them. */
export const THREAD_REGROUP_MARKS: ReadonlyArray<number> = [10, 20, 40, 80];

export const ThreadEntryLinkSource = Schema.Literals(["online", "regroup", "owner"]);
export type ThreadEntryLinkSource = typeof ThreadEntryLinkSource.Type;

/** One run filed under one entry. A run has one link, or two when it gave a result on two topics. */
export const ThreadEntryRun = Schema.Struct({
  runId: RunId,
  source: ThreadEntryLinkSource,
  /** This is the run's second entry; open items the run raised sit with its first. */
  second: Schema.optional(Schema.Literal(true)),
});
export type ThreadEntryRun = typeof ThreadEntryRun.Type;

/** A card open item plus the run whose card first listed it. */
export const ThreadEntryOpenItem = Schema.Struct({ ...ThreadCardOpenItem.fields, runId: RunId });
export type ThreadEntryOpenItem = typeof ThreadEntryOpenItem.Type;

const ThreadEntryTitle = Schema.String.check(Schema.isMaxLength(THREAD_ENTRY_TITLE_MAX));
const ThreadEntryOutcome = Schema.String.check(Schema.isMaxLength(THREAD_ENTRY_OUTCOME_MAX));
const ThreadEntryOpen = Schema.Array(ThreadEntryOpenItem).check(
  Schema.isMaxLength(THREAD_CARD_OPEN_MAX),
);

export const ThreadEntry = Schema.Struct({
  id: ThreadEntryId,
  threadId: ThreadId,
  title: ThreadEntryTitle,
  titleSource: Schema.Literals(["model", "owner"]),
  outcome: ThreadEntryOutcome,
  open: ThreadEntryOpen,
  runs: Schema.Array(ThreadEntryRun).check(Schema.isMaxLength(THREAD_ENTRY_RUNS_MAX)),
  /** The message that started the entry's first run. */
  startMessageId: MessageId,
  /** The reply of the entry's latest run. */
  endMessageId: MessageId,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  status: Schema.Literals(["active", "retired"]),
  /** On a retired entry: the active entry that took its runs. Always one hop. */
  mergedInto: Schema.optional(ThreadEntryId),
});
export type ThreadEntry = typeof ThreadEntry.Type;

/** What the server kept about one carded run. Never sent to a list; only inside the event. */
export const ThreadRunLine = Schema.Struct({
  runId: RunId,
  threadId: ThreadId,
  ordinal: PositiveInt,
  userMessageId: MessageId,
  replyMessageId: MessageId,
  /** The card line. Null for a backfilled run nobody asked a model about. */
  line: Schema.NullOr(Schema.String.check(Schema.isMaxLength(THREAD_CARD_LINE_MAX))),
  /** The owner's words as the outline shows them. Null when nobody typed anything in this run. */
  ownerText: Schema.NullOr(Schema.String.check(Schema.isMaxLength(THREAD_RUN_OWNER_TEXT_MAX))),
  startedBy: Schema.Literals(["owner", "report", "other"]),
  startedAt: IsoDateTime,
  repliedAt: IsoDateTime,
});
export type ThreadRunLine = typeof ThreadRunLine.Type;

/** Per-thread bookkeeping. Sent whole whenever it changes. */
export const ThreadContentsState = Schema.Struct({
  /** +1 on every entries update; guards Undo. */
  revision: NonNegativeInt,
  nextEntrySeq: PositiveInt,
  /** Run lines with `startedBy: "owner"`. */
  ownerRuns: NonNegativeInt,
  lastRunOrdinal: NonNegativeInt,
  lastReplyAt: Schema.NullOr(IsoDateTime),
  /** Run lines newer than the last regroup. Counts carded runs, not ordinals (which skip). */
  runsSinceRegroup: NonNegativeInt,
  /** A run ordinal; stops a second request for the same runs. */
  regroupRequestedThrough: NonNegativeInt,
  regroupedThrough: NonNegativeInt,
  regroupedAt: Schema.NullOr(IsoDateTime),
});
export type ThreadContentsState = typeof ThreadContentsState.Type;

export const ThreadEntriesUpdate = Schema.Struct({
  /** Every entry that changed, whole, retired ones included. */
  entries: Schema.Array(ThreadEntry),
  runLines: Schema.Array(ThreadRunLine),
  state: ThreadContentsState,
});
export type ThreadEntriesUpdate = typeof ThreadEntriesUpdate.Type;

/** One row of a cross-thread list. No run list: it can hold hundreds of ids. */
export const ThreadEntryListItem = Schema.Struct({
  id: ThreadEntryId,
  threadId: ThreadId,
  projectId: ProjectId,
  title: ThreadEntryTitle,
  outcome: ThreadEntryOutcome,
  open: ThreadEntryOpen,
  startMessageId: MessageId,
  endMessageId: MessageId,
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  threadTitle: Schema.String,
  threadSettled: Schema.Boolean,
});
export type ThreadEntryListItem = typeof ThreadEntryListItem.Type;

/** What a filer returns for one run. `ref` is a stored id or "new". */
export const ThreadEntryFiling = Schema.Struct({
  ref: Schema.Union([Schema.Literal("new"), ThreadEntryId]),
  title: Schema.optional(ThreadEntryTitle),
  outcome: ThreadEntryOutcome,
});
export type ThreadEntryFiling = typeof ThreadEntryFiling.Type;

/** One topic of a regroup or backfill, by the runs it holds. */
export const ThreadContentsTopic = Schema.Struct({
  title: ThreadEntryTitle,
  outcome: ThreadEntryOutcome,
  runIds: Schema.Array(RunId),
});
export type ThreadContentsTopic = typeof ThreadContentsTopic.Type;

// RPC

export const ListThreadEntriesInput = Schema.Struct({ threadId: ThreadId });

/** Active entries only, in order of first appearance. */
export const ListThreadEntriesResult = Schema.Struct({
  entries: Schema.Array(ThreadEntry),
  revision: NonNegativeInt,
});
export type ListThreadEntriesResult = typeof ListThreadEntriesResult.Type;

/** Where a page of entries starts: below this `endedAt`, then after this id. */
export const ThreadEntryCursor = Schema.Struct({ endedAt: IsoDateTime, entryId: ThreadEntryId });
export type ThreadEntryCursor = typeof ThreadEntryCursor.Type;

export const ListEntriesInput = Schema.Struct({
  projectIds: Schema.optionalKey(Schema.Array(ProjectId)),
  stillOpen: Schema.optionalKey(Schema.Boolean),
  /** Only entries holding an open item of this kind. Servers that predate it ignore it. */
  openKind: Schema.optionalKey(ThreadCardOpenKind),
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(100))),
  before: Schema.optionalKey(ThreadEntryCursor),
  /** 50 when absent. */
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});
export type ListEntriesInput = typeof ListEntriesInput.Type;

/** Active entries, newest `endedAt` first. */
export const ListEntriesResult = Schema.Struct({
  entries: Schema.Array(ThreadEntryListItem),
  next: Schema.NullOr(ThreadEntryCursor),
});
export type ListEntriesResult = typeof ListEntriesResult.Type;

/** What a project's root checkout holds that is not out: files uncommitted, commits on no remote. */
export const ProjectChangeCounts = Schema.Struct({
  uncommittedFiles: NonNegativeInt,
  unpushedCommits: NonNegativeInt,
});
export type ProjectChangeCounts = typeof ProjectChangeCounts.Type;

/** Only projects with a non-zero count, a publish marker or changes in their checkout. */
export const OpenItemCountsResult = Schema.Struct({
  projects: Schema.Array(
    Schema.Struct({
      projectId: ProjectId,
      counts: Schema.Record(ThreadCardOpenKind, NonNegativeInt),
      lastPublishedAt: Schema.NullOr(IsoDateTime),
      /** Absent from a server that predates it, and for a folder that is not a Git checkout. */
      changes: Schema.optional(ProjectChangeCounts),
    }),
  ),
});
export type OpenItemCountsResult = typeof OpenItemCountsResult.Type;

export const GetProjectChangesInput = Schema.Struct({ projectId: ProjectId });
export type GetProjectChangesInput = typeof GetProjectChangesInput.Type;

/** Files a topic is credited with; a null entry is files no thread is known to have changed. */
export const ProjectChangeTopic = Schema.Struct({
  entryId: Schema.NullOr(ThreadEntryId),
  files: NonNegativeInt,
});
export type ProjectChangeTopic = typeof ProjectChangeTopic.Type;

export const ProjectChangeCommit = Schema.Struct({
  sha: TrimmedNonEmptyString,
  subject: Schema.String,
  author: Schema.String,
  /** Made by the checkout's own git user. Only these carry topics. */
  own: Schema.Boolean,
  committedAt: IsoDateTime,
  /** On some remote branch. */
  pushed: Schema.Boolean,
  files: NonNegativeInt,
  topics: Schema.Array(ProjectChangeTopic),
});
export type ProjectChangeCommit = typeof ProjectChangeCommit.Type;

/** A topic a change list names, with where to open it. */
export const ProjectChangeEntry = Schema.Struct({
  id: ThreadEntryId,
  threadId: ThreadId,
  title: ThreadEntryTitle,
  outcome: ThreadEntryOutcome,
  threadTitle: Schema.String,
  startMessageId: MessageId,
});
export type ProjectChangeEntry = typeof ProjectChangeEntry.Type;

export const PROJECT_CHANGE_TITLE_MAX = 60;
export const PROJECT_CHANGE_SUMMARY_MAX = 200;
export const PROJECT_CHANGE_COMMIT_LABEL_MAX = 80;

/** One piece of work in a changelog: what changed, and the commits that carry it. */
export const ProjectChangeItem = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(PROJECT_CHANGE_TITLE_MAX)),
  summary: Schema.String.check(Schema.isMaxLength(PROJECT_CHANGE_SUMMARY_MAX)),
  shas: Schema.Array(TrimmedNonEmptyString),
});
export type ProjectChangeItem = typeof ProjectChangeItem.Type;

/**
 * The owner's commits between two publishes, or in one week of a project never marked
 * published. `key` names exactly that set of commits, so a stored changelog is never shown for
 * another.
 */
export const ProjectChangePeriod = Schema.Struct({
  key: TrimmedNonEmptyString,
  /** The publish that closed the period; null while it is still open, and for a week. */
  publishedAt: Schema.NullOr(IsoDateTime),
  startedAt: IsoDateTime,
  endedAt: IsoDateTime,
  /** Newest first. */
  shas: Schema.Array(TrimmedNonEmptyString),
  /** Null until the period has been summarized. */
  items: Schema.NullOr(Schema.Array(ProjectChangeItem)),
  /**
   * The items come from an earlier changelog that covers only some of these commits, shown
   * while this period's own changelog is written. Commits in no item are listed apart.
   */
  stale: Schema.optional(Schema.Boolean),
  /**
   * What each commit did, by commit id, in a few words that do not repeat its change's title.
   * A commit without one is shown by its subject.
   */
  labels: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.String.check(Schema.isMaxLength(PROJECT_CHANGE_COMMIT_LABEL_MAX)),
    ),
  ),
});
export type ProjectChangePeriod = typeof ProjectChangePeriod.Type;

export const SummarizeProjectChangesInput = Schema.Struct({
  projectId: ProjectId,
  /** The periods the viewer has reached; without them the newest periods are written first. */
  periodKeys: Schema.optional(Schema.Array(Schema.String)),
});
export type SummarizeProjectChangesInput = typeof SummarizeProjectChangesInput.Type;

export const SummarizeProjectChangesResult = Schema.Struct({ summarized: NonNegativeInt });
export type SummarizeProjectChangesResult = typeof SummarizeProjectChangesResult.Type;

/**
 * What a project's root checkout holds that is not committed, pushed or published, and its
 * recent commits. File and commit totals come from Git and are exact; the topic a file is
 * credited to is the last thread known to have changed it, which is a best guess.
 */
export const ProjectChangesResult = Schema.Struct({
  /** Null when the project's folder is not a Git checkout. */
  branch: Schema.NullOr(Schema.String),
  isRepository: Schema.Boolean,
  /** Absent from a server that predates it; false for a local-only Git repo with no remotes. */
  hasRemote: Schema.optional(Schema.Boolean),
  uncommitted: Schema.Struct({
    files: NonNegativeInt,
    topics: Schema.Array(ProjectChangeTopic),
  }),
  unpushedCommits: NonNegativeInt,
  /** Newest first, merges left out. */
  commits: Schema.Array(ProjectChangeCommit),
  /** Newest first. */
  publishes: Schema.Array(IsoDateTime),
  entries: Schema.Array(ProjectChangeEntry),
  /** Newest first. Absent from a server that predates changelogs. */
  periods: Schema.optional(Schema.Array(ProjectChangePeriod)),
});
export type ProjectChangesResult = typeof ProjectChangesResult.Type;

export const PublishMarkerId = TrimmedNonEmptyString.pipe(Schema.brand("PublishMarkerId"));
export type PublishMarkerId = typeof PublishMarkerId.Type;

export const MarkPublishedInput = Schema.Struct({
  projectIds: Schema.Array(ProjectId),
  threadId: Schema.optionalKey(ThreadId),
});
export type MarkPublishedInput = typeof MarkPublishedInput.Type;

export const MarkPublishedResult = Schema.Struct({
  markerId: PublishMarkerId,
  cleared: NonNegativeInt,
  followUpsStarted: NonNegativeInt,
});
export type MarkPublishedResult = typeof MarkPublishedResult.Type;

export const UndoPublishedInput = Schema.Struct({ markerId: PublishMarkerId });
export const UndoPublishedResult = Schema.Struct({ restored: NonNegativeInt });

/** "Done" on one open item: `key` is its `threadCardOpenItemKey`. */
export const ResolveOpenItemInput = Schema.Struct({
  threadId: ThreadId,
  key: TrimmedNonEmptyString,
});
export type ResolveOpenItemInput = typeof ResolveOpenItemInput.Type;

/** Re-checks the projects' checkouts and clears `commit` items on a clean one. */
export const RefreshOpenItemsInput = Schema.Struct({ projectIds: Schema.Array(ProjectId) });
export const RefreshOpenItemsResult = Schema.Struct({ cleared: NonNegativeInt });

export const ContentsBackfillEstimateInput = Schema.Struct({
  projectId: ProjectId,
  since: Schema.optionalKey(IsoDateTime),
  only: Schema.optionalKey(Schema.Literals(["long", "short"])),
});
export type ContentsBackfillEstimateInput = typeof ContentsBackfillEstimateInput.Type;

/** Lives fifteen minutes; `start` refuses an unknown or expired id. */
export const ContentsBackfillEstimate = Schema.Struct({
  estimateId: TrimmedNonEmptyString,
  threads: Schema.Struct({
    short: NonNegativeInt,
    long: NonNegativeInt,
    /** Threads migrated from the old format; their replies from before have no runs to file. */
    migrated: NonNegativeInt,
  }),
  runs: NonNegativeInt,
  calls: Schema.Struct({ headlines: NonNegativeInt, regroups: NonNegativeInt }),
  /** The prompts' own text. A provider's fixed instructions per call come on top. */
  promptTokens: NonNegativeInt,
  outputTokens: NonNegativeInt,
});
export type ContentsBackfillEstimate = typeof ContentsBackfillEstimate.Type;

export const ContentsBackfillStartInput = Schema.Struct({
  estimateId: ContentsBackfillEstimate.fields.estimateId,
});
export const ContentsBackfillStartResult = Schema.Struct({ jobId: TrimmedNonEmptyString });

/** The environment's one backfill job, or null when none has run since the server started. */
export const ContentsBackfillStatus = Schema.NullOr(
  Schema.Struct({
    jobId: TrimmedNonEmptyString,
    projectId: ProjectId,
    done: NonNegativeInt,
    total: NonNegativeInt,
    calls: NonNegativeInt,
    failed: NonNegativeInt,
    finishedAt: Schema.NullOr(IsoDateTime),
  }),
);
export type ContentsBackfillStatus = typeof ContentsBackfillStatus.Type;

export class ThreadContentsError extends Schema.TaggedError<ThreadContentsError>()(
  "ThreadContentsError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
