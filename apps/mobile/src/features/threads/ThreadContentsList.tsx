import { contentsVisible, entryOwedLabel } from "@t3tools/client-runtime/state/thread-entries";
import type { EnvironmentId, ThreadEntry, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ROW_MIN_HEIGHT } from "../../components/ui/listMetrics";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadEntries } from "../../state/threadEntries";
import { TopicRow } from "../history/TopicRow";
import { formatMessageTimestamp } from "./messageTimestamp";
import { requestThreadMessageJump } from "./threadMessageJump";

export interface ContentsThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const openLabel = (entries: ReadonlyArray<ThreadEntry>) => {
  const open = entries.filter((entry) => entryOwedLabel(entry.open) !== null).length;
  return `${entries.length} topics${open > 0 ? ` · ${open} open` : ""}`;
};

/** The thread settings row into Contents, shown once the thread has two topics. */
export function ThreadContentsRow(props: {
  readonly thread: ContentsThread;
  readonly onPress: () => void;
}) {
  const result = useThreadEntries(props.thread.environmentId, props.thread.threadId);
  if (!contentsVisible(result?.entries)) return null;
  const entries = result?.entries ?? [];
  return (
    <>
      <Text className="px-5 pb-2 pt-2 text-sm font-t3-medium text-foreground-muted">Thread</Text>
      <View className="mx-4 mb-5 overflow-hidden rounded-2xl bg-grouped-card">
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Lists the thread's topics."
          onPress={props.onPress}
          className="flex-row items-center gap-2 bg-grouped-card px-4 py-2 active:bg-subtle"
          style={{ minHeight: ROW_MIN_HEIGHT.item }}
        >
          <Text className="text-sm font-t3-medium text-foreground">Contents</Text>
          <View className="flex-1" />
          <Text className="text-sm text-foreground-muted" numberOfLines={1}>
            {openLabel(entries)}
          </Text>
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-icon-subtle"
            type="monochrome"
          />
        </Pressable>
      </View>
    </>
  );
}

/**
 * A thread's topics in order of first appearance. A tap closes the sheet and scrolls the feed to
 * the message that started the topic. Contents are read here, never edited.
 */
export function ThreadContentsList(props: {
  readonly thread: ContentsThread;
  readonly onOpened: () => void;
}) {
  const insets = useSafeAreaInsets();
  const result = useThreadEntries(props.thread.environmentId, props.thread.threadId);
  const [now] = useState(() => Date.now());
  const entries = result?.entries ?? [];
  return (
    <ScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{ paddingTop: 4, paddingBottom: insets.bottom + 16 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      {entries.length === 0 ? (
        <Text className="px-5 py-8 text-center text-sm text-foreground-muted">
          {result === null ? "Loading topics…" : "No topics yet."}
        </Text>
      ) : (
        entries.map((entry) => (
          <TopicRow
            key={entry.id}
            context={null}
            time={formatMessageTimestamp(entry.startedAt, now)}
            title={entry.title}
            owed={entryOwedLabel(entry.open)}
            outcome={entry.outcome}
            accessibilityHint="Scrolls the thread to where this topic started."
            onPress={() => {
              requestThreadMessageJump(
                scopedThreadKey(props.thread.environmentId, props.thread.threadId),
                entry.startMessageId,
              );
              props.onOpened();
            }}
          />
        ))
      )}
    </ScrollView>
  );
}
