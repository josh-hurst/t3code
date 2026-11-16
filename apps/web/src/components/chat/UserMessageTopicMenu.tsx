import { entryByRunId } from "@t3tools/client-runtime/state/thread-entries";
import {
  AuthOrchestrationOperateScope,
  THREAD_ENTRY_TITLE_MAX,
  type ListThreadEntriesResult,
  type RunId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { ListTreeIcon } from "lucide-react";
import { useId, useState } from "react";

import { useEnvironmentScope } from "../../state/session";
import { useThreadEntries } from "../../state/threadEntries";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import {
  Menu,
  MenuCheckboxItem,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadContentsActions } from "./useThreadContentsActions";

const hasTopics = (entries: ListThreadEntriesResult | null) => (entries?.entries.length ?? 0) > 0;

/**
 * "Topic" on one of your messages: move its run to another topic or to a new one. Offered while
 * the thread has any topic, so a thread that is still one topic can be split by hand.
 */
export function UserMessageTopicMenu(props: { thread: ScopedThreadRef; runId: RunId }) {
  // A boolean, so a topic update re-renders only rows whose answer flips.
  const offered = useThreadEntries(props.thread.environmentId, props.thread.threadId, hasTopics);
  const canOperate = useEnvironmentScope(props.thread.environmentId, AuthOrchestrationOperateScope);
  const [naming, setNaming] = useState(false);
  if (!offered || !canOperate) return null;
  return (
    <>
      <Menu>
        <Tooltip>
          <TooltipTrigger
            render={
              <MenuTrigger
                render={<Button type="button" size="xs" variant="ghost" aria-label="Topic" />}
              />
            }
          >
            <ListTreeIcon className="size-3" />
          </TooltipTrigger>
          <TooltipPopup side="top">Topic</TooltipPopup>
        </Tooltip>
        <MenuPopup align="end">
          <TopicMenuItems {...props} onNewTopic={() => setNaming(true)} />
        </MenuPopup>
      </Menu>
      {naming ? <NewTopicDialog {...props} onClose={() => setNaming(false)} /> : null}
    </>
  );
}

/** Mounted only while the menu is open, so closed rows never read the run's topic. */
function TopicMenuItems(props: { thread: ScopedThreadRef; runId: RunId; onNewTopic: () => void }) {
  const entries = useThreadEntries(props.thread.environmentId, props.thread.threadId)?.entries;
  const actions = useThreadContentsActions(props.thread.environmentId, props.thread.threadId);
  if (entries === undefined) return null;
  const current = entryByRunId(entries).get(props.runId) ?? null;
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>
          {current === null ? "Not in a topic yet" : "Move this message to"}
        </MenuGroupLabel>
        {entries.map((entry) => (
          <MenuCheckboxItem
            key={entry.id}
            checked={entry.id === current?.id}
            disabled={current === null}
            onClick={() => {
              if (entry.id === current?.id) return;
              void actions.moveRun(props.runId, { entryId: entry.id, title: entry.title });
            }}
          >
            <span className="min-w-0 truncate">{entry.title}</span>
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem disabled={current === null} onClick={props.onNewTopic}>
        New topic…
      </MenuItem>
    </>
  );
}

function NewTopicDialog(props: { thread: ScopedThreadRef; runId: RunId; onClose: () => void }) {
  const id = useId();
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const actions = useThreadContentsActions(props.thread.environmentId, props.thread.threadId);
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onClose();
      }}
    >
      <DialogPopup className="sm:max-w-sm">
        <form
          className="flex min-h-0 flex-col"
          onSubmit={(event) => {
            event.preventDefault();
            const trimmed = title.trim();
            if (trimmed === "") {
              setError("A topic needs a title.");
              return;
            }
            props.onClose();
            void actions.moveRunToNewTopic(props.runId, trimmed);
          }}
        >
          <DialogHeader>
            <DialogTitle>New topic</DialogTitle>
            <DialogDescription>
              This message and its reply start a topic of their own. The title you give it is kept
              when the thread is regrouped.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            <Label className="flex min-w-0 flex-col items-stretch" htmlFor={`${id}-title`}>
              Title
              <Input
                id={`${id}-title`}
                autoFocus
                maxLength={THREAD_ENTRY_TITLE_MAX}
                value={title}
                onChange={(event) => {
                  setTitle(event.target.value);
                  setError(null);
                }}
              />
            </Label>
            {error !== null ? (
              <p role="alert" className="mt-2 text-destructive text-xs">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={props.onClose}>
              Cancel
            </Button>
            <Button type="submit">Move to new topic</Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
