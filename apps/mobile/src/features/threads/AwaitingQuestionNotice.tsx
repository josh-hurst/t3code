import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";
import { orchestrationEnvironment } from "../../state/orchestration";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";

/**
 * The question the idle thread's last reply asks you, worded as its reply summary. The summary
 * model phrases a reply that waits on the user as a question, which tells a real ask from a
 * rhetorical one; with summaries off there is no signal, so nothing shows.
 */
export function AwaitingQuestionNotice(props: {
  readonly thread: EnvironmentThreadShell;
  readonly idle: boolean;
}) {
  const summariesEnabled = useAtomValue(
    serverEnvironment.settingsValueAtom(props.thread.environmentId),
    (settings) => settings?.threadReplySummariesEnabled === true,
  );
  const message = props.thread.source.latestVisibleMessage;
  const messageId =
    summariesEnabled && props.idle && message?.role === "assistant" ? message.id : null;
  const { data } = useEnvironmentQuery(
    messageId === null
      ? null
      : orchestrationEnvironment.replySummary({
          environmentId: props.thread.environmentId,
          input: { threadId: props.thread.id, messageId },
        }),
  );
  const summary = messageId === null ? null : (data?.summary ?? null);
  if (!summary?.endsWith("?")) return null;
  return (
    <View className="px-4 pb-3">
      <Notice message={summary} icon="questionmark.bubble" floating />
    </View>
  );
}
