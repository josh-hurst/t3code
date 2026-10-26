import type {
  EnvironmentId,
  ServerProviderUsageWindow,
  ThreadId,
  UsageProviderKind,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, GaugeIcon } from "lucide-react";
import { useState } from "react";

import { useLocalStorage } from "~/hooks/useLocalStorage";
import { type ContextWindowSnapshot, formatContextWindowTokens } from "~/lib/contextWindow";
import { cn } from "~/lib/utils";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";
import { serverEnvironment } from "~/state/server";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
} from "./threadDetailsPanelStyles";
import { formatUsd, threadUsageRows } from "./threadUsageFormat";
import {
  formatLimitShare,
  limitWindowStartMs,
  providerCostUsd,
  usageDaysSince,
  weeklyLimitShare,
} from "./threadWeeklyShare";

const EXPANDED_STORAGE_KEY = "t3code.threadDetailsUsageExpanded";

const DETAIL_INSET_CLASS = "px-2.5";

function contextPercent(context: ContextWindowSnapshot | null): number | null {
  const used = context?.usedPercentage;
  return used == null ? null : Math.max(0, Math.min(100, used));
}

function DetailRow({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <div className={cn("flex h-6 items-center justify-between gap-3 text-xs", DETAIL_INSET_CLASS)}>
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium text-foreground/80 tabular-nums">{value}</span>
    </div>
  );
}

/**
 * Its own bubble under the details card, built from the card's row so it reads as a sibling.
 * `revision` changes when a turn settles, which refetches the totals; context is live.
 */
export function ThreadUsageDetails({
  environmentId,
  threadId,
  revision,
  context,
  weeklyWindow,
  usageProvider,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly revision: string;
  readonly context: ContextWindowSnapshot | null;
  readonly weeklyWindow: ServerProviderUsageWindow | null;
  readonly usageProvider: UsageProviderKind | null;
}) {
  const [expanded, setExpanded] = useLocalStorage(EXPANDED_STORAGE_KEY, true, Schema.Boolean);
  const { data: usage } = useEnvironmentQuery(
    orchestrationEnvironment.threadUsage({ environmentId, input: { threadId, revision } }),
  );
  const percent = contextPercent(context);
  const summary = [
    percent === null ? null : `${Math.round(percent)}%`,
    usage?.costUsd == null ? null : formatUsd(usage.costUsd),
  ]
    .filter((part) => part !== null)
    .join(" · ");
  const hasTotals = usage !== null && (usage.turns > 0 || usage.costUsd !== null);

  return (
    <section aria-label="Usage" className="p-2">
      <ThreadDetailsControl
        size="xs"
        variant="ghost"
        part="row"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
      >
        <GaugeIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} aria-hidden />
        <span className={THREAD_DETAILS_PANEL_LABEL_CLASS}>Usage</span>
        {summary ? (
          <span className="ms-auto text-xs font-normal text-muted-foreground tabular-nums">
            {summary}
          </span>
        ) : null}
        <ChevronDownIcon
          aria-hidden
          className={cn(
            THREAD_DETAILS_PANEL_CHEVRON_CLASS,
            !summary && "ms-auto",
            !expanded && "-rotate-90",
          )}
        />
      </ThreadDetailsControl>
      {expanded ? (
        <div className="flex flex-col pt-1 pb-0.5">
          <DetailRow
            label="Context"
            value={
              context === null
                ? "Not reported yet"
                : context.maxTokens == null
                  ? formatContextWindowTokens(context.usedTokens)
                  : `${formatContextWindowTokens(context.usedTokens)} / ${formatContextWindowTokens(context.maxTokens)}`
            }
          />
          {percent === null ? null : (
            <div className={cn("pt-0.5 pb-1.5", DETAIL_INSET_CLASS)}>
              <div
                className="h-1 w-full overflow-hidden rounded-full bg-muted"
                role="progressbar"
                aria-label="Context window used"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(percent)}
              >
                <div
                  className={cn("h-full", percent > 90 ? "bg-destructive" : "bg-foreground/40")}
                  style={{ width: `${percent}%` }}
                />
              </div>
            </div>
          )}
          {hasTotals
            ? threadUsageRows(usage).map(([label, value]) => (
                <DetailRow key={label} label={label} value={value} />
              ))
            : null}
          {weeklyWindow !== null && usageProvider !== null ? (
            <WeeklyShareRow
              environmentId={environmentId}
              threadId={threadId}
              revision={revision}
              window={weeklyWindow}
              provider={usageProvider}
            />
          ) : null}
          {usage?.partial ? (
            <p className={cn("pt-1 text-2xs text-muted-foreground", DETAIL_INSET_CLASS)}>
              Some turns are missing from these totals.
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

// Reads the provider's whole history for the window, so it mounts only while the bubble is open.
function WeeklyShareRow({
  environmentId,
  threadId,
  revision,
  window,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly revision: string;
  readonly window: ServerProviderUsageWindow;
  readonly provider: UsageProviderKind;
}) {
  const startMs = limitWindowStartMs(window);
  const [now] = useState(() => new Date());
  const since = startMs === null ? null : new Date(startMs).toISOString();
  const { data: threadUsage } = useEnvironmentQuery(
    since === null
      ? null
      : orchestrationEnvironment.threadUsage({
          environmentId,
          input: { threadId, revision, since },
        }),
  );
  const { data: summary } = useEnvironmentQuery(
    startMs === null
      ? null
      : serverEnvironment.usageSummary({ environmentId, input: usageDaysSince(startMs, now) }),
  );
  const share =
    threadUsage?.costUsd == null || summary === null
      ? null
      : weeklyLimitShare({
          usedPercent: window.usedPercent,
          threadCostUsd: threadUsage.costUsd,
          totalCostUsd: providerCostUsd(summary, provider),
        });
  if (share === null) return null;
  return <DetailRow label="Weekly limit" value={formatLimitShare(share)} />;
}
