import { entryDayGroups } from "@t3tools/client-runtime/state/thread-entries";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import type { EnvironmentId, ScopedProjectRef } from "@t3tools/contracts";
import { useNavigate, useSearch } from "@tanstack/react-router";
import { SearchIcon } from "lucide-react";
import { useEffect, useEffectEvent, useState } from "react";

import { isElectron } from "../../env";
import { useClientSettings } from "../../hooks/useSettings";
import { useSidebarProjectGroups } from "../../hooks/useSidebarProjectGroups";
import { useStillOpenActions } from "../../hooks/useStillOpenActions";
import { useProjects } from "../../state/entities";
import { useDebouncedValue } from "../../state/queries";
import {
  refreshEntries,
  useCanOperateEntries,
  useEntriesEnvironmentIds,
  useEntryList,
  useOpenItemTotals,
} from "../../state/threadEntries";
import { formatFullTimestamp, formatShortTimestamp } from "../../timestampFormat";
import { Button, InlineButton } from "../ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "../ui/empty";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { SidebarInset } from "../ui/sidebar";
import { Toggle } from "../ui/toggle";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { HistoryBackfillFooter } from "./HistoryBackfillFooter";
import { HistoryEntryRow } from "./HistoryEntryRow";
import {
  historyChipKeys,
  historyListInputs,
  publishTargets,
  type HistorySearch,
} from "./historyPage.logic";

const SEARCH_DEBOUNCE_MS = 250;

/** Every topic from every thread, newest first, by day. */
export function HistoryPage() {
  const search: HistorySearch = useSearch({ from: "/_chat/history" });
  const navigate = useNavigate({ from: "/history" });
  const setSearch = (patch: Partial<Record<keyof HistorySearch, string | undefined>>) =>
    void navigate({
      search: (previous: HistorySearch) => {
        const next: Record<string, string> = {};
        for (const [key, value] of Object.entries({ ...previous, ...patch })) {
          if (value !== undefined && value !== "") next[key] = value;
        }
        return next as HistorySearch;
      },
      replace: true,
    });
  const environmentIds = useEntriesEnvironmentIds();
  const groups = pickableProjectGroups(useSidebarProjectGroups());
  const chosen = groups.find((group) => group.projectKey === search.project) ?? null;
  const members: ReadonlyArray<ScopedProjectRef> | null = chosen?.memberProjectRefs ?? null;
  const stillOpen = search.open === "1";
  const query = useDebouncedValue(search.q ?? "", SEARCH_DEBOUNCE_MS);
  const targets = historyListInputs({ environmentIds, members, stillOpen, query });

  const [paging, setPaging] = useState<{
    key: string;
    pages: Readonly<Record<string, number>>;
  }>({ key: "", pages: {} });
  const targetsKey = JSON.stringify(targets);
  // New filters start again from the first page.
  if (paging.key !== targetsKey) setPaging({ key: targetsKey, pages: {} });
  const pages = paging.key === targetsKey ? paging.pages : {};
  const list = useEntryList(targets, (environmentId) => pages[environmentId] ?? 1);

  const groupOfProject = new Map<string, (typeof groups)[number]>();
  for (const group of groups) {
    for (const ref of group.memberProjectRefs) {
      groupOfProject.set(`${ref.environmentId}:${ref.projectId}`, group);
    }
  }
  const [seenKeys, setSeenKeys] = useState<ReadonlySet<string>>(() => new Set());
  const shownKeys = new Set<string>();
  for (const row of list.rows) {
    const key = groupOfProject.get(`${row.environmentId}:${row.projectId}`)?.projectKey;
    if (key !== undefined) shownKeys.add(key);
  }
  if ([...shownKeys].some((key) => !seenKeys.has(key))) {
    setSeenKeys(new Set([...seenKeys, ...shownKeys]));
  }
  const chipKeys = historyChipKeys({
    orderedKeys: groups.map((group) => group.projectKey),
    seenKeys,
    chosenKey: chosen?.projectKey ?? null,
  });

  const open = useOpenItemTotals(members, environmentIds.length > 0);
  const canOperate = useCanOperateEntries(environmentIds);
  const actions = useStillOpenActions();
  const projects = useProjects();
  const refreshTargets = (
    members === null
      ? projects.map((project) => ({
          environmentId: project.environmentId,
          projectId: project.id,
        }))
      : members
  ).filter((ref) => environmentIds.includes(ref.environmentId));

  const refreshKey = stillOpen ? JSON.stringify(refreshTargets) : null;
  const refreshCheckouts = useEffectEvent((refs: ReadonlyArray<ScopedProjectRef>) =>
    actions.refreshOpenItems(publishTargets(refs, environmentIds)),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the servers to re-read the checkouts once when Still open is shown, so Commit items on clean checkouts clear
  useEffect(() => {
    if (refreshKey !== null) refreshCheckouts(JSON.parse(refreshKey) as ScopedProjectRef[]);
  }, [refreshKey]);

  const environmentsKey = environmentIds.join("\n");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the lists again when the window regains focus, since clears on settled threads reach no stream
  useEffect(() => {
    const ids = environmentsKey === "" ? [] : (environmentsKey.split("\n") as EnvironmentId[]);
    const onFocus = () => refreshEntries(ids);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [environmentsKey]);

  const timestampFormat = useClientSettings((settings) => settings.timestampFormat);
  const [now] = useState(() => Date.now());
  const days = entryDayGroups(list.rows, now);

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-x-hidden bg-background">
        <WorkspacePageHeader electron={isElectron} className="border-b border-border">
          <h1 className="truncate text-sm font-medium text-foreground">History</h1>
        </WorkspacePageHeader>
        {environmentIds.length === 0 ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>No topics here</EmptyTitle>
              <EmptyDescription>
                Topics need a T3 Code server that keeps them. Settled threads are still in the
                sidebar's History list.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <div className="scrollbar-gutter-both min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto flex w-full max-w-3xl flex-col gap-3 px-4 py-4">
              <div className="flex flex-wrap items-center gap-1.5">
                <InputGroup className="min-w-0 flex-[1_1_12rem]">
                  <InputGroupAddon>
                    <SearchIcon aria-hidden />
                  </InputGroupAddon>
                  <InputGroupInput
                    type="search"
                    aria-label="Search topics and outcomes"
                    placeholder="Search topics and outcomes"
                    maxLength={100}
                    value={search.q ?? ""}
                    onChange={(event) => setSearch({ q: event.target.value })}
                  />
                </InputGroup>
                <Toggle
                  variant="pill"
                  size="xs"
                  pressed={chosen === null}
                  onPressedChange={() => setSearch({ project: undefined })}
                >
                  All projects
                </Toggle>
                {chipKeys.map((key) => {
                  const group = groups.find((candidate) => candidate.projectKey === key);
                  if (group === undefined) return null;
                  return (
                    <Toggle
                      key={key}
                      variant="pill"
                      size="xs"
                      pressed={chosen?.projectKey === key}
                      onPressedChange={(pressed) =>
                        setSearch({ project: pressed ? key : undefined })
                      }
                    >
                      {group.displayName}
                    </Toggle>
                  );
                })}
                <Toggle
                  variant="outline"
                  size="xs"
                  pressed={stillOpen}
                  onPressedChange={(pressed) => setSearch({ open: pressed ? "1" : undefined })}
                  title={open.summary === "" ? "Nothing is owed" : open.summary}
                >
                  Still open · {open.total}
                </Toggle>
                {stillOpen &&
                chosen !== null &&
                publishTargets(chosen.memberProjectRefs, environmentIds).some((target) =>
                  canOperate.has(target.environmentId),
                ) ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={open.ship === 0}
                    title={
                      open.ship === 0
                        ? "Nothing here is waiting on a publish"
                        : "Clears what waits on a publish and starts the re-checks that wait for one"
                    }
                    onClick={() =>
                      void actions.markPublished(
                        chosen.displayName,
                        publishTargets(chosen.memberProjectRefs, environmentIds).filter((target) =>
                          canOperate.has(target.environmentId),
                        ),
                      )
                    }
                  >
                    Mark published
                  </Button>
                ) : null}
              </div>

              {list.rows.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  {list.pending
                    ? "Loading topics…"
                    : (list.error ??
                      (query.trim() !== "" || stillOpen || chosen !== null
                        ? "Nothing matches."
                        : "No topics yet. Each finished reply adds to one."))}
                </p>
              ) : (
                <div className="flex flex-col">
                  {days.map((day, index) => (
                    <section key={day.label} aria-label={day.label}>
                      <div className="mt-3 mb-0.5 flex items-baseline justify-between px-2 text-2xs text-muted-foreground">
                        <h2 className="font-medium tracking-wide uppercase">{day.label}</h2>
                        {/* Said once, so no row needs a word beside its time. */}
                        {index === 0 ? <span>Last worked on</span> : null}
                      </div>
                      <ul className="flex flex-col">
                        {day.rows.map((row) => {
                          const group = groupOfProject.get(`${row.environmentId}:${row.projectId}`);
                          return (
                            <HistoryEntryRow
                              key={`${row.environmentId}:${row.id}`}
                              row={row}
                              project={
                                chosen !== null
                                  ? null
                                  : { icon: group ?? null, name: group?.displayName ?? "Project" }
                              }
                              time={formatShortTimestamp(row.endedAt, timestampFormat)}
                              timeTitle={`Last worked on ${formatFullTimestamp(row.endedAt, timestampFormat)}`}
                              showOpenItems={stillOpen}
                              onDone={
                                canOperate.has(row.environmentId)
                                  ? (item) =>
                                      void actions.markDone(row.environmentId, row.threadId, item)
                                  : null
                              }
                            />
                          );
                        })}
                      </ul>
                    </section>
                  ))}
                </div>
              )}

              <div className="flex flex-col items-center gap-2 pb-6 text-xs text-muted-foreground">
                {list.hasMore ? (
                  <InlineButton
                    tone="muted"
                    disabled={list.pending}
                    onClick={() =>
                      setPaging({
                        key: paging.key,
                        pages: Object.fromEntries(
                          targets.map(({ environmentId }) => [
                            environmentId,
                            (paging.pages[environmentId] ?? 1) +
                              (list.moreIn.includes(environmentId) ? 1 : 0),
                          ]),
                        ),
                      })
                    }
                  >
                    {list.pending ? "Loading…" : "Show more"}
                  </InlineButton>
                ) : list.rows.length > 0 ? (
                  <p>Threads from before topics were kept are in the sidebar's History list.</p>
                ) : null}
                <HistoryBackfillFooter environmentIds={environmentIds} scope={members} />
              </div>
            </div>
          </div>
        )}
      </div>
    </SidebarInset>
  );
}
