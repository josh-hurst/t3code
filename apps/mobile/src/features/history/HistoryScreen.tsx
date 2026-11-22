import { LegendList } from "@legendapp/list/react-native";
import { pickableProjectGroups } from "@t3tools/client-runtime/state/project-grouping";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import {
  entryDayGroups,
  entryListInputs,
  entryOwedLabel,
  entryPublishItems,
  entryPublishTargets,
  unpublishedCount,
  type EntryRow,
} from "@t3tools/client-runtime/state/thread-entries";
import { threadCardOpenItemLabel } from "@t3tools/client-runtime/state/thread-zones";
import {
  threadCardOpenItemKey,
  type EnvironmentId,
  type PublishMarkerId,
  type ThreadEntryOpenItem,
} from "@t3tools/contracts";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";
import { Pressable, ScrollView, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { RefreshControl } from "../../components/ui/RefreshControl";
import { Toast } from "../../components/ui/Toast";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { NativeScrollView } from "../../native/NativeScrollViewMarker";
import { useProjects } from "../../state/entities";
import { useDebouncedValue } from "../../state/queries";
import {
  refreshEntries,
  threadEntryAtoms,
  useCanOperateEntries,
  useEntriesEnvironmentIds,
  useEntryList,
  useOpenItemCounts,
} from "../../state/threadEntries";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import { buildHomeProjectScopes } from "../home/homeThreadList";
import { useHomeListOptions } from "../home/home-list-options";
import { ListFilterMenu } from "../layout/workspace/ListFilterMenu";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { formatMessageTimestamp } from "../threads/messageTimestamp";
import { requestThreadMessageJump } from "../threads/threadMessageJump";
import { TopicRow } from "./TopicRow";

const SEARCH_DEBOUNCE_MS = 250;
const NOTICE_MS = 5_000;

type HistoryListItem =
  | { readonly kind: "day"; readonly key: string; readonly label: string }
  | { readonly kind: "row"; readonly key: string; readonly row: EntryRow };

interface Notice {
  readonly message: string;
  readonly description?: string;
  readonly undo?: () => void;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

function failed(result: AtomCommandResult<unknown, unknown>, title: string): boolean {
  if (result._tag !== "Failure") return false;
  if (!isAtomCommandInterrupted(result)) {
    const error = squashAtomCommandFailure(result);
    Dialog.alert(title, error instanceof Error ? error.message : "An error occurred.");
  }
  return true;
}

/** Every topic from every thread, newest first, by day. Read-only apart from what is still owed. */
export function HistoryScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { themeAppearance } = useAppearancePreferences();
  const environmentIds = useEntriesEnvironmentIds();
  const environmentsKey = environmentIds.join("\n");
  const projects = useProjects();
  const { options } = useHomeListOptions(new Set(environmentIds));
  const groups = pickableProjectGroups(
    buildHomeProjectScopes({
      projects,
      environmentId: null,
      projectGroupingMode: options.projectGroupingMode,
    }),
  );
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const chosen = groups.find((group) => group.key === chosenKey) ?? null;
  const members = chosen?.projectRefs ?? null;
  const [unpublished, setUnpublished] = useState(false);
  const [search, setSearch] = useState("");
  const query = useDebouncedValue(search, SEARCH_DEBOUNCE_MS);
  const targets = entryListInputs({ environmentIds, members, unpublished, query });

  const targetsKey = JSON.stringify(targets);
  const [paging, setPaging] = useState<{
    readonly key: string;
    readonly pages: Readonly<Record<string, number>>;
  }>({ key: "", pages: {} });
  // New filters start again from the first page.
  if (paging.key !== targetsKey) setPaging({ key: targetsKey, pages: {} });
  const pages = paging.key === targetsKey ? paging.pages : {};
  const list = useEntryList(targets, (environmentId) => pages[environmentId] ?? 1);

  const waiting = unpublishedCount(useOpenItemCounts(environmentIds), members);
  const canOperate = useCanOperateEntries(environmentIds);

  // Clears on settled threads reach no stream, so the lists read again whenever the screen shows.
  useFocusEffect(
    useCallback(() => {
      refreshEntries(
        environmentsKey === "" ? [] : (environmentsKey.split("\n") as EnvironmentId[]),
      );
    }, [environmentsKey]),
  );

  const [notice, setNotice] = useState<{ readonly notice: Notice; readonly id: number } | null>(
    null,
  );
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showNotice = (next: Notice) => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    const id = (notice?.id ?? 0) + 1;
    setNotice({ notice: next, id });
    noticeTimer.current = setTimeout(() => {
      setNotice((current) => (current?.id === id ? null : current));
    }, NOTICE_MS);
  };
  const dismissNotice = () => {
    if (noticeTimer.current !== null) clearTimeout(noticeTimer.current);
    setNotice(null);
  };

  const markPublishedCommand = useAtomCommand(threadEntryAtoms.markPublished, {
    reportFailure: false,
  });
  const undoPublishedCommand = useAtomCommand(threadEntryAtoms.undoPublished, {
    reportFailure: false,
  });
  const resolveCommand = useAtomCommand(threadEntryAtoms.resolveOpenItem, {
    reportFailure: false,
  });
  const restoreCommand = useAtomCommand(threadEnvironment.restoreOpenItems, {
    reportFailure: false,
  });

  const publishTargets =
    chosen === null
      ? []
      : entryPublishTargets(chosen.projectRefs, environmentIds).filter((target) =>
          canOperate.has(target.environmentId),
        );
  const markPublished = async () => {
    if (chosen === null) return;
    const markers: Array<{ environmentId: EnvironmentId; markerId: PublishMarkerId }> = [];
    let cleared = 0;
    let started = 0;
    for (const { environmentId, projectIds } of publishTargets) {
      const result = await markPublishedCommand({ environmentId, input: { projectIds } });
      if (failed(result, `Could not mark ${chosen.title} published`)) continue;
      if (result._tag !== "Success") continue;
      markers.push({ environmentId, markerId: result.value.markerId });
      cleared += result.value.cleared;
      started += result.value.followUpsStarted;
    }
    if (markers.length === 0) return;
    showNotice({
      message: `Marked ${chosen.title} published`,
      description: `Cleared ${plural(cleared, "Publish item")}${started > 0 ? `; ${plural(started, "re-check")} will run after it` : ""}.`,
      undo: () => {
        void (async () => {
          let restored = 0;
          for (const { environmentId, markerId } of markers) {
            const result = await undoPublishedCommand({ environmentId, input: { markerId } });
            if (failed(result, "Could not undo the publish")) continue;
            if (result._tag === "Success") restored += result.value.restored;
          }
          showNotice({
            message: `Restored ${plural(restored, "item")}`,
            ...(started > 0 ? { description: "Re-checks it released stay released." } : {}),
          });
        })();
      },
    });
  };
  // Publishing starts the re-checks that wait for it, which run agents, so it asks first.
  const confirmMarkPublished = () => {
    if (chosen === null) return;
    Dialog.confirm({
      title: `Mark ${chosen.title} published?`,
      message: `Clears ${plural(waiting, "item")} waiting on a publish and starts the re-checks that wait for one.`,
      confirmText: "Mark published",
      onConfirm: () => void markPublished(),
    });
  };

  const markDone = async (row: EntryRow, item: ThreadEntryOpenItem) => {
    const { environmentId, threadId } = row;
    const result = await resolveCommand({
      environmentId,
      input: { threadId, key: threadCardOpenItemKey(item) },
    });
    if (failed(result, "Could not mark the item done")) return;
    showNotice({
      message: "Marked done",
      description: item.text,
      undo: () => {
        void restoreCommand({ environmentId, input: { threadId, items: [item] } }).then(
          (restored) => {
            if (!failed(restored, "Could not restore the item")) refreshEntries([environmentId]);
          },
        );
      },
    });
  };

  // As a list row does: the thread replaces this screen, so one thread screen takes the jump.
  const selectDetail = useSelectWorkspaceDetail();
  const openTopic = (row: EntryRow) => {
    requestThreadMessageJump(scopedThreadKey(row.environmentId, row.threadId), row.startMessageId);
    selectDetail({
      name: "Thread",
      params: { environmentId: String(row.environmentId), threadId: String(row.threadId) },
    });
  };

  const projectName = new Map<string, string>();
  for (const group of groups) {
    for (const ref of group.projectRefs) {
      projectName.set(`${ref.environmentId}:${ref.projectId}`, group.title);
    }
  }
  const [now] = useState(() => Date.now());
  const items: HistoryListItem[] = entryDayGroups(list.rows, now).flatMap((day) => [
    { kind: "day" as const, key: `day:${day.label}`, label: day.label },
    ...day.rows.map((row) => ({
      kind: "row" as const,
      key: `${row.environmentId}:${row.id}`,
      row,
    })),
  ]);

  const renderItem = ({ item }: { readonly item: HistoryListItem }) => {
    if (item.kind === "day") {
      return (
        <Text className="px-5 pb-0.5 pt-4 text-xs font-t3-medium uppercase tracking-[0.5px] text-foreground-tertiary">
          {item.label}
        </Text>
      );
    }
    const { row } = item;
    const project =
      chosen === null ? (projectName.get(`${row.environmentId}:${row.projectId}`) ?? null) : null;
    const operable = canOperate.has(row.environmentId);
    return (
      <TopicRow
        context={project === null ? row.threadTitle : `${project} · ${row.threadTitle}`}
        time={formatMessageTimestamp(row.endedAt, now)}
        title={row.title}
        owed={entryOwedLabel(row.open)}
        outcome={row.outcome}
        onPress={() => openTopic(row)}
        accessibilityHint="Opens the thread where this topic started."
        footer={
          unpublished ? (
            <View className="mt-1 gap-1">
              {entryPublishItems(row.open).map((openItem) => (
                <View
                  key={`${openItem.kind}:${openItem.text}`}
                  className="flex-row items-baseline gap-2"
                >
                  <Text className="text-xs font-t3-medium text-foreground-secondary">
                    {threadCardOpenItemLabel(openItem.kind)}
                  </Text>
                  <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary">
                    {openItem.text}
                  </Text>
                  {operable ? (
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Done: ${openItem.text}`}
                      hitSlop={8}
                      onPress={() => void markDone(row, openItem)}
                      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
                    >
                      <Text className="text-xs font-t3-medium text-foreground-secondary">Done</Text>
                    </Pressable>
                  ) : null}
                </View>
              ))}
            </View>
          ) : undefined
        }
      />
    );
  };

  const filtered = query.trim() !== "" || unpublished || chosen !== null;
  const showMore = () =>
    setPaging({
      key: paging.key,
      pages: Object.fromEntries(
        targets.map(({ environmentId }) => [
          environmentId,
          (pages[environmentId] ?? 1) + (list.moreIn.includes(environmentId) ? 1 : 0),
        ]),
      ),
    });

  return (
    <View collapsable={false} className="flex-1 bg-screen">
      <AppBar
        title="History"
        onBack={() => navigation.goBack()}
        search={{
          value: search,
          onChangeText: setSearch,
          placeholder: "Search topics and outcomes",
          compactPlaceholder: "Search",
          accessibilityLabel: "Search topics and outcomes",
          mode: "inline",
          compactToolbar: width < 700,
        }}
      />
      {environmentIds.length === 0 ? (
        <EmptyState
          title="No topics here"
          detail="Topics need a T3 Code server that keeps them. Settled threads are still in the thread list's History."
        />
      ) : (
        <LegendList
          renderScrollComponent={NativeScrollView}
          className="flex-1"
          contentContainerStyle={{ paddingBottom: insets.bottom + 32 }}
          contentInsetAdjustmentBehavior="automatic"
          data={items}
          // Rows read the filters and grants from render; recycled cells need to hear of them.
          extraData={`${unpublished}|${chosenKey ?? ""}|${[...canOperate].join(",")}|${projectName.size}`}
          estimatedItemSize={72}
          getItemType={(item) => item.kind}
          keyExtractor={(item) => item.key}
          keyboardDismissMode="on-drag"
          keyboardShouldPersistTaps="handled"
          ListHeaderComponent={
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 8, gap: 8 }}
            >
              <ListFilterMenu
                label={chosen?.title ?? "All projects"}
                accessibilityLabel="Filter topics by project"
                active={chosen !== null}
                actions={[
                  { id: "all", title: "All projects", state: chosen === null ? "on" : "off" },
                  ...groups.map((group) => ({
                    id: JSON.stringify(group.key),
                    title: group.title,
                    state: group.key === chosenKey ? ("on" as const) : ("off" as const),
                  })),
                ]}
                onSelect={(id) => setChosenKey(id === "all" ? null : (JSON.parse(id) as string))}
              />
              <Chip
                label={`Unpublished · ${waiting}`}
                accessibilityLabel={`Unpublished: ${waiting} waiting on a publish`}
                selected={unpublished}
                glass
                colorScheme={themeAppearance}
                onPress={() => setUnpublished(!unpublished)}
              />
              {unpublished && publishTargets.length > 0 ? (
                <Button
                  label="Mark published"
                  size="compact"
                  tone="secondary"
                  disabled={waiting === 0}
                  accessibilityHint={
                    waiting === 0
                      ? "Nothing here is waiting on a publish."
                      : "Clears what waits on a publish and starts the re-checks that wait for one."
                  }
                  onPress={confirmMarkPublished}
                />
              ) : null}
            </ScrollView>
          }
          ListEmptyComponent={
            <EmptyState
              title={list.pending ? "Loading topics…" : (list.error ?? "No topics")}
              detail={
                list.pending || list.error !== null
                  ? ""
                  : filtered
                    ? "Nothing matches."
                    : "Each finished reply adds to one."
              }
            />
          }
          ListFooterComponent={
            list.hasMore ? (
              <View className="items-center py-4">
                <Button
                  label={list.pending ? "Loading…" : "Show more"}
                  tone="text"
                  disabled={list.pending}
                  onPress={showMore}
                />
              </View>
            ) : list.rows.length > 0 ? (
              <Text className="px-5 py-4 text-center text-xs text-foreground-tertiary">
                Threads from before topics were kept are in the thread list's History.
              </Text>
            ) : null
          }
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={() => refreshEntries(environmentIds)}
              tintColorClassName="accent-icon"
            />
          }
          renderItem={renderItem}
        />
      )}
      {notice !== null ? (
        <View
          className="absolute left-3 right-3"
          style={{ bottom: insets.bottom + 12 }}
          pointerEvents="box-none"
        >
          <Toast
            key={notice.id}
            message={notice.notice.message}
            {...(notice.notice.description === undefined
              ? {}
              : { description: notice.notice.description })}
            {...(notice.notice.undo === undefined
              ? {}
              : {
                  action: {
                    label: "Undo",
                    onPress: () => {
                      dismissNotice();
                      notice.notice.undo?.();
                    },
                  },
                })}
            dismissMode="swipe"
            onDismiss={dismissNotice}
          />
        </View>
      ) : null}
    </View>
  );
}
