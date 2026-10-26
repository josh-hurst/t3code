import type { EnvironmentId, ThreadId, UsageLimitsReport } from "@t3tools/contracts";
import { limitsNotice } from "@t3tools/shared/usageLimits";
import { GaugeIcon } from "lucide-react";
import { Fragment } from "react";

import { orchestrationEnvironment } from "~/state/orchestration";
import { useEnvironmentQuery } from "~/state/query";

import { ensureLocalApi } from "../../localApi";
import { Button } from "../ui/button";
import { providerClients } from "../settings/providerDriverMeta";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
import { ComposerLimitDrivers } from "./ComposerLimitDrivers";
import { threadUsageRows } from "./threadUsageFormat";
import { LimitWindows, ResetCredits } from "../usage/UsageLimits";
import { ComposerBanner } from "./ComposerBanner";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

function accountLabel(account: UsageLimitsReport["accounts"][number]): string {
  if (!account.instanceId) return account.label;
  const driver = providerClients.get(account.driver)?.label ?? String(account.driver);
  const instance =
    account.displayName?.trim() ||
    (String(account.instanceId) !== String(account.driver) ? account.instanceId : "");
  return instance && instance.toLowerCase() !== driver.toLowerCase()
    ? `${driver} · ${instance}`
    : driver;
}

function AccountSummary({ account }: { readonly account: UsageLimitsReport["accounts"][number] }) {
  const label = accountLabel(account);
  return (
    <>
      {label.includes("@") ? (
        <RedactedSensitiveText
          key={label}
          value={label}
          ariaLabel="Toggle account label visibility"
          revealTooltip="Click to reveal account"
          hideTooltip="Click to hide account"
          className="max-w-full truncate align-bottom font-sans text-xs leading-normal"
        />
      ) : (
        label
      )}
      {account.plan ? ` · ${account.plan}` : null}
    </>
  );
}

export function usageLimitsBannerItem(
  id: string,
  report: UsageLimitsReport,
  environmentId: EnvironmentId,
  threadId: ThreadId | null,
  showLimitDrivers: boolean,
  onDismiss: () => void,
): ComposerBannerStackItem {
  const [first] = report.accounts;
  const single = report.accounts.length === 1 && first ? first : null;
  const summary = single ? (
    <AccountSummary account={single} />
  ) : (
    `${report.accounts.length} accounts`
  );
  return {
    id,
    variant: "info",
    priority: "notice",
    icon: <GaugeIcon />,
    title: "Usage",
    description: summary,
    dismissLabel: "Dismiss usage",
    onDismiss,
    children: (
      <UsageLimitsBannerBody
        report={report}
        environmentId={environmentId}
        threadId={threadId}
        showLimitDrivers={showLimitDrivers}
      />
    ),
  };
}

function UsageLimitsBannerBody({
  report,
  environmentId,
  threadId,
  showLimitDrivers,
}: {
  readonly report: UsageLimitsReport;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly showLimitDrivers: boolean;
}) {
  const now = Date.parse(report.createdAt);
  return (
    <ComposerBanner.Scroll>
      <ComposerBanner.Body className="flex flex-col gap-2 pt-1 pb-1.5 pe-2">
        {report.accounts.map((account) => {
          const resetCreditInput =
            account.resetCreditInput ??
            (account.instanceId ? { instanceId: account.instanceId } : undefined);
          const notice = limitsNotice(account.limits);
          const externalUsage = account.limits.externalUsage;
          return (
            <div key={account.id} className="flex min-w-0 flex-col gap-1">
              {report.accounts.length > 1 ? (
                <span className="truncate text-xs text-muted-foreground">
                  <AccountSummary account={account} />
                </span>
              ) : null}
              {notice ? (
                <span className="text-xs text-muted-foreground">{notice}</span>
              ) : (
                <LimitWindows
                  compact
                  driver={account.driver}
                  windows={account.limits.windows}
                  now={now}
                />
              )}
              {externalUsage ? (
                <Button
                  size="sm"
                  variant="link"
                  className="self-start"
                  onClick={() => void ensureLocalApi().shell.openExternal(externalUsage.url)}
                >
                  Manage usage
                </Button>
              ) : null}
              {resetCreditInput && account.limits.resetCredits ? (
                <ResetCredits
                  environmentId={environmentId}
                  input={resetCreditInput}
                  credits={account.limits.resetCredits}
                  now={now}
                />
              ) : null}
            </div>
          );
        })}
        {report.notices.map((notice) => (
          <span key={notice} className="text-xs text-muted-foreground">
            {notice}
          </span>
        ))}
        {threadId ? <ThreadUsageSection environmentId={environmentId} threadId={threadId} /> : null}
        {showLimitDrivers ? <ComposerLimitDrivers environmentId={environmentId} /> : null}
      </ComposerBanner.Body>
    </ComposerBanner.Scroll>
  );
}

function ThreadUsageSection({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const { data: usage, error } = useEnvironmentQuery(
    orchestrationEnvironment.threadUsage({ environmentId, input: { threadId } }),
  );
  if (usage === null) {
    return error ? <span className="text-xs text-muted-foreground">{error}</span> : null;
  }
  if (usage.turns === 0 && usage.costUsd === null) return null;
  return (
    <div className="flex min-w-0 flex-col gap-1 border-t border-border/60 pt-2">
      <span className="text-xs text-muted-foreground">
        This thread{usage.partial ? " · some turns are missing from these totals" : ""}
      </span>
      <div className="grid grid-cols-[auto_auto] justify-start gap-x-6 gap-y-0.5 text-xs sm:grid-cols-[auto_auto_auto_auto]">
        {threadUsageRows(usage).map(([label, value]) => (
          <Fragment key={label}>
            <span className="text-muted-foreground">{label}</span>
            <span className="text-end font-medium text-foreground tabular-nums">{value}</span>
          </Fragment>
        ))}
      </div>
    </div>
  );
}
