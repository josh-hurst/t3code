import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { projectChangeTimeline } from "@t3tools/client-runtime/state/thread-entries";
import type {
  EnvironmentId,
  ProjectChangeCommit,
  ProjectChangeEntry,
  ProjectChangesResult,
  ProjectChangeTopic,
  ScopedProjectRef,
  ThreadEntryId,
} from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { useProjectChanges } from "../../state/threadEntries";
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

function Section(props: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section aria-label={props.title}>
      <div className="mt-3 mb-0.5 flex items-baseline justify-between gap-3 px-2 text-2xs text-muted-foreground">
        <h2 className="font-medium tracking-wide uppercase">{props.title}</h2>
        <span>{props.note}</span>
      </div>
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

function ProjectChanges(props: {
  environmentId: EnvironmentId;
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
  const days = projectChangeTimeline(changes, props.now);
  const published = changes.sincePublish;
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
        {published === null ? null : (
          <>
            <span aria-hidden> · </span>
            last published {formatFullTimestamp(published.publishedAt, props.timestampFormat)}
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

      {published !== null && published.topics.length > 0 ? (
        <Section title="Changed since the last publish" note="Committed or not">
          <TopicList
            environmentId={props.environmentId}
            topics={published.topics}
            entries={entries}
          />
        </Section>
      ) : null}

      {days.map((day, index) => (
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
      ))}
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
 * then its commits by day with the publishes between them.
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
            changes={project.changes}
            timestampFormat={props.timestampFormat}
            now={props.now}
          />
        ),
      )}
    </div>
  );
}
