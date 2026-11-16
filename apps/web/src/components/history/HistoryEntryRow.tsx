import { entryOwedLabel, type EntryRow } from "@t3tools/client-runtime/state/thread-entries";
import { threadCardOpenItemLabel } from "@t3tools/client-runtime/state/thread-zones";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { ThreadEntryOpenItem } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";

import { buildThreadRouteParams } from "../../threadRoutes";
import type { ProjectFaviconProject } from "../ProjectFavicon";
import { TideOwedLabel, TideProject, TideRowBody } from "../sidebar/SidebarTideRow";
import { InlineButton } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * One topic, in the sidebar's row anatomy: project and time, the topic, then what it owes and
 * its outcome. The title links to where the topic started; "Latest result" to its last reply.
 */
export function HistoryEntryRow(props: {
  row: EntryRow;
  project: { readonly icon: ProjectFaviconProject | null; readonly name: string } | null;
  time: string;
  timeTitle: string;
  showOpenItems: boolean;
  onDone: ((item: ThreadEntryOpenItem) => void) | null;
}) {
  const { row } = props;
  const params = buildThreadRouteParams(scopeThreadRef(row.environmentId, row.threadId));
  const owed = entryOwedLabel(row.open);
  return (
    <li className="group relative rounded-md px-2 py-2 hover:bg-accent/50 has-[a:focus-visible]:bg-accent/50">
      <TideRowBody
        project={
          <span className="flex min-w-0 flex-1 items-center gap-1">
            {props.project ? (
              <>
                <TideProject project={props.project.icon} name={props.project.name} />
                <span aria-hidden>·</span>
              </>
            ) : null}
            <span className="min-w-0 truncate">{row.threadTitle}</span>
          </span>
        }
        time={
          <Tooltip>
            <TooltipTrigger
              render={
                <time dateTime={row.endedAt} className="relative ml-auto shrink-0 tabular-nums" />
              }
            >
              {props.time}
            </TooltipTrigger>
            <TooltipPopup side="top">{props.timeTitle}</TooltipPopup>
          </Tooltip>
        }
        title={
          <Link
            to="/$environmentId/$threadId"
            params={params}
            search={{ m: row.startMessageId }}
            className="min-w-0 truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
          >
            {row.title}
          </Link>
        }
        titleTrailing={
          row.endMessageId !== row.startMessageId ? (
            // Shown on hover or focus without changing the row's height.
            <Link
              to="/$environmentId/$threadId"
              params={params}
              search={{ m: row.endMessageId }}
              className="relative ml-auto shrink-0 text-xs text-secondary-label underline-offset-2 opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground hover:underline focus-visible:opacity-100 focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:opacity-100"
            >
              Latest result
            </Link>
          ) : null
        }
        // With the items listed underneath, each already carries its own label.
        label={
          owed === null || (props.showOpenItems && row.open.length > 0) ? null : (
            <TideOwedLabel>{owed}</TideOwedLabel>
          )
        }
        text={row.outcome === "" ? null : row.outcome}
        maxLines={2}
        footer={
          <>
            {props.showOpenItems && row.open.length > 0 ? (
              <ul className="relative mt-1 flex flex-col gap-0.5 border-l border-border pl-2 text-xs">
                {row.open.map((item) => (
                  <li
                    key={`${item.kind}:${item.text}`}
                    className="flex min-w-0 items-baseline gap-2"
                  >
                    <TideOwedLabel>{threadCardOpenItemLabel(item.kind)}</TideOwedLabel>
                    <span className="min-w-0 text-secondary-label">{item.text}</span>
                    {props.onDone ? (
                      <InlineButton tone="muted" onClick={() => props.onDone?.(item)}>
                        Done
                      </InlineButton>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        }
      />
    </li>
  );
}
