import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadAwaitingAsk } from "@t3tools/client-runtime/state/thread-zones";
import { View } from "react-native";

import { Notice } from "../../components/ui/Notice";

/** The question the idle thread's last reply leaves you, in its card's words. */
export function AwaitingQuestionNotice(props: {
  readonly thread: EnvironmentThreadShell;
  readonly idle: boolean;
}) {
  const question = props.idle ? threadAwaitingAsk(props.thread) : null;
  if (question === null) return null;
  return (
    <View className="px-4 pb-3">
      <Notice message={question} icon="questionmark.bubble" floating />
    </View>
  );
}
