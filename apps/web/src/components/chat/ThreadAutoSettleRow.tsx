import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadAutoSettleAt,
  threadAutoSettleLabel,
} from "@t3tools/client-runtime/state/thread-zones";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { TimerIcon } from "lucide-react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useThreadActions } from "../../hooks/useThreadActions";
import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentScope } from "../../state/session";
import { Switch } from "../ui/switch";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
} from "./threadDetailsPanelStyles";

/** When inactivity will settle the thread, with the switch that keeps it from settling. */
export function ThreadAutoSettleRow(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const ref = scopeThreadRef(props.environmentId, props.threadId);
  const thread = useQuietThreadShell(ref);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const nowMinute = useNowMinute();
  const { setThreadAutoSettle } = useThreadActions();
  if (thread === null) return null;
  const off = thread.autoSettleDisabledAt != null;
  const atMs = threadAutoSettleAt(thread);
  // Off stays listed while the thread is active, so the switch that turned it off can undo it.
  if (atMs === null && !(off && thread.settledOverride === null && thread.archivedAt === null)) {
    return null;
  }
  const setEnabled = async (enabled: boolean) => {
    const result = await setThreadAutoSettle(ref, enabled);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to update auto-settle",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    }
  };

  return (
    <ThreadDetailsSection headingId="thread-details-auto-settle-heading" title="Auto-settle">
      <div
        className={cn(
          "flex items-center rounded-lg py-1.5",
          THREAD_DETAILS_PANEL_ROW_CONTENT_CLASS,
        )}
      >
        <TimerIcon className={THREAD_DETAILS_PANEL_ICON_CLASS} />
        <div className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground/80">
            {atMs === null
              ? "Off for this thread"
              : threadAutoSettleLabel(atMs, { now: `${nowMinute}:00.000Z` })}
          </span>
          <p className="truncate text-2xs text-muted-foreground">
            {atMs === null ? "It stays until you settle it" : "Unless you write in it first"}
          </p>
        </div>
        <Switch
          checked={!off}
          disabled={!canOperate}
          aria-label="Auto-settle this thread"
          onCheckedChange={(enabled) => void setEnabled(enabled)}
        />
      </div>
    </ThreadDetailsSection>
  );
}
