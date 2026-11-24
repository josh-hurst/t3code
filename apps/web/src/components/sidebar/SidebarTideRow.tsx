import {
  AlarmClockIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  GitBranchIcon,
  ListTodoIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  TimerIcon,
  UserRoundIcon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ProjectFavicon, type ProjectFaviconProject } from "../ProjectFavicon";
import { MiddleTruncate } from "../ui/middle-truncate";
import type { TideStatusTone } from "./tideSidebar.logic";

const STATUS_LOOK: Record<TideStatusTone, { icon: LucideIcon; className: string }> = {
  approval: { icon: ShieldQuestionIcon, className: "text-warning-foreground" },
  input: { icon: MessageCircleQuestionIcon, className: "text-indigo-600 dark:text-indigo-300" },
  question: { icon: MessageCircleQuestionIcon, className: "text-indigo-600 dark:text-indigo-300" },
  guest: { icon: UserRoundIcon, className: "text-guest-foreground" },
  working: { icon: CircleDashedIcon, className: "text-info-foreground" },
  connecting: { icon: CircleDashedIcon, className: "text-info-foreground" },
  waiting: { icon: CircleDotDashedIcon, className: "text-muted-foreground" },
  failed: { icon: CircleAlertIcon, className: "text-error-foreground" },
  limited: { icon: CircleAlertIcon, className: "text-warning-foreground" },
  plan: { icon: ListTodoIcon, className: "text-violet-600 dark:text-violet-300" },
  completed: { icon: CircleCheckIcon, className: "text-success-foreground" },
  woke: { icon: AlarmClockIcon, className: "text-warning-foreground" },
  settling: { icon: TimerIcon, className: "text-error-foreground/60" },
};

/** The status word that leads a row's last line, with its icon, in its status colour. */
export function TideStatusLabel(props: { tone: TideStatusTone; children: ReactNode }) {
  const look = STATUS_LOOK[props.tone];
  const Icon = look.icon;
  return (
    <span className={cn("font-medium whitespace-nowrap", look.className)}>
      <Icon aria-hidden className="me-1 inline size-3 align-[-0.125rem]" />
      {props.children}
    </span>
  );
}

/** A plain lead word on a row's last line: "Question", "Publish", "Set aside". */
export function TideOwedLabel(props: { children: ReactNode }) {
  return (
    <span className="font-medium whitespace-nowrap text-muted-foreground">{props.children}</span>
  );
}

/** The project's icon at text size, keeping its colour, then its name and any off-main branch. */
export function TideProject(props: {
  project: ProjectFaviconProject | null;
  name: string;
  branch?: string | null;
}) {
  const branch = props.branch ?? null;
  return (
    <span className={cn("flex min-w-0 items-center gap-1", branch !== null && "flex-1")}>
      {props.project ? (
        <span data-project-icon className="flex shrink-0">
          <ProjectFavicon project={props.project} className="size-3" />
        </span>
      ) : null}
      <span className={cn("min-w-0 truncate", branch !== null && "max-w-1/2")}>{props.name}</span>
      {branch !== null ? (
        <span className="ms-1 flex min-w-0 flex-1 items-center gap-1">
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="flex min-w-0 font-mono">
            <MiddleTruncate value={branch} showTitle={false} />
          </span>
        </span>
      ) : null}
    </span>
  );
}

/**
 * A thread row's first line: the project and its pull request, with any off-main branch at the
 * right. A plain function, so a row with none of them passes no line at all.
 */
export function tideRowMeta(props: {
  project: ProjectFaviconProject | null;
  name: string | null;
  pullRequest?: ReactNode;
  branch: string | null;
}) {
  if (props.name === null && !props.pullRequest && props.branch === null) return null;
  return (
    <>
      {props.name !== null ? (
        <span className="flex min-w-0 shrink items-center gap-1">
          {props.project ? (
            <span data-project-icon className="flex shrink-0">
              <ProjectFavicon project={props.project} className="size-3" />
            </span>
          ) : null}
          <span className="min-w-0 truncate">{props.name}</span>
        </span>
      ) : null}
      {props.pullRequest}
      {props.branch !== null ? (
        <span
          className={cn(
            "flex min-w-0 items-center gap-1",
            (props.name !== null || props.pullRequest) && "ml-auto",
          )}
        >
          <GitBranchIcon aria-hidden className="size-3 shrink-0" />
          <span className="flex min-w-0">
            <MiddleTruncate value={props.branch} showTitle={false} />
          </span>
        </span>
      ) : null}
    </>
  );
}

/**
 * One anatomy for every row in the new layout. Line 1: project left, time right. Line 2: the
 * title. Line 3: a short label, then the text. Without a project the time joins the title line,
 * so no line is left half empty. Thread rows pass `meta` instead of a project: it leads the row
 * with the time at its end.
 */
export function TideRowBody(props: {
  project: ReactNode | null;
  // The time and, on hover, the row's actions in its place.
  time: ReactNode;
  title: ReactNode;
  unreadCompletion?: boolean;
  titleTrailing?: ReactNode;
  label: ReactNode | null;
  text: string | null;
  maxLines: 2 | 3;
  meta?: ReactNode;
  footer?: ReactNode;
}) {
  const hasLast = props.label !== null || props.text !== null;
  return (
    <>
      {props.meta ? (
        <div className="flex h-4 min-w-0 items-center gap-2.5 text-xs text-foreground/60">
          <span className="flex min-w-0 flex-1 items-center gap-2.5">{props.meta}</span>
          <span className="flex shrink-0 items-center text-2xs text-secondary-label">
            {props.time}
          </span>
        </div>
      ) : null}
      {props.project !== null ? (
        <div className="flex h-3.5 min-w-0 items-center gap-2 text-2xs text-secondary-label">
          {props.project}
          {props.time}
        </div>
      ) : null}
      <div
        className={cn("flex h-5 min-w-0 items-center gap-1.5", props.project !== null && "mt-0.5")}
      >
        {props.unreadCompletion ? (
          <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-success" />
        ) : null}
        {props.title}
        {props.titleTrailing}
        {props.project === null && !props.meta ? (
          <span className="ml-auto flex shrink-0 items-center text-2xs text-secondary-label">
            {props.time}
          </span>
        ) : null}
      </div>
      {hasLast ? (
        <div
          className={cn(
            "min-w-0 wrap-break-word text-xs text-secondary-label/70",
            props.maxLines === 3 ? "line-clamp-3" : "line-clamp-2",
          )}
        >
          {props.label}
          {props.label !== null && props.text !== null ? (
            <>
              <span aria-hidden className="whitespace-nowrap">
                {" ·"}
              </span>{" "}
            </>
          ) : null}
          {props.text}
        </div>
      ) : null}
      {props.footer}
    </>
  );
}
