import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { contentsVisible, entryOwedLabel } from "@t3tools/client-runtime/state/thread-entries";
import {
  AuthOrchestrationOperateScope,
  THREAD_ENTRY_TITLE_MAX,
  type EnvironmentId,
  type ThreadEntry,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { EllipsisIcon } from "lucide-react";
import { useRef, useState } from "react";

import { useClientSettings } from "../../hooks/useSettings";
import { useEnvironmentScope } from "../../state/session";
import { useThreadEntries } from "../../state/threadEntries";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatDayAwareTimestamp } from "../../timestampFormat";
import { TideOwedLabel, TideRowBody } from "../sidebar/SidebarTideRow";
import { Input } from "../ui/input";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
  MenuTrigger,
} from "../ui/menu";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import { contentsCount } from "./threadContents.logic";
import { useThreadContentsActions } from "./useThreadContentsActions";

/** The thread's topics, in the order they started; shown once there are two. */
export function ThreadContentsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const entries = useThreadEntries(props.environmentId, props.threadId)?.entries ?? null;
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const actions = useThreadContentsActions(props.environmentId, props.threadId);
  const [renaming, setRenaming] = useState<ThreadEntry["id"] | null>(null);
  // Rename starts once its menu has closed, without focus going back to the menu's button,
  // which would blur the new field before anything is typed.
  const renameAfterClose = useRef<ThreadEntry["id"] | null>(null);
  // The menu returns focus as its popup unmounts, which is after the field has mounted.
  const keepFocusInField = useRef(false);
  if (entries === null || !contentsVisible(entries)) return null;
  const params = buildThreadRouteParams(scopeThreadRef(props.environmentId, props.threadId));

  return (
    <ThreadDetailsSection
      headingId="thread-details-contents-heading"
      title="Contents"
      actions={
        <span className="text-2xs text-muted-foreground tabular-nums">
          {contentsCount(entries)}
        </span>
      }
    >
      {/* Capped so a long thread's topics scroll here instead of pushing the card to a density that hides them. */}
      <ol className="flex max-h-[min(20rem,40dvh)] flex-col overflow-y-auto">
        {entries.map((entry) => {
          const owed = entryOwedLabel(entry.open);
          const others = entries.filter((other) => other.id !== entry.id);
          return (
            <li
              key={entry.id}
              className="group relative rounded-md px-2.5 py-1.5 hover:bg-accent/50 has-[a:focus-visible]:bg-accent/50"
            >
              <TideRowBody
                // The sidebar's row anatomy: when it started, quiet, above a title that has its whole line.
                project={
                  <time dateTime={entry.startedAt} className="min-w-0 flex-1 truncate tabular-nums">
                    Started {formatDayAwareTimestamp(entry.startedAt, timestampFormat)}
                  </time>
                }
                title={
                  renaming === entry.id ? (
                    <RenameField
                      title={entry.title}
                      onDone={(title) => {
                        keepFocusInField.current = false;
                        setRenaming(null);
                        if (title !== null) void actions.renameEntry(entry.id, title);
                      }}
                    />
                  ) : (
                    <Link
                      to="/$environmentId/$threadId"
                      params={params}
                      search={{ m: entry.startMessageId }}
                      className="min-w-0 truncate text-sm font-medium text-foreground outline-none after:absolute after:inset-0 after:rounded-md focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring"
                    >
                      {entry.title}
                    </Link>
                  )
                }
                time={
                  // The row's actions, on hover or focus, at the end of the time line.
                  <>
                    {hasActions(entry, canOperate) ? (
                      <span className="ml-auto hidden shrink-0 items-center gap-1 group-focus-within:flex group-hover:flex has-[[data-popup-open]]:flex pointer-coarse:flex">
                        {entry.endMessageId !== entry.startMessageId ? (
                          <Link
                            to="/$environmentId/$threadId"
                            params={params}
                            search={{ m: entry.endMessageId }}
                            className="relative shrink-0 text-xs text-secondary-label underline-offset-2 hover:text-foreground hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                          >
                            Latest result
                          </Link>
                        ) : null}
                        {canOperate ? (
                          <Menu
                            onOpenChangeComplete={(open) => {
                              if (open || renameAfterClose.current !== entry.id) return;
                              renameAfterClose.current = null;
                              setRenaming(entry.id);
                            }}
                          >
                            <MenuTrigger
                              render={
                                <ThreadDetailsControl
                                  size="icon-xs"
                                  variant="ghost"
                                  part="icon"
                                  aria-label={`Edit topic: ${entry.title}`}
                                  className="relative"
                                />
                              }
                            >
                              <EllipsisIcon className="size-3.5" />
                            </MenuTrigger>
                            <MenuPopup align="end" finalFocus={() => !keepFocusInField.current}>
                              <MenuItem
                                onClick={() => {
                                  renameAfterClose.current = entry.id;
                                  keepFocusInField.current = true;
                                }}
                              >
                                Rename
                              </MenuItem>
                              <MenuSub>
                                <MenuSubTrigger>Merge into</MenuSubTrigger>
                                <MenuSubPopup>
                                  <MenuGroup>
                                    <MenuGroupLabel>Its messages join this topic</MenuGroupLabel>
                                    {others.map((target) => (
                                      <MenuItem
                                        key={target.id}
                                        onClick={() =>
                                          void actions.mergeEntries(
                                            entry.id,
                                            target.id,
                                            target.title,
                                          )
                                        }
                                      >
                                        <span className="min-w-0 truncate">{target.title}</span>
                                      </MenuItem>
                                    ))}
                                  </MenuGroup>
                                </MenuSubPopup>
                              </MenuSub>
                            </MenuPopup>
                          </Menu>
                        ) : null}
                      </span>
                    ) : null}
                  </>
                }
                label={owed === null ? null : <TideOwedLabel>{owed}</TideOwedLabel>}
                text={entry.outcome === "" ? null : entry.outcome}
                maxLines={2}
              />
            </li>
          );
        })}
      </ol>
    </ThreadDetailsSection>
  );
}

const hasActions = (
  entry: Pick<ThreadEntry, "startMessageId" | "endMessageId">,
  canOperate: boolean,
) => canOperate || entry.endMessageId !== entry.startMessageId;

/** An inline title field: Enter or leaving it saves, Escape cancels; null means no change. */
function RenameField(props: { title: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(props.title);
  // Enter unmounts the field, and the blur that follows must not save a second time.
  const done = useRef(false);
  const finish = (save: boolean) => {
    if (done.current) return;
    done.current = true;
    const title = value.trim();
    props.onDone(save && title !== "" && title !== props.title ? title : null);
  };
  return (
    <Input
      size="compact"
      autoFocus
      aria-label="Topic title"
      maxLength={THREAD_ENTRY_TITLE_MAX}
      value={value}
      onChange={(event) => setValue(event.target.value)}
      onBlur={() => finish(true)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          finish(true);
        } else if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          finish(false);
        }
      }}
    />
  );
}
