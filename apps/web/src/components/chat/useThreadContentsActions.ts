import { entriesUndo, type EntriesUndo } from "@t3tools/client-runtime/state/thread-entries";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  ListThreadEntriesResult,
  RunId,
  ThreadEntryId,
  ThreadId,
} from "@t3tools/contracts";

import { appAtomRegistry } from "../../rpc/atomRegistry";
import { serverEnvironment } from "../../state/server";
import { threadContents, threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { toastManager } from "../ui/toast";
import { splitTopicsBlocker } from "./threadContents.logic";

const UNDO_WITHDRAWN = "These topics changed since, so this can no longer be undone.";

/** The server writes its refusals for the user ("A topic needs a title."); show them as they are. */
function failureText(result: AtomCommandResult<unknown, unknown>): string | null {
  if (result._tag !== "Failure" || isAtomCommandInterrupted(result)) return null;
  const error = squashAtomCommandFailure(result);
  if (typeof error === "object" && error !== null && "detail" in error) {
    if (typeof error.detail === "string" && error.detail !== "") return error.detail;
  }
  return error instanceof Error ? error.message : "An error occurred.";
}

function failed(result: AtomCommandResult<unknown, unknown>, title: string): boolean {
  if (result._tag !== "Failure") return false;
  const description = failureText(result);
  if (description !== null) toastManager.add({ type: "error", title, description });
  return true;
}

/** Rename, merge and move a thread's topics, each with an Undo, and ask for a regroup. */
export function useThreadContentsActions(environmentId: EnvironmentId, threadId: ThreadId) {
  const rename = useOrchestrationCommand(threadEnvironment.renameEntry, { reportFailure: false });
  const merge = useOrchestrationCommand(threadEnvironment.mergeEntries, { reportFailure: false });
  const move = useOrchestrationCommand(threadEnvironment.moveRunToEntry, { reportFailure: false });
  const restore = useOrchestrationCommand(threadEnvironment.restoreEntries, {
    reportFailure: false,
  });
  const entriesAtom = threadContents.threadEntriesAtom(environmentId, threadId);
  const updatesAtom = threadContents.entryUpdatesAtom(environmentId, threadId);

  /**
   * Offers Undo once the edit's own event is in, and takes it back as soon as a newer change lands:
   * the server refuses a restore after any later update.
   */
  const offerUndo = (title: string, before: ListThreadEntriesResult | null, sequence: number) => {
    let undo: EntriesUndo = { kind: "waiting" };
    const subscriptions: Array<() => void> = [];
    const stop = () => {
      for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
    };
    const toastId = toastManager.add({
      type: "success",
      title,
      // Long enough to notice a mistake and reach Undo.
      timeout: 30_000,
      onRemove: stop,
    });
    const sync = () => {
      if (undo.kind === "waiting") {
        undo = entriesUndo(before, appAtomRegistry.get(updatesAtom), sequence);
        if (undo.kind === "none") return stop();
        if (undo.kind === "waiting") return;
        const ready = undo;
        toastManager.update(toastId, {
          actionProps: {
            children: "Undo",
            onClick: () => {
              stop();
              toastManager.close(toastId);
              void restore({
                environmentId,
                input: { threadId, entries: ready.entries, expectRevision: ready.expectRevision },
              }).then((result) => failed(result, "Could not undo"));
            },
          },
        });
      }
      if (undo.kind !== "ready") return;
      const shown = appAtomRegistry.get(entriesAtom);
      if (shown !== null && shown.revision > undo.expectRevision) {
        stop();
        toastManager.update(toastId, { description: UNDO_WITHDRAWN, actionProps: undefined });
      }
    };
    subscriptions.push(
      appAtomRegistry.subscribe(updatesAtom, sync),
      appAtomRegistry.subscribe(entriesAtom, sync),
    );
    sync();
  };

  /** Runs one edit; false when it was refused (the refusal is shown). */
  const edit = async (
    title: string,
    failure: string,
    run: () => Promise<AtomCommandResult<{ readonly sequence: number }, unknown>>,
  ) => {
    const before = appAtomRegistry.get(entriesAtom);
    const result = await run();
    if (failed(result, failure) || result._tag !== "Success") return false;
    offerUndo(title, before, result.value.sequence);
    return true;
  };

  return {
    renameEntry: (entryId: ThreadEntryId, title: string) =>
      edit("Renamed topic", "Could not rename the topic", () =>
        rename({ environmentId, input: { threadId, entryId, title } }),
      ),
    mergeEntries: (sourceEntryId: ThreadEntryId, targetEntryId: ThreadEntryId, into: string) =>
      edit(`Merged into ${into}`, "Could not merge the topics", () =>
        merge({ environmentId, input: { threadId, sourceEntryId, targetEntryId } }),
      ),
    moveRun: (runId: RunId, target: { readonly entryId: ThreadEntryId; readonly title: string }) =>
      edit(`Moved to ${target.title}`, "Could not move the message", () =>
        move({ environmentId, input: { threadId, runId, target: { entryId: target.entryId } } }),
      ),
    moveRunToNewTopic: (runId: RunId, newTitle: string) =>
      edit(`Moved to a new topic, ${newTitle}`, "Could not make the topic", () =>
        move({ environmentId, input: { threadId, runId, target: { newTitle } } }),
      ),
  };
}

/** "Split this thread into topics": a manual regroup, or why it would do nothing. */
export function useSplitThreadTopics() {
  const regroup = useOrchestrationCommand(threadEnvironment.regroupContents, {
    reportFailure: false,
  });
  return async (environmentId: EnvironmentId, threadId: ThreadId) => {
    const blocker = splitTopicsBlocker({
      summariesEnabled:
        appAtomRegistry.get(serverEnvironment.settingsValueAtom(environmentId))
          ?.threadReplySummariesEnabled === true,
      entries:
        appAtomRegistry.get(threadContents.threadEntriesAtom(environmentId, threadId))?.entries ??
        null,
    });
    if (blocker !== null) {
      toastManager.add({ type: "info", title: "Nothing to split", description: blocker });
      return;
    }
    const result = await regroup({ environmentId, input: { threadId } });
    if (failed(result, "Could not split the thread")) return;
    toastManager.add({
      type: "info",
      title: "Splitting into topics",
      description: "Three short model calls; Contents updates when they finish.",
    });
  };
}
