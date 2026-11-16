import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  AuthOrchestrationOperateScope,
  threadFollowUpIsArmed,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { AlarmClockIcon, CalendarSyncIcon, PencilIcon, XIcon } from "lucide-react";

import { useClientSettings } from "../../hooks/useSettings";
import { useThreadLaterActions } from "../../hooks/useThreadLaterActions";
import { cn } from "../../lib/utils";
import { useQuietThreadProjection } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { formatShortTimestamp } from "../../timestampFormat";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

const DAY_FORMATTER = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  day: "numeric",
  month: "short",
});

/** What the thread waits for in Later: its re-check, with the full question, or its standing check. */
export function ThreadLaterRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useQuietThreadProjection(ref)?.projection.thread ?? null;
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const later = useThreadLaterActions();
  const followUp =
    thread?.followUp != null && threadFollowUpIsArmed(thread.followUp) ? thread.followUp : null;
  const standingCheck = thread?.standingCheck === true;
  if (followUp === null && !standingCheck) return null;
  const when =
    followUp?.dueAt == null
      ? "after the next publish"
      : `${DAY_FORMATTER.format(new Date(followUp.dueAt))}, ${formatShortTimestamp(followUp.dueAt, timestampFormat)}`;

  return (
    <ThreadDetailsSection headingId="thread-details-later-heading" title="Later">
      {followUp !== null ? (
        <div
          className={cn(
            "flex items-start rounded-lg py-1.5",
            THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
          )}
        >
          <AlarmClockIcon className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, "mt-0.5")} />
          <div className="min-w-0 flex-1">
            <span className="block text-sm font-medium text-foreground/80">Re-check {when}</span>
            <p className="line-clamp-3 text-2xs wrap-break-word text-muted-foreground">
              {followUp.question}
            </p>
          </div>
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="Edit re-check"
                  disabled={!canOperate}
                  onClick={() => void later.recheckLater(ref)}
                >
                  <PencilIcon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Edit re-check</TooltipPopup>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <ThreadDetailsControl
                  size="icon-xs"
                  variant="ghost"
                  part="icon"
                  aria-label="Cancel re-check"
                  disabled={!canOperate}
                  onClick={() => void later.cancelRecheck(ref)}
                >
                  <XIcon className="size-3.5" />
                </ThreadDetailsControl>
              }
            />
            <TooltipPopup>Cancel re-check</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
      {standingCheck ? (
        <div
          className={cn(
            "flex items-center rounded-lg py-1.5",
            THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
          )}
        >
          <CalendarSyncIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <div className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium text-foreground/80">
              Standing check
            </span>
            <p className="truncate text-2xs text-muted-foreground">
              Its scheduled runs wait in Later unless one needs you
            </p>
          </div>
          <Switch
            checked
            disabled={!canOperate}
            aria-label="Stop standing check"
            onCheckedChange={(enabled) => {
              if (!enabled) void later.stopStandingCheck(ref);
            }}
          />
        </div>
      ) : null}
    </ThreadDetailsSection>
  );
}
