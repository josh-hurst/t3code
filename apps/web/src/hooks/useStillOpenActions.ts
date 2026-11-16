import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  type EnvironmentId,
  type ProjectId,
  type PublishMarkerId,
  threadCardOpenItemKey,
  type ThreadEntryOpenItem,
  type ThreadId,
} from "@t3tools/contracts";

import { toastManager } from "../components/ui/toast";
import { refreshEntries, threadEntryAtoms } from "../state/threadEntries";
import { threadEnvironment } from "../state/threads";
import { useAtomCommand } from "../state/use-atom-command";
import { useOrchestrationCommand } from "../state/use-orchestration-command";

function failed(result: AtomCommandResult<unknown, unknown>, title: string): boolean {
  if (result._tag !== "Failure") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title,
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  }
  return true;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** Mark published (with Undo), "Done" on one open item (with Undo), and re-checking checkouts. */
export function useStillOpenActions() {
  const markPublishedCommand = useAtomCommand(threadEntryAtoms.markPublished, {
    reportFailure: false,
  });
  const undoPublishedCommand = useAtomCommand(threadEntryAtoms.undoPublished, {
    reportFailure: false,
  });
  const resolveCommand = useAtomCommand(threadEntryAtoms.resolveOpenItem, {
    reportFailure: false,
  });
  const refreshCommand = useAtomCommand(threadEntryAtoms.refreshOpenItems, {
    reportFailure: false,
  });
  const restoreCommand = useOrchestrationCommand(threadEnvironment.restoreOpenItems, {
    reportFailure: false,
  });

  /** One call per environment, so each keeps its own marker for Undo. */
  const markPublished = async (
    name: string,
    targets: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectIds: ReadonlyArray<ProjectId>;
    }>,
  ) => {
    if (targets.length === 0) {
      toastManager.add({
        type: "info",
        title: `Nothing to mark for ${name}`,
        description: "None of its projects is on a connected server that keeps topics.",
      });
      return;
    }
    const markers: Array<{ environmentId: EnvironmentId; markerId: PublishMarkerId }> = [];
    let cleared = 0;
    let started = 0;
    for (const { environmentId, projectIds } of targets) {
      const result = await markPublishedCommand({ environmentId, input: { projectIds } });
      if (failed(result, `Failed to mark ${name} published`)) continue;
      if (result._tag !== "Success") continue;
      markers.push({ environmentId, markerId: result.value.markerId });
      cleared += result.value.cleared;
      started += result.value.followUpsStarted;
    }
    if (markers.length === 0) return;
    const toastId = toastManager.add({
      type: "success",
      title: `Marked ${name} published`,
      // The only way back from a bulk clear, so it stays long enough to read and reach.
      timeout: 30_000,
      description: [
        `Cleared ${plural(cleared, "Publish item")}${started > 0 ? `; ${plural(started, "re-check")} will run after it` : ""}.`,
        "Undo puts the items back, except on threads whose summary changed since. Re-checks it released stay released.",
      ].join(" "),
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          void (async () => {
            let restored = 0;
            for (const { environmentId, markerId } of markers) {
              const result = await undoPublishedCommand({ environmentId, input: { markerId } });
              if (failed(result, "Failed to undo the publish")) continue;
              if (result._tag === "Success") restored += result.value.restored;
            }
            toastManager.add({
              type: "info",
              title: `Restored ${plural(restored, "item")}`,
            });
          })();
        },
      },
    });
  };

  const markDone = async (
    environmentId: EnvironmentId,
    threadId: ThreadId,
    item: ThreadEntryOpenItem,
  ) => {
    const result = await resolveCommand({
      environmentId,
      input: { threadId, key: threadCardOpenItemKey(item) },
    });
    if (failed(result, "Failed to mark the item done")) return;
    const toastId = toastManager.add({
      type: "success",
      title: "Marked done",
      description: item.text,
      actionProps: {
        children: "Undo",
        onClick: () => {
          toastManager.close(toastId);
          void restoreCommand({ environmentId, input: { threadId, items: [item] } }).then(
            (restored) => {
              if (!failed(restored, "Failed to restore the item")) {
                refreshEntries([environmentId]);
              }
            },
          );
        },
      },
    });
  };

  /** Clears Commit items whose checkout is clean now. */
  const refreshOpenItems = (
    targets: ReadonlyArray<{
      readonly environmentId: EnvironmentId;
      readonly projectIds: ReadonlyArray<ProjectId>;
    }>,
  ) => {
    for (const { environmentId, projectIds } of targets) {
      if (projectIds.length === 0) continue;
      void refreshCommand({ environmentId, input: { projectIds } });
    }
  };

  return { markPublished, markDone, refreshOpenItems };
}
