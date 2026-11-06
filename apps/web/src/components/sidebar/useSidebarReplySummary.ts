import { useAtomValue } from "@effect/atom-react";
import type { SidebarRowDetail } from "@t3tools/contracts/settings";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import { sidebarReplySummaryMessageId, type SidebarThreadStatus } from "../Sidebar.logic";

/** The latest reply's summary once the server has one; null means show the plain preview. */
export function useSidebarReplySummary(
  thread: SidebarThreadSummary,
  rowDetail: SidebarRowDetail,
  status: SidebarThreadStatus,
): string | null {
  const summariesEnabled = useAtomValue(
    serverEnvironment.settingsValueAtom(thread.environmentId),
    (settings) => settings?.threadReplySummariesEnabled === true,
  );
  const messageId = sidebarReplySummaryMessageId({
    rowDetail,
    summariesEnabled,
    status,
    message: thread.source.latestVisibleMessage,
  });
  const { data } = useEnvironmentQuery(
    messageId === null
      ? null
      : orchestrationEnvironment.replySummary({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, messageId },
        }),
  );
  return messageId === null ? null : (data?.summary ?? null);
}
