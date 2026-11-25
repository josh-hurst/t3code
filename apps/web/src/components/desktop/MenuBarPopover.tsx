import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { isThreadWorking } from "@t3tools/client-runtime/state/thread-inbox";
import {
  effectiveSnoozed,
  laterWhenLabel,
  threadWokeAt,
} from "@t3tools/client-runtime/state/thread-settled";
import {
  resolveSettledThreadTimestamp,
  resolveThreadActivityTimestamp,
  sortSettledThreads,
} from "@t3tools/client-runtime/state/thread-sort";
import {
  AUTO_SETTLE_SOON_MS,
  sortLaterThreads,
  threadAutoSettleAt,
  threadRowProjectName,
  threadSettlingStatus,
} from "@t3tools/client-runtime/state/thread-zones";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { nonMainlineBranchName } from "@t3tools/shared/git";
import { useRouter } from "@tanstack/react-router";
import { msg, T, useGT, useMessages } from "gt-react";
import { AlarmClockIcon, BellDotIcon, PinIcon } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";

import { openCommandPalette } from "../../commandPaletteBus";
import { useHandleNewThread } from "../../hooks/useHandleNewThread";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useThreadRouteTarget } from "../../hooks/useThreadRouteTarget";
import type { MessageResolver } from "../../i18n/messages";
import { resolveThreadActionProjectRef } from "../../lib/chatThreadActions";
import { resolveVerticalListNavigationKey } from "../ui/listNavigationKeys";
import { cn } from "../../lib/utils";
import {
  useDelegatedUnderParent,
  useProjects,
  useQuietThreadShells,
  useServerConfigs,
} from "../../state/entities";
import { textDirection } from "../../textDirection";
import { buildThreadRouteParams } from "../../threadRoutes";
import { formatRelativeTime } from "../../timestampFormat";
import {
  filterSidebarV2VisibleThreads,
  hasUnseenCompletion,
  nestSidebarRows,
  rehomeSidebarRowLabels,
  resolveSidebarThreadSection,
  sidebarThreadNeedsYou,
  sidebarThreadParentKey,
  sortPinnedThreadsForSidebar,
  sortWorkingThreadsBySend,
} from "../Sidebar.logic";
import {
  TideOwedLabel,
  TideRowBody,
  TideStatusLabel,
  tideRowMeta,
} from "../sidebar/SidebarTideRow";
import {
  arrangeTideActive,
  resolveTideRowLead,
  tideRenderedOrder,
} from "../sidebar/tideSidebar.logic";

const MAX_HISTORY_ROWS = 15;

type PopoverSection = "pinned" | "needsYou" | "trail" | "working" | "snoozed" | "settled";

interface PopoverThreadRow {
  readonly key: string;
  readonly thread: EnvironmentThreadShell;
  readonly section: PopoverSection;
  readonly groupLabel: string | null;
}

function threadKeyOf(thread: Pick<EnvironmentThreadShell, "environmentId" | "id">): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
}

function compactRelativeTime(timestamp: string | null, nowMs: number, resolve: MessageResolver) {
  if (timestamp === null) return null;
  const parts = formatRelativeTime(timestamp, nowMs, resolve);
  if (parts === null) return null;
  return parts.suffix === null ? resolve(msg("now", { $context: "relative time" })) : parts.value;
}

function laterTimeLabel(label: string): string {
  return label === "now" || label === "due" ? label : `in ${label}`;
}

export function MenuBarPopover({ onClose }: { readonly onClose: () => void }) {
  const router = useRouter();
  const gt = useGT();
  const resolveMessage = useMessages();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [prompt, setPrompt] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(-1);

  const threads = useQuietThreadShells();
  const delegatedUnderParent = useDelegatedUnderParent();
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const projectGroups = useSidebarProjectGroups();
  const nowMinute = useNowMinute();
  const routeTarget = useThreadRouteTarget();
  const newThreadContext = useHandleNewThread();

  const nowMs = Date.parse(`${nowMinute}Z`);
  const nowIso = `${nowMinute}:00.000Z`;
  const routeKey = routeTarget?.kind === "server" ? scopedThreadKey(routeTarget.threadRef) : null;

  const projectByKey = new Map<string, (typeof projects)[number]>(
    projects.map((project) => [`${project.environmentId}:${project.id}`, project] as const),
  );
  const projectDisplayNameByKey = new Map<string, string>(
    projectGroups.flatMap((group) =>
      group.memberProjects.map(
        (project) => [`${project.environmentId}:${project.id}`, group.displayName] as const,
      ),
    ),
  );

  const visible = filterSidebarV2VisibleThreads(threads, null, delegatedUnderParent);
  const pinned: EnvironmentThreadShell[] = [];
  const active: EnvironmentThreadShell[] = [];
  const working: EnvironmentThreadShell[] = [];
  const snoozed: EnvironmentThreadShell[] = [];
  const settled: EnvironmentThreadShell[] = [];
  for (const thread of visible) {
    const configLoaded = serverConfigs.has(thread.environmentId);
    const section = resolveSidebarThreadSection({
      snoozed: configLoaded && effectiveSnoozed(thread, { now: nowIso }),
      settled: configLoaded && thread.settledOverride === "settled",
      pinned: thread.pinnedAt != null,
    });
    if (section === "pinned") pinned.push(thread);
    else if (section === "snoozed") snoozed.push(thread);
    else if (section === "settled") settled.push(thread);
    else if (isThreadWorking(thread)) working.push(thread);
    else active.push(thread);
  }

  const nestDepthByKey = new Map<string, number>();
  const nest = (list: readonly EnvironmentThreadShell[]) => {
    const nested = nestSidebarRows(list, threadKeyOf, sidebarThreadParentKey);
    for (const [key, depth] of nested.depthByKey) nestDepthByKey.set(key, depth);
    return nested.rows;
  };
  const pinnedThreads = nest(sortPinnedThreadsForSidebar(pinned));
  const workingThreads = nest(sortWorkingThreadsBySend(working));
  const snoozedThreads = nest(sortLaterThreads(snoozed));
  const settledThreads = nest(sortSettledThreads(settled).slice(0, MAX_HISTORY_ROWS));
  const isNeedsYou = (thread: EnvironmentThreadShell) =>
    sidebarThreadNeedsYou(thread, { includeCompleted: false });
  const tideActive = arrangeTideActive({
    active,
    isNeedsYou,
    nowMs,
    trailExpanded: true,
    routeKey,
    projectOf: null,
  });

  const needsYouThreads = nest(tideActive.needsYou);
  const trailThreads = nest(tideActive.visibleTrail);
  const trailGroupLabelByKey = rehomeSidebarRowLabels(
    tideActive.visibleTrail.map(threadKeyOf),
    nestDepthByKey,
    tideActive.groupLabelByKey,
  );

  const orderedRows: PopoverThreadRow[] = tideRenderedOrder<PopoverThreadRow>({
    pinned: pinnedThreads.map((thread) => ({
      key: threadKeyOf(thread),
      thread,
      section: "pinned" as const,
      groupLabel: null,
    })),
    needsYou: needsYouThreads.map((thread) => ({
      key: threadKeyOf(thread),
      thread,
      section: "needsYou" as const,
      groupLabel: null,
    })),
    trail: trailThreads.map((thread) => {
      const key = threadKeyOf(thread);
      return {
        key,
        thread,
        section: "trail" as const,
        groupLabel: trailGroupLabelByKey.get(key) ?? null,
      };
    }),
    working: workingThreads.map((thread) => ({
      key: threadKeyOf(thread),
      thread,
      section: "working" as const,
      groupLabel: null,
    })),
    later: snoozedThreads.map((thread) => ({
      key: threadKeyOf(thread),
      thread,
      section: "snoozed" as const,
      groupLabel: null,
    })),
    history: settledThreads.map((thread) => ({
      key: threadKeyOf(thread),
      thread,
      section: "settled" as const,
      groupLabel: null,
    })),
  });

  const clampedHighlight =
    highlightedIndex >= orderedRows.length ? orderedRows.length - 1 : highlightedIndex;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- focuses the new-thread input when the popover opens
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the keyboard-highlighted row visible in the scroll container
  useEffect(() => {
    if (clampedHighlight < 0) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-menubar-index="${clampedHighlight}"]`,
    );
    row?.scrollIntoView({ block: "nearest" });
  }, [clampedHighlight]);

  const openThread = (threadRef: ScopedThreadRef) => {
    void router.navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(threadRef),
    });
    void window.desktopBridge?.revealWindow();
    onClose();
  };

  const startNewThread = () => {
    const trimmed = prompt.trim();
    const projectRef = resolveThreadActionProjectRef({
      activeDraftThread: newThreadContext.activeDraftThread,
      activeThread: newThreadContext.activeThread ?? undefined,
      defaultProjectRef: newThreadContext.defaultProjectRef,
      handleNewThread: newThreadContext.handleNewThread,
    });
    if (projectRef !== null) {
      void newThreadContext.handleNewThread(
        projectRef,
        trimmed.length > 0 ? { prompt } : undefined,
      );
    } else {
      openCommandPalette({ open: "new-thread-in" });
    }
    void window.desktopBridge?.revealWindow();
    onClose();
  };

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    const navKey = resolveVerticalListNavigationKey({
      key: event.key,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      altKey: event.altKey,
      shiftKey: event.shiftKey,
      isComposing: event.nativeEvent.isComposing,
      keyCode: event.keyCode,
    });
    if (navKey === "ArrowDown") {
      event.preventDefault();
      event.stopPropagation();
      if (orderedRows.length === 0) return;
      setHighlightedIndex((current) =>
        current < 0 ? 0 : Math.min(current + 1, orderedRows.length - 1),
      );
      return;
    }
    if (navKey === "ArrowUp") {
      event.preventDefault();
      event.stopPropagation();
      setHighlightedIndex((current) => {
        if (current <= 0) {
          inputRef.current?.focus();
          return -1;
        }
        return current - 1;
      });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      if (clampedHighlight >= 0) {
        const target = orderedRows[clampedHighlight];
        if (target !== undefined) {
          openThread(scopeThreadRef(target.thread.environmentId, target.thread.id));
          return;
        }
      }
      startNewThread();
    }
  };

  const indexByKey = new Map(orderedRows.map((row, index) => [row.key, index] as const));

  const renderRow = (row: PopoverThreadRow) => {
    const { thread, section, key } = row;
    const index = indexByKey.get(key) ?? -1;
    const isHighlighted = index === clampedHighlight;
    const isActive = key === routeKey;
    const nestDepth = nestDepthByKey.get(key) ?? 0;
    const projectKey = `${thread.environmentId}:${thread.projectId}`;
    const project = projectByKey.get(projectKey) ?? null;
    const projectName = threadRowProjectName(projectDisplayNameByKey.get(projectKey), {
      singleProject: projectGroups.length === 1,
      underProjectLabel: false,
    });
    const wokeAt = threadWokeAt(thread, { now: nowIso });
    const showsStatus = section === "pinned" || section === "needsYou" || section === "working";
    const tideLead = resolveTideRowLead(thread, {
      showsStatus,
      isWoke: wokeAt !== null,
      later:
        section === "snoozed"
          ? {
              recheckLimit:
                serverConfigs.get(thread.environmentId)?.settings.laterRecheckLimit ?? null,
            }
          : undefined,
    });
    const settlesAtMs = section === "trail" ? threadAutoSettleAt(thread) : null;
    // A row with nothing owed and no status of its own says when it is about to leave the list,
    // and a History row says the server settled it rather than you.
    const lead =
      tideLead.lead ??
      (settlesAtMs !== null && settlesAtMs - nowMs <= AUTO_SETTLE_SOON_MS
        ? ({
            kind: "status",
            tone: "settling",
            word: threadSettlingStatus(settlesAtMs, { now: nowIso }, resolveMessage),
          } as const)
        : section === "settled" && thread.autoSettledAt
          ? ({
              kind: "status",
              tone: "auto-settled",
              word: gt("Auto settled", { $context: "thread status, settled on its own" }),
            } as const)
          : null);
    const label =
      lead === null ? null : lead.kind === "owed" ? (
        <TideOwedLabel>{lead.word}</TideOwedLabel>
      ) : (
        <TideStatusLabel tone={lead.tone}>{lead.word}</TideStatusLabel>
      );
    const tideTimeAt = tideActive.timeAtByKey.get(key) ?? null;
    const snoozeWake = section === "snoozed" ? laterWhenLabel(thread, { now: nowIso }) : null;
    const timeContent =
      section === "snoozed" && snoozeWake !== null ? (
        <span className="inline-flex items-center gap-1 tabular-nums">
          <AlarmClockIcon aria-hidden className="size-3" />
          {laterTimeLabel(snoozeWake)}
        </span>
      ) : tideLead.running ? null : (
        <span className="tabular-nums">
          {compactRelativeTime(
            section === "settled"
              ? resolveSettledThreadTimestamp(thread)
              : tideTimeAt !== null
                ? new Date(tideTimeAt).toISOString()
                : resolveThreadActivityTimestamp(thread),
            nowMs,
            resolveMessage,
          )}
        </span>
      );
    const unreadCompletion = hasUnseenCompletion(thread);

    return (
      <li
        key={key}
        className="list-none"
        style={nestDepth > 0 ? { paddingInlineStart: Math.min(nestDepth, 3) * 12 } : undefined}
      >
        {row.groupLabel ? (
          <div className="flex h-6 items-end truncate px-(--sidebar-row-content-inset) pb-1 text-2xs font-medium text-sidebar-muted-foreground/80">
            {row.groupLabel}
          </div>
        ) : null}
        <button
          type="button"
          data-menubar-index={index}
          aria-current={isActive ? "page" : undefined}
          onClick={() => openThread(scopeThreadRef(thread.environmentId, thread.id))}
          onKeyDown={(event) => {
            // A row focused with Tab opens itself, not the highlighted row or a new thread.
            if (event.key === "Enter") event.stopPropagation();
          }}
          className={cn(
            "flex min-h-9 w-full cursor-pointer flex-col justify-center overflow-hidden rounded-md px-(--sidebar-row-content-inset) py-2 text-left outline-none select-none",
            section === "settled" && !isActive && !isHighlighted && "text-sidebar-muted-foreground",
            isHighlighted
              ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
              : isActive
                ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
                : "text-sidebar-foreground hover:bg-sidebar-row-hover",
          )}
        >
          <TideRowBody
            project={null}
            time={timeContent}
            title={
              <span
                className={cn(
                  "min-w-0 flex-1 truncate text-row-title text-start",
                  unreadCompletion ? "font-semibold text-foreground" : "font-medium",
                )}
                dir={textDirection(thread.title)}
              >
                {thread.title}
              </span>
            }
            unreadCompletion={unreadCompletion}
            titleTrailing={
              thread.pinnedAt != null ? (
                <PinIcon aria-hidden className="size-3 shrink-0 text-muted-foreground/65" />
              ) : null
            }
            label={label}
            text={tideLead.text}
            maxLines={section === "needsYou" ? 3 : 2}
            meta={tideRowMeta({
              project,
              name: projectName,
              branch: nonMainlineBranchName(thread.branch),
            })}
          />
        </button>
      </li>
    );
  };

  const sections: Array<{
    readonly id: PopoverSection;
    readonly label: string | null;
    readonly rows: readonly PopoverThreadRow[];
  }> = [
    {
      id: "pinned",
      label: null,
      rows: orderedRows.filter((row) => row.section === "pinned"),
    },
    {
      id: "needsYou",
      label: gt("Needs you", { $context: "sidebar section" }),
      rows: orderedRows.filter((row) => row.section === "needsYou"),
    },
    {
      id: "trail",
      label: gt("Recent", { $context: "sidebar section" }),
      rows: orderedRows.filter((row) => row.section === "trail"),
    },
    {
      id: "working",
      label: gt("Working", { $context: "sidebar section" }),
      rows: orderedRows.filter((row) => row.section === "working"),
    },
    {
      id: "snoozed",
      label: gt("Later", { $context: "sidebar section" }),
      rows: orderedRows.filter((row) => row.section === "snoozed"),
    },
    {
      id: "settled",
      label: gt("History", { $context: "sidebar section" }),
      rows: orderedRows.filter((row) => row.section === "settled"),
    },
  ];

  return (
    <div
      data-sidebar-window="menubar"
      data-sidebar-rows="card"
      onKeyDown={handleKeyDown}
      className="flex h-dvh min-h-0 flex-col overflow-hidden bg-sidebar surface-grain text-sidebar-foreground dark:bg-(--surface-raised)"
    >
      <div className="shrink-0 border-b border-sidebar-border px-(--sidebar-content-inset) py-2">
        <input
          ref={inputRef}
          type="text"
          value={prompt}
          aria-label={gt("Start a new thread")}
          placeholder={gt("Start a new thread…")}
          onChange={(event) => {
            setPrompt(event.currentTarget.value);
            if (highlightedIndex !== -1) setHighlightedIndex(-1);
          }}
          className="h-9 w-full rounded-md bg-sidebar-row-hover/60 px-(--sidebar-row-content-inset) text-sm text-sidebar-foreground placeholder:text-sidebar-muted-foreground/70 outline-none focus:bg-sidebar-row-hover focus:ring-1 focus:ring-inset focus:ring-ring"
        />
      </div>

      <div
        ref={listRef}
        role="region"
        aria-label={gt("Threads")}
        className="min-h-0 flex-1 overflow-y-auto px-(--sidebar-content-inset) py-1.5"
      >
        {orderedRows.length === 0 ? (
          <p className="px-(--sidebar-row-content-inset) py-6 text-center text-xs text-sidebar-muted-foreground">
            <T>No threads yet. Type above and press Enter to start one.</T>
          </p>
        ) : (
          <div className="flex flex-col gap-1.5">
            {sections.map((section) => {
              if (section.rows.length === 0) return null;
              if (section.id === "needsYou") {
                return (
                  <section
                    key={section.id}
                    className="rounded-lg bg-primary/5 pb-1 dark:bg-primary/15"
                  >
                    <div className="flex h-6 items-center gap-1.5 px-(--sidebar-row-content-inset) text-xs font-medium text-primary">
                      <BellDotIcon aria-hidden className="size-3.5 shrink-0" />
                      <span className="min-w-0 flex-1 truncate">{section.label}</span>
                    </div>
                    <ul className="flex flex-col gap-px">{section.rows.map(renderRow)}</ul>
                  </section>
                );
              }
              return (
                <section key={section.id} className="flex flex-col gap-px">
                  {section.label !== null ? (
                    <div className="flex h-7 items-center gap-1 px-(--sidebar-row-content-inset) text-xs font-medium text-sidebar-muted-foreground">
                      <span className="min-w-0 flex-1 truncate">{section.label}</span>
                      <span className="font-normal tabular-nums">{section.rows.length}</span>
                    </div>
                  ) : null}
                  <ul className="flex flex-col gap-px">{section.rows.map(renderRow)}</ul>
                </section>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
