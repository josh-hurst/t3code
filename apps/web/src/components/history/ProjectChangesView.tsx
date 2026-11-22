import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type ProjectChangeSection,
  projectChangeSections,
  projectChangeTimeline,
} from "@t3tools/client-runtime/state/thread-entries";
import { trailDayLabel } from "@t3tools/client-runtime/state/thread-zones";
import type {
  EnvironmentId,
  ProjectChangeCommit,
  ProjectChangeEntry,
  ProjectChangeItem,
  ProjectChangePeriod,
  ProjectChangesResult,
  ProjectChangeTopic,
  ProjectId,
  ScopedProjectRef,
  ThreadEntryId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useState } from "react";

import { refreshEntries, threadEntryAtoms, useProjectChanges } from "../../state/threadEntries";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatFullTimestamp, formatShortTimestamp } from "../../timestampFormat";
import { Badge } from "../ui/badge";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

const TOPICS_SHOWN = 8;
const COMMIT_TOPICS_SHOWN = 3;

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

type EntryLookup = ReadonlyMap<ThreadEntryId, ProjectChangeEntry>;

function TopicLink(props: { environmentId: EnvironmentId; entry: ProjectChangeEntry }) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(scopeThreadRef(props.environmentId, props.entry.threadId))}
      search={{ m: props.entry.startMessageId }}
      className="min-w-0 truncate rounded-sm underline-offset-2 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
    >
      {props.entry.title}
    </Link>
  );
}

/** Topics with the files each is credited with; files no thread is known to have changed last. */
function TopicList(props: {
  environmentId: EnvironmentId;
  topics: ReadonlyArray<ProjectChangeTopic>;
  entries: EntryLookup;
}) {
  const [showAll, setShowAll] = useState(false);
  const shown = showAll ? props.topics : props.topics.slice(0, TOPICS_SHOWN);
  return (
    <ul className="flex flex-col">
      {shown.map((topic) => {
        const entry = topic.entryId === null ? undefined : props.entries.get(topic.entryId);
        return (
          <li
            key={topic.entryId ?? "none"}
            className="flex min-w-0 items-baseline gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50"
          >
            <div className="flex min-w-0 flex-1 flex-col">
              {entry ? (
                <>
                  <span className="flex min-w-0 text-sm font-medium text-foreground">
                    <TopicLink environmentId={props.environmentId} entry={entry} />
                  </span>
                  <span className="min-w-0 truncate text-xs text-secondary-label/70">
                    {entry.outcome === "" ? entry.threadTitle : entry.outcome}
                  </span>
                </>
              ) : (
                <span className="text-sm text-secondary-label">No thread changed these</span>
              )}
            </div>
            <span className="shrink-0 text-xs text-secondary-label tabular-nums">
              {plural(topic.files, "file")}
            </span>
          </li>
        );
      })}
      {props.topics.length > TOPICS_SHOWN ? (
        <li className="px-2 py-1 text-xs">
          <InlineButton tone="muted" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `Show ${props.topics.length - TOPICS_SHOWN} more`}
          </InlineButton>
        </li>
      ) : null}
    </ul>
  );
}

function Section(props: {
  title: string;
  note: string;
  /** A publish: its title is drawn in green with a rule across, so publishes stand out. */
  published?: boolean;
  children: React.ReactNode;
}) {
  return (
    <section aria-label={props.title}>
      {props.published ? (
        <div className="mt-3 mb-0.5 flex items-center gap-3 px-2 text-xs">
          <h2 className="shrink-0 font-medium text-success-foreground">{props.title}</h2>
          <span aria-hidden className="h-px flex-1 bg-success/30" />
          {props.note === "" ? null : (
            <span className="shrink-0 text-2xs text-muted-foreground">{props.note}</span>
          )}
        </div>
      ) : (
        <div className="mt-3 mb-0.5 flex items-baseline justify-between gap-3 px-2 text-2xs text-muted-foreground">
          <h2 className="font-medium tracking-wide uppercase">{props.title}</h2>
          <span>{props.note}</span>
        </div>
      )}
      {props.children}
    </section>
  );
}

function CommitRow(props: {
  environmentId: EnvironmentId;
  commit: ProjectChangeCommit;
  entries: EntryLookup;
  timestampFormat: TimestampFormat;
}) {
  const { commit } = props;
  const named = commit.topics.flatMap((topic) => {
    const entry = topic.entryId === null ? undefined : props.entries.get(topic.entryId);
    return entry ? [{ entry, files: topic.files }] : [];
  });
  return (
    <li className="flex min-w-0 gap-3 rounded-md px-2 py-1.5 hover:bg-accent/50">
      <Tooltip>
        <TooltipTrigger
          render={
            <time
              dateTime={commit.committedAt}
              className="w-16 shrink-0 pt-0.5 text-xs text-secondary-label tabular-nums"
            />
          }
        >
          {formatShortTimestamp(commit.committedAt, props.timestampFormat)}
        </TooltipTrigger>
        <TooltipPopup side="top">
          Committed {formatFullTimestamp(commit.committedAt, props.timestampFormat)}
        </TooltipPopup>
      </Tooltip>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm font-medium text-foreground">
            {commit.subject}
          </span>
          {commit.pushed ? null : (
            <Badge variant="warning" size="sm">
              Not pushed
            </Badge>
          )}
        </div>
        {named.length > 0 ? (
          <div className="flex min-w-0 flex-wrap gap-x-1.5 text-xs text-secondary-label">
            {named.slice(0, COMMIT_TOPICS_SHOWN).map(({ entry, files }, index) => (
              <span key={entry.id} className="flex min-w-0 max-w-full gap-1">
                {index > 0 ? <span aria-hidden>·</span> : null}
                <TopicLink environmentId={props.environmentId} entry={entry} />
                {named.length > 1 ? <span className="shrink-0 tabular-nums">{files}</span> : null}
              </span>
            ))}
            {named.length > COMMIT_TOPICS_SHOWN ? (
              <span className="shrink-0">· +{named.length - COMMIT_TOPICS_SHOWN} more</span>
            ) : null}
          </div>
        ) : null}
      </div>
      <span className="shrink-0 pt-0.5 text-xs text-secondary-label tabular-nums">
        <span className="font-mono">{commit.sha.slice(0, 7)}</span> · {plural(commit.files, "file")}
      </span>
    </li>
  );
}

/**
 * A commit under its change: the few words saying what it did, not its subject, which mostly
 * repeats the change's title. The subject is on hover.
 */
function ChangeCommitRow(props: {
  commit: ProjectChangeCommit;
  label: string | undefined;
  /** Only where a change holds both pushed and unpushed commits; else its own row says it. */
  showNotPushed: boolean;
  timestampFormat: TimestampFormat;
}) {
  const { commit } = props;
  return (
    <li className="flex min-w-0 items-baseline gap-3 rounded-md px-2 py-1 hover:bg-accent/50">
      <time
        dateTime={commit.committedAt}
        className="w-16 shrink-0 text-xs text-secondary-label tabular-nums"
      >
        {formatShortTimestamp(commit.committedAt, props.timestampFormat)}
      </time>
      <Tooltip>
        <TooltipTrigger
          render={<span className="min-w-0 flex-1 truncate text-sm text-foreground/90" />}
        >
          {props.label ?? commit.subject}
        </TooltipTrigger>
        <TooltipPopup side="top">{commit.subject}</TooltipPopup>
      </Tooltip>
      {props.showNotPushed && !commit.pushed ? (
        <Badge variant="warning" size="sm">
          Not pushed
        </Badge>
      ) : null}
      <span className="shrink-0 text-xs text-secondary-label tabular-nums">
        <span className="font-mono">{commit.sha.slice(0, 7)}</span> · {plural(commit.files, "file")}
      </span>
    </li>
  );
}

/** One piece of work: what changed, and on a click the commits that carry it. */
function ChangeItemRow(props: {
  item: ProjectChangeItem;
  commits: ReadonlyMap<string, ProjectChangeCommit>;
  labels: Readonly<Record<string, string>>;
  timestampFormat: TimestampFormat;
}) {
  const [open, setOpen] = useState(false);
  const commits = props.item.shas.flatMap((sha) => props.commits.get(sha) ?? []);
  const mixed = commits.some((commit) => commit.pushed) && commits.some((commit) => !commit.pushed);
  return (
    <li className="flex min-w-0 flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full min-w-0 cursor-pointer items-baseline gap-3 rounded-md px-2 py-1.5 text-left outline-none hover:bg-accent/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate text-sm font-medium text-foreground">
              {props.item.title}
            </span>
            {commits.some((commit) => !commit.pushed) ? (
              <Badge variant="warning" size="sm">
                Not pushed
              </Badge>
            ) : null}
          </span>
          {props.item.summary === "" ? null : (
            <span className="line-clamp-2 min-w-0 text-xs text-secondary-label">
              {props.item.summary}
            </span>
          )}
        </span>
        <span className="shrink-0 text-xs text-secondary-label tabular-nums">
          {plural(props.item.shas.length, "commit")}
        </span>
      </button>
      {open ? (
        <ul className="ms-2 flex flex-col border-l border-border ps-1">
          {commits.map((commit) => (
            <ChangeCommitRow
              key={commit.sha}
              commit={commit}
              label={props.labels[commit.sha]}
              showNotPushed={mixed}
              timestampFormat={props.timestampFormat}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function sectionTitle(
  section: ProjectChangeSection,
  context: {
    readonly everPublished: boolean;
    readonly now: number;
    readonly timestampFormat: TimestampFormat;
  },
): string {
  if (section.publishedAt !== null) {
    // The time too: two publishes on one day are two sections.
    const day = trailDayLabel(Date.parse(section.publishedAt), context.now);
    return `Published · ${day}, ${formatShortTimestamp(section.publishedAt, context.timestampFormat)}`;
  }
  if (context.everPublished) return "Since the last publish";
  if (section.period === null) return "Last 30 days";
  const from = trailDayLabel(Date.parse(section.period.startedAt), context.now);
  const to = trailDayLabel(Date.parse(section.period.endedAt), context.now);
  return from === to ? from : `${from} – ${to}`;
}

/**
 * The owner's commits as a changelog: a few changes per publish, each saying what changed.
 * A period not yet summarized lists its commits and asks the server to write its changelog.
 */
function Changelog(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  changes: ProjectChangesResult;
  periods: ReadonlyArray<ProjectChangePeriod>;
  entries: EntryLookup;
  timestampFormat: TimestampFormat;
  now: number;
}) {
  const { environmentId, projectId } = props;
  const summarize = useAtomCommand(threadEntryAtoms.summarizeProjectChanges, {
    reportFailure: false,
  });
  const canSummarize = useAtomValue(
    threadEntryAtoms.summarizeProjectChanges.permissionAtom(environmentId),
  );
  const missing = props.periods
    .filter((period) => period.items === null)
    .map((period) => period.key)
    .join("\n");
  // The set of missing periods the server has answered for; until then they read "summarizing".
  const [answered, setAnswered] = useState<string | null>(null);
  const summarizing = missing !== "" && canSummarize && answered !== missing;
  const requestSummaries = useEffectEvent(() => {
    const askedFor = missing;
    void summarize({ environmentId, input: { projectId } }).then((result) => {
      setAnswered(askedFor);
      if (result._tag === "Success" && result.value.summarized > 0) {
        refreshEntries([environmentId]);
      }
    });
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to write the changelog of periods that have none; a server with summaries off writes none, so this never repeats
  useEffect(() => {
    if (missing !== "" && canSummarize) requestSummaries();
  }, [missing, canSummarize]);

  const commits = new Map(props.changes.commits.map((commit) => [commit.sha, commit]));
  const sections = projectChangeSections({ ...props.changes, periods: props.periods });
  return (
    <>
      {sections.map((section) => {
        const { period, others } = section;
        const count = period === null ? "" : plural(period.shas.length, "commit");
        return (
          <Section
            key={section.key}
            title={sectionTitle(section, {
              everPublished: props.changes.publishes.length > 0,
              now: props.now,
              timestampFormat: props.timestampFormat,
            })}
            published={section.publishedAt !== null}
            note={period?.items === null && summarizing ? `${count} · summarizing…` : count}
          >
            <ul className="flex flex-col">
              {period === null
                ? null
                : period.items === null
                  ? period.shas.flatMap((sha) => {
                      const commit = commits.get(sha);
                      return commit === undefined
                        ? []
                        : [
                            <CommitRow
                              key={sha}
                              environmentId={environmentId}
                              commit={commit}
                              entries={props.entries}
                              timestampFormat={props.timestampFormat}
                            />,
                          ];
                    })
                  : period.items.map((item) => (
                      <ChangeItemRow
                        key={`${item.title}:${item.shas[0]}`}
                        item={item}
                        commits={commits}
                        labels={period.labels ?? {}}
                        timestampFormat={props.timestampFormat}
                      />
                    ))}
              {others === null ? null : (
                <li className="min-w-0 truncate px-2 py-1 text-xs text-secondary-label/70">
                  {plural(others.count, "commit")} by {others.authors.slice(0, 3).join(", ")}
                  {others.authors.length > 3 ? " and others" : ""}
                </li>
              )}
            </ul>
          </Section>
        );
      })}
    </>
  );
}

function ProjectChanges(props: {
  environmentId: EnvironmentId;
  projectId: ProjectId;
  changes: ProjectChangesResult;
  timestampFormat: TimestampFormat;
  now: number;
}) {
  const { changes } = props;
  if (!changes.isRepository) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        This project's folder is not a Git checkout, so there are no changes to list.
      </p>
    );
  }
  const entries: EntryLookup = new Map(changes.entries.map((entry) => [entry.id, entry]));
  // A server that predates changelogs sends no periods; its commits are listed by day.
  const periods = changes.periods;
  const days = projectChangeTimeline(changes, props.now);
  const lastPublishedAt = changes.publishes[0] ?? null;
  return (
    <div className="flex flex-col">
      <p className="px-2 text-sm text-foreground">
        {changes.branch === null ? null : (
          <>
            <span className="font-mono text-xs">{changes.branch}</span>
            <span aria-hidden> · </span>
          </>
        )}
        {plural(changes.uncommitted.files, "file")} uncommitted
        <span aria-hidden> · </span>
        {plural(changes.unpushedCommits, "commit")} not pushed
        {lastPublishedAt === null ? null : (
          <>
            <span aria-hidden> · </span>
            last published {formatFullTimestamp(lastPublishedAt, props.timestampFormat)}
          </>
        )}
      </p>
      <p className="px-2 pt-1 text-xs text-secondary-label/70">
        File and commit counts come from Git. Each file is listed under the last thread known to
        have changed it, which can be wrong when threads share a checkout.
      </p>

      {changes.uncommitted.files > 0 ? (
        <Section title="Uncommitted" note={plural(changes.uncommitted.files, "file")}>
          <TopicList
            environmentId={props.environmentId}
            topics={changes.uncommitted.topics}
            entries={entries}
          />
        </Section>
      ) : null}

      {periods !== undefined ? (
        <Changelog
          environmentId={props.environmentId}
          projectId={props.projectId}
          changes={changes}
          periods={periods}
          entries={entries}
          timestampFormat={props.timestampFormat}
          now={props.now}
        />
      ) : (
        days.map((day, index) => (
          <Section key={day.label} title={day.label} note={index === 0 ? "Commits" : ""}>
            <ul className="flex flex-col">
              {day.rows.map((row) =>
                row.kind === "commit" ? (
                  <CommitRow
                    key={row.commit.sha}
                    environmentId={props.environmentId}
                    commit={row.commit}
                    entries={entries}
                    timestampFormat={props.timestampFormat}
                  />
                ) : row.kind === "publish" ? (
                  <li
                    key={`publish:${row.at}`}
                    className="flex items-center gap-3 px-2 py-1.5 text-xs font-medium text-success-foreground"
                  >
                    <time dateTime={row.at} className="w-16 shrink-0 tabular-nums">
                      {formatShortTimestamp(row.at, props.timestampFormat)}
                    </time>
                    <span>Published</span>
                    <span aria-hidden className="h-px flex-1 bg-success/30" />
                  </li>
                ) : (
                  <li
                    key={`others:${row.sha}`}
                    className="flex gap-3 px-2 py-1 text-xs text-secondary-label/70"
                  >
                    <span aria-hidden className="w-16 shrink-0" />
                    <span className="min-w-0 truncate">
                      {plural(row.count, "commit")} by {row.authors.join(", ")}
                    </span>
                  </li>
                ),
              )}
            </ul>
          </Section>
        ))
      )}
      {days.length === 0 && changes.uncommitted.files === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          Nothing uncommitted and no commits in the last 30 days.
        </p>
      ) : null}
    </div>
  );
}

/**
 * What each project's root checkout holds that is not committed, pushed or published, by topic,
 * then a changelog of its commits for each publish.
 */
export function ProjectChangesView(props: {
  refs: ReadonlyArray<ScopedProjectRef>;
  timestampFormat: TimestampFormat;
  now: number;
}) {
  const projects = useProjectChanges(props.refs);
  return (
    <div className="flex flex-col gap-6">
      {projects.map((project) =>
        project.changes === null ? (
          <p
            key={`${project.environmentId}:${project.projectId}`}
            className="py-8 text-center text-sm text-muted-foreground"
          >
            {project.failed ? "Could not read this project's changes." : "Reading the checkout…"}
          </p>
        ) : (
          <ProjectChanges
            key={`${project.environmentId}:${project.projectId}`}
            environmentId={project.environmentId}
            projectId={project.projectId}
            changes={project.changes}
            timestampFormat={props.timestampFormat}
            now={props.now}
          />
        ),
      )}
    </div>
  );
}
