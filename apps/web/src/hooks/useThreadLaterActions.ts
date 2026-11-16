import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import * as ThreadUndo from "@t3tools/client-runtime/state/thread-undo";
import {
  isThreadSetAside,
  THREAD_FOLLOW_UP_AFTER_PUBLISH_MINUTES,
  THREAD_SET_ASIDE_UNTIL,
  threadFollowUpIsArmed,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";

import { requestLaterRecheck } from "../components/LaterRecheckDialog";
import { recheckFormDefaults, recheckReason } from "../components/LaterRecheckDialog.logic";
import {
  setPendingStandingCheckDraft,
  STANDING_CHECK_PROMPT_SUFFIX,
} from "../components/settings/standingCheckDraft";
import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readLoadedThread, readThreadShell, readThreadShells } from "../state/entities";
import { serverEnvironment } from "../state/server";
import { readEnvironmentHasEntries } from "../state/threadEntries";
import { threadEnvironment } from "../state/threads";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { showThreadUndoNotice } from "./showThreadUndoNotice";
import { useClientSettings } from "./useSettings";
import { useThreadActions } from "./useThreadActions";

function failureToast(title: string) {
  return (result: AtomCommandResult<unknown, unknown>) => {
    if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return;
    const error = squashAtomCommandFailure(result);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  };
}

/** The armed re-check with its full question, when the thread's payload is loaded. */
function readArmedFollowUp(ref: ScopedThreadRef) {
  const followUp = readLoadedThread(ref)?.thread.followUp ?? null;
  return followUp !== null && threadFollowUpIsArmed(followUp) ? followUp : null;
}

/** Set aside, re-check later and standing checks, for the row menu, thread view, palette and keys. */
export function useThreadLaterActions() {
  const { snoozeThread, unsnoozeThread } = useThreadActions();
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const navigate = useNavigate();
  const setFollowUp = useOrchestrationCommand(threadEnvironment.setFollowUp, {
    reportFailure: false,
  });
  const clearFollowUp = useOrchestrationCommand(threadEnvironment.clearFollowUp, {
    reportFailure: false,
  });
  const setStandingCheck = useOrchestrationCommand(threadEnvironment.setStandingCheck, {
    reportFailure: false,
  });

  const setAside = (ref: ScopedThreadRef) =>
    snoozeThread(ref, THREAD_SET_ASIDE_UNTIL).then(failureToast("Failed to set thread aside"));

  /** Sets the thread aside, or brings back one already set aside. */
  const toggleSetAside = (ref: ScopedThreadRef) => {
    const shell = readThreadShell(ref);
    if (shell === null) return;
    const now = new Date().toISOString();
    if (isThreadSetAside(shell.snoozedUntil) && effectiveSnoozed(shell, { now })) {
      void unsnoozeThread(ref).then(failureToast("Failed to bring the thread back"));
      return;
    }
    void setAside(ref);
  };

  const recheckLater = async (ref: ScopedThreadRef) => {
    const shell = readThreadShell(ref);
    if (shell === null) return;
    // Without the loaded thread only the shell's summary is known; its reason stands in for
    // the question, so editing never starts from a blank form.
    const summary =
      shell.followUp != null && shell.followUp.sentAt === undefined ? shell.followUp : null;
    const armed =
      readArmedFollowUp(ref) ??
      (summary === null ? null : { question: summary.reason, dueAt: summary.dueAt });
    const defaults = recheckFormDefaults({
      armed,
      card: shell.card,
      nowMs: Date.now(),
    });
    const choice = await requestLaterRecheck({
      environmentId: ref.environmentId,
      timestampFormat,
      question: defaults.question,
      dueAt: defaults.dueAt,
      afterPublishAvailable: readEnvironmentHasEntries(ref.environmentId),
      afterPublish: defaults.afterPublish,
      editing: armed !== null,
    });
    if (choice === null) return;
    await setFollowUp({
      environmentId: ref.environmentId,
      input: {
        threadId: ref.threadId,
        question: choice.question,
        reason: recheckReason(choice.question),
        ...(choice.dueAt === null
          ? { afterPublishMinutes: THREAD_FOLLOW_UP_AFTER_PUBLISH_MINUTES }
          : { dueAt: choice.dueAt }),
        armedBy: "user",
      },
    }).then(failureToast("Failed to schedule the re-check"));
  };

  const cancelRecheck = async (ref: ScopedThreadRef) => {
    const previous = readArmedFollowUp(ref);
    const claim = ThreadUndo.begin("follow-up", scopedThreadKey(ref));
    const result = await clearFollowUp({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId },
    });
    // Undo re-arms it as the user's own; it needs the question, which only a loaded thread has.
    // One waiting for a publish has no time to pass.
    const restorable =
      result._tag === "Success" &&
      previous !== null &&
      (previous.dueAt === null || Date.parse(previous.dueAt) > Date.now());
    if (!restorable || previous === null) {
      claim.finish();
      failureToast("Failed to cancel the re-check")(result);
      return;
    }
    const when =
      previous.dueAt === null
        ? {
            afterPublishMinutes:
              previous.afterPublishMinutes ?? THREAD_FOLLOW_UP_AFTER_PUBLISH_MINUTES,
          }
        : { dueAt: previous.dueAt };
    showThreadUndoNotice({
      action: "Cancelled the re-check of",
      claim,
      undo: () =>
        setFollowUp({
          environmentId: ref.environmentId,
          input: {
            threadId: ref.threadId,
            question: previous.question,
            reason: previous.reason,
            ...when,
            armedBy: "user",
          },
        }),
      failureTitle: "Failed to restore the re-check",
    });
  };

  const makeStandingCheck = (ref: ScopedThreadRef) => {
    const shell = readThreadShell(ref);
    if (shell === null) return;
    const other = readThreadShells().find(
      (thread) =>
        thread.environmentId === ref.environmentId &&
        thread.projectId === shell.projectId &&
        thread.id !== shell.id &&
        thread.standingCheck === true &&
        thread.deletedAt === null,
    );
    if (other !== undefined) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "This project already has a standing check",
          description: `Stop the one in "${other.title}" first.`,
        }),
      );
      return;
    }
    const firstMessage = readLoadedThread(ref)
      ?.messages.find((message) => message.role === "user")
      ?.text.trim();
    const summariesOff =
      appAtomRegistry.get(serverEnvironment.settingsValueAtom(ref.environmentId))
        ?.threadReplySummariesEnabled !== true;
    setPendingStandingCheckDraft({
      environmentId: ref.environmentId,
      projectId: shell.projectId,
      threadId: shell.id,
      title: `Standing check: ${shell.title}`,
      prompt: `${firstMessage || shell.title}\n\n${STANDING_CHECK_PROMPT_SUFFIX}`,
      notice: summariesOff
        ? "Thread summaries are off, so a run comes back to you only for a failure or an approval. Turn on Summarize latest reply in Settings, Threads, to also catch a question in a reply."
        : null,
    });
    void navigate({
      to: "/settings/scheduled-tasks",
      search: { environmentId: ref.environmentId },
    });
  };

  const stopStandingCheck = (ref: ScopedThreadRef) =>
    setStandingCheck({
      environmentId: ref.environmentId,
      input: { threadId: ref.threadId, enabled: false },
    }).then(failureToast("Failed to stop the standing check"));

  return {
    setAside,
    toggleSetAside,
    recheckLater,
    cancelRecheck,
    makeStandingCheck,
    stopStandingCheck,
  };
}
