import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { MessageCircleQuestionIcon } from "lucide-react";

import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import type { SidebarThreadSummary } from "../../types";
import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

/**
 * The question the idle thread's last reply asks you, worded as its sidebar summary. The summary
 * model phrases a reply that waits on the user as a question, which tells a real ask from a
 * rhetorical one; with summaries off there is no signal, so this stays null.
 */
export function useAwaitingQuestion(
  environmentId: EnvironmentId,
  thread: SidebarThreadSummary | null,
  idle: boolean,
): string | null {
  const summariesEnabled = useAtomValue(
    serverEnvironment.settingsValueAtom(environmentId),
    (settings) => settings?.threadReplySummariesEnabled === true,
  );
  const message = thread?.source.latestVisibleMessage;
  const messageId =
    thread && summariesEnabled && idle && message?.role === "assistant" ? message.id : null;
  const { data } = useEnvironmentQuery(
    thread === null || messageId === null
      ? null
      : orchestrationEnvironment.replySummary({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, messageId },
        }),
  );
  const summary = messageId === null ? null : (data?.summary ?? null);
  return summary?.endsWith("?") ? summary : null;
}

export function awaitingQuestionBannerItem(
  question: string,
  onShow: () => void,
): ComposerBannerStackItem {
  return {
    id: "awaiting-question",
    variant: "info",
    // The color other "needs you" lines at the end of the timeline use.
    icon: <MessageCircleQuestionIcon className="text-info-foreground" />,
    title: question,
    actions: (
      <Button size="xs" variant="ghost" onClick={onShow}>
        Show
      </Button>
    ),
  };
}
