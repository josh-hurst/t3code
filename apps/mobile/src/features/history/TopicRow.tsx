import type { ReactNode } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/**
 * One topic in the owner's row anatomy: where it is and its time, the topic, then what it still
 * owes and its outcome. No icon gutter; colour stays out, since nothing here is a status.
 */
export function TopicRow(props: {
  /** Line 1 on the left: project · thread; null inside one thread. */
  readonly context: string | null;
  readonly time: string;
  readonly title: string;
  readonly owed: string | null;
  readonly outcome: string;
  readonly onPress: () => void;
  readonly accessibilityHint: string;
  readonly footer?: ReactNode;
}) {
  const hasLine3 = props.owed !== null || props.outcome !== "";
  return (
    <View className="px-5 py-2.5">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={[props.title, props.context, props.owed, props.outcome, props.time]
          .filter((part): part is string => Boolean(part))
          .join(", ")}
        accessibilityHint={props.accessibilityHint}
        onPress={props.onPress}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        {props.context === null ? (
          // Inside one thread the place is plain, so the time joins the title's line.
          <View className="flex-row items-baseline gap-2">
            <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={1}>
              {props.title}
            </Text>
            <Text className="text-xs tabular-nums text-foreground-tertiary">{props.time}</Text>
          </View>
        ) : (
          <>
            <View className="flex-row items-baseline gap-2">
              <Text className="min-w-0 flex-1 text-xs text-foreground-tertiary" numberOfLines={1}>
                {props.context}
              </Text>
              <Text className="text-xs tabular-nums text-foreground-tertiary">{props.time}</Text>
            </View>
            <Text className="text-base text-foreground" numberOfLines={1}>
              {props.title}
            </Text>
          </>
        )}
        {hasLine3 ? (
          <Text className="text-xs text-foreground-tertiary" numberOfLines={2}>
            {props.owed === null ? null : (
              <Text className="text-xs font-t3-medium text-foreground-secondary">
                {props.owed}
                {props.outcome === "" ? "" : "  "}
              </Text>
            )}
            {props.outcome}
          </Text>
        ) : null}
      </Pressable>
      {props.footer}
    </View>
  );
}
