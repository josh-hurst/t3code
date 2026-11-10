import type {
  EnvironmentId,
  OrchestrationV2ThreadUsage,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  ThreadId,
  UsageLimitSourceSnapshots,
  UsageProviderKind,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  formatDuration,
  type LimitPace,
  limitsNotice,
  paceOf,
  remainingPercent,
} from "@t3tools/shared/usageLimits";
import { type ReactNode, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useNowMinute } from "../../hooks/useNowMinute";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "../../lib/contextWindow";
import { cn } from "../../lib/utils";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { formatContextWindowCompactionMessage } from "./compaction.logic";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { threadSpendRows, threadTokenRows } from "./threadUsageFormat";
import {
  formatLimitShare,
  limitWindowStartMs,
  providerCostUsd,
  usageDaysSince,
  usageProviderForDriver,
  weeklyLimitShare,
  weeklyLimitWindow,
} from "./threadWeeklyShare";

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

export interface ThreadDetailsUsageInput {
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly providers: readonly ServerProvider[];
  readonly sources: UsageLimitSourceSnapshots;
  readonly contextWindow: ContextWindowSnapshot | null;
  /** Changes when a turn starts or settles, so thread totals refetch. */
  readonly revision: string;
}

type UsageTone = "error" | "warning" | null;

/** The selected provider's limit windows. Each row reads as room left. */
export function ThreadDetailsUsage({
  providerInstanceId,
  providers,
  sources,
}: Omit<ThreadDetailsUsageInput, "contextWindow">) {
  const nowMinute = useNowMinute();
  const now = Date.parse(`${nowMinute}:00Z`);
  const limits = instanceUsageLimits(providerInstanceId, providers, sources, now);
  if (!limits) return null;
  const notice = limitsNotice(limits);

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage limits"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        {notice ? (
          <UsageRow
            label="Limits"
            fill={null}
            tone={null}
            value="Unavailable"
            tooltip={<span className="text-foreground">{notice}</span>}
          />
        ) : (
          limits.windows.map((window) => <LimitRow key={window.id} window={window} now={now} />)
        )}
      </div>
    </ThreadDetailsSection>
  );
}

function instanceUsageLimits(
  providerInstanceId: ProviderInstanceId | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ServerProviderUsageLimits | undefined {
  if (providerInstanceId === null) return undefined;
  const report = collectProviderUsageLimits(providerInstanceId, providers, sources, now);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so fall back to the instance's own snapshot.
  return (
    report?.accounts.find((entry) => entry.instanceId === providerInstanceId)?.limits ??
    providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits
  );
}

/** Cost and tokens over every turn of the thread, from the server's full history. */
export function ThreadDetailsThreadUsage({
  environmentId,
  threadId,
  providerInstanceId,
  providers,
  sources,
  revision,
}: Omit<ThreadDetailsUsageInput, "contextWindow"> & {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const nowMinute = useNowMinute();
  const { data: usage } = useEnvironmentQuery(
    orchestrationEnvironment.threadUsage({ environmentId, input: { threadId, revision } }),
  );
  if (usage === null || (usage.turns === 0 && usage.costUsd === null)) return null;
  const weeklyWindow = weeklyLimitWindow(
    instanceUsageLimits(providerInstanceId, providers, sources, Date.parse(`${nowMinute}:00Z`))
      ?.windows,
  );
  const usageProvider = usageProviderForDriver(
    providers.find((provider) => provider.instanceId === providerInstanceId)?.driver ?? null,
  );
  return (
    <ThreadDetailsSection
      headingId="thread-details-thread-usage-heading"
      title="Thread cost and tokens"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageGroupLabel>Spend</UsageGroupLabel>
        <TotalsRows rows={threadSpendRows(usage)} usage={usage} />
        {weeklyWindow !== null && usageProvider !== null ? (
          <WeeklyShareRow
            environmentId={environmentId}
            threadId={threadId}
            revision={revision}
            window={weeklyWindow}
            provider={usageProvider}
          />
        ) : null}
        <UsageGroupLabel>Tokens</UsageGroupLabel>
        <TotalsRows rows={threadTokenRows(usage)} usage={usage} />
      </div>
    </ThreadDetailsSection>
  );
}

function UsageGroupLabel({ children }: { readonly children: ReactNode }) {
  return (
    <span className="col-span-3 px-2.5 pt-1.5 pb-0.5 text-2xs font-medium text-muted-foreground/70 select-none">
      {children}
    </span>
  );
}

function TotalsRows({
  rows,
  usage,
}: {
  readonly rows: ReadonlyArray<readonly [label: string, value: string]>;
  readonly usage: OrchestrationV2ThreadUsage;
}) {
  return rows.map(([label, value]) => (
    <UsageRow
      key={label}
      label={label}
      fill={null}
      tone={null}
      value={value}
      tooltip={
        <>
          <span className="text-foreground">
            {label}: {value}
          </span>
          <span className="text-muted-foreground">
            {usage.turns} {usage.turns === 1 ? "turn" : "turns"} in this thread
            {usage.partial ? "; some are missing from these totals" : ""}
          </span>
        </>
      }
    />
  ));
}

// Reads the provider's whole history for the window, so it mounts only with the item shown.
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
  const { data: threadUsage } = useEnvironmentQuery(
    startMs === null
      ? null
      : orchestrationEnvironment.threadUsage({
          environmentId,
          input: { threadId, revision, since: new Date(startMs).toISOString() },
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
  return (
    <UsageRow
      label={window.label}
      fill={Math.min(100, share)}
      tone={null}
      muted
      value={formatLimitShare(share)}
      ariaValue={`about ${Math.round(share)}% of the limit`}
      tooltip={
        <>
          <span className="text-foreground">
            This thread used {formatLimitShare(share)} of the {window.usedPercent}% used
          </span>
          <span className="text-muted-foreground">
            Its share of this machine's estimated spend since the window began
          </span>
        </>
      }
    />
  );
}

/** The thread's context window. The bar fills as context is used; the tick marks auto-compaction. */
export function ThreadDetailsContext({ usage }: { readonly usage: ContextWindowSnapshot }) {
  const maxTokens = usage.maxTokens != null && usage.maxTokens > 0 ? usage.maxTokens : null;
  const used =
    maxTokens !== null && usage.usedPercentage !== null
      ? Math.round(Math.max(0, Math.min(100, usage.usedPercentage)))
      : null;
  const threshold = usage.autoCompactThreshold ?? null;
  const tick =
    maxTokens !== null && threshold !== null && threshold > 0 && threshold < maxTokens
      ? (threshold / maxTokens) * 100
      : null;
  const usedTokens = formatContextWindowTokens(usage.usedTokens);
  return (
    <ThreadDetailsSection
      headingId="thread-details-context-heading"
      title="Context window"
      showHeading={false}
    >
      <div className="grid grid-cols-[auto_minmax(3rem,1fr)_auto] gap-x-3 text-xs">
        <UsageRow
          label="Context"
          fill={used}
          tone={used === null ? null : used >= 90 ? "error" : used >= 80 ? "warning" : null}
          tick={tick}
          muted
          value={
            maxTokens !== null
              ? `${usedTokens} / ${formatContextWindowTokens(maxTokens)}`
              : usedTokens
          }
          ariaValue={used !== null ? `${used}% used` : `${usedTokens} tokens used`}
          tooltip={
            <>
              <span className="text-foreground">
                {used !== null ? `Context: ${used}% used` : `Context: ${usedTokens} tokens used`}
              </span>
              {maxTokens !== null ? (
                <span className="text-muted-foreground">
                  {usage.usedTokens.toLocaleString("en-US")} of {maxTokens.toLocaleString("en-US")}{" "}
                  tokens
                </span>
              ) : null}
              {threshold !== null && threshold > 0 ? (
                <span className="text-muted-foreground">
                  {formatContextWindowCompactionMessage(threshold)}
                </span>
              ) : null}
            </>
          }
        />
      </div>
    </ThreadDetailsSection>
  );
}

function LimitRow({
  window,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const left = remainingPercent(window);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt ? Date.parse(window.resetsAt) : Number.NaN;
  return (
    <UsageRow
      label={window.label}
      fill={left}
      tone={left <= 10 ? "error" : left <= 20 ? "warning" : null}
      value={`${left}%`}
      ariaValue={`${left}% left`}
      tooltip={
        <>
          <span className="text-foreground">
            {window.label}: {left}% left
          </span>
          {window.resetsAt && resetsAt > now ? (
            <span className="text-muted-foreground">
              Resets in {formatDuration(resetsAt - now)} ·{" "}
              {formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)}
            </span>
          ) : null}
          {pace ? <span className="text-muted-foreground">{PACE_LABEL[pace]}</span> : null}
        </>
      }
    />
  );
}

/** One label, hairline, and value row; the whole row opens the details tooltip. */
function UsageRow({
  label,
  fill,
  tone,
  tick = null,
  value,
  ariaValue = value,
  tooltip,
  muted = false,
}: {
  readonly label: string;
  /** Bar fill from 0 to 100. Null hides the bar. */
  readonly fill: number | null;
  readonly tone: UsageTone;
  /** A marker on the bar, from 0 to 100. */
  readonly tick?: number | null;
  readonly value: string;
  readonly ariaValue?: string;
  readonly tooltip: ReactNode;
  readonly muted?: boolean;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            tabIndex={0}
            aria-label={`${label}: ${ariaValue}`}
            className="col-span-3 grid h-6 cursor-default grid-cols-subgrid items-center rounded-lg px-2.5 outline-none hover:bg-black/[0.035] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring data-popup-open:bg-black/[0.035] dark:hover:bg-white/[0.08] dark:data-popup-open:bg-white/[0.08]"
          />
        }
      >
        <span className="max-w-28 truncate text-muted-foreground">{label}</span>
        {fill !== null ? (
          <span className="relative h-[3px] rounded-full bg-muted-foreground/30 dark:bg-muted-foreground/20">
            {fill > 0 ? (
              <span
                className={cn(
                  "absolute inset-y-0 left-0 rounded-full",
                  tone === "error"
                    ? "bg-error"
                    : tone === "warning"
                      ? "bg-warning"
                      : muted
                        ? "bg-muted-foreground"
                        : "bg-foreground/80",
                )}
                style={{ width: `max(${fill}%, 6px)` }}
              />
            ) : null}
            {tick !== null ? (
              <span
                aria-hidden
                className="absolute -top-[3px] h-[9px] w-px -translate-x-1/2 bg-foreground/60"
                style={{ left: `${tick}%` }}
              />
            ) : null}
          </span>
        ) : null}
        <span
          className={cn(
            // Text-only rows span the bar column so they never widen the shared value column.
            "text-end font-medium tabular-nums",
            fill === null && "col-span-2",
            tone === "error"
              ? "text-error-foreground"
              : tone === "warning"
                ? "text-warning-foreground"
                : fill === null
                  ? "text-muted-foreground"
                  : "text-foreground/80",
          )}
        >
          {value}
        </span>
      </TooltipTrigger>
      {/* Rows sit 8px inside the card; clear its edge instead of overlapping it. */}
      <TooltipPopup side="left" sideOffset={16}>
        <div className="flex flex-col gap-0.5">{tooltip}</div>
      </TooltipPopup>
    </Tooltip>
  );
}
