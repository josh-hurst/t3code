import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { threadAwaitingAsk } from "@t3tools/client-runtime/state/thread-zones";
import { threadCardOpenItemKey, type ThreadEntryOpenItem } from "@t3tools/contracts";
import { useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../components/ui/Dialog";
import { Notice } from "../../components/ui/Notice";
import { Toast } from "../../components/ui/Toast";
import { refreshEntries, threadEntryAtoms, useCanOperateEntries } from "../../state/threadEntries";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

function failed(result: AtomCommandResult<unknown, unknown>, title: string): boolean {
  if (result._tag !== "Failure") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : "An error occurred.");
  }
  return true;
}

/**
 * The question the idle thread's last reply leaves you, in its card's words. Dismissing it
 * resolves the card's ask, which takes the thread out of Needs you, and offers Undo.
 */
export function AwaitingQuestionNotice(props: {
  readonly thread: EnvironmentThreadShell;
  readonly idle: boolean;
}) {
  const { environmentId, id: threadId } = props.thread;
  const canOperate = useCanOperateEntries([environmentId]).has(environmentId);
  const resolveCommand = useAtomCommand(threadEntryAtoms.resolveOpenItem, {
    reportFailure: false,
  });
  const restoreCommand = useAtomCommand(threadEnvironment.restoreOpenItems, {
    reportFailure: false,
  });
  const [dismissed, setDismissed] = useState<{
    readonly threadId: string;
    readonly item: ThreadEntryOpenItem;
  } | null>(null);

  const question = props.idle ? threadAwaitingAsk(props.thread) : null;
  const runId = props.thread.latestRun?.runId;
  const undo = dismissed?.threadId === threadId ? dismissed.item : null;

  if (question !== null) {
    const dismiss =
      canOperate && runId !== undefined
        ? async () => {
            const item: ThreadEntryOpenItem = { kind: "ask", text: question, runId };
            const result = await resolveCommand({
              environmentId,
              input: { threadId, key: threadCardOpenItemKey(item) },
            });
            if (!failed(result, "Could not dismiss the question")) {
              setDismissed({ threadId, item });
            }
          }
        : undefined;
    return (
      <View className="px-4 pb-3">
        <Notice
          message={question}
          icon="questionmark.bubble"
          floating
          {...(dismiss === undefined
            ? {}
            : { onDismiss: () => void dismiss(), dismissLabel: "Dismiss question" })}
        />
      </View>
    );
  }
  if (undo === null) return null;
  return (
    <View className="px-4 pb-3">
      <Toast
        message="Question dismissed"
        singleLine
        action={{
          label: "Undo",
          onPress: () => {
            setDismissed(null);
            void restoreCommand({ environmentId, input: { threadId, items: [undo] } }).then(
              (restored) => {
                if (!failed(restored, "Could not restore the question")) {
                  refreshEntries([environmentId]);
                }
              },
            );
          },
        }}
        onDismiss={() => setDismissed(null)}
      />
    </View>
  );
}
