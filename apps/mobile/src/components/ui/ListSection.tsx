import { MOBILE_SHAPE } from "../../lib/designTokens";
import { createContext, type ReactNode } from "react";
import { Platform, StyleSheet, View } from "react-native";

import { AppText as Text } from "./AppText";

const IOS = Platform.OS === "ios";

/** Set inside an iOS grouped section, where each row draws the hairline above itself. */
export const ListSectionSeparatorContext = createContext(false);

export function ListSection(props: {
  readonly title?: string;
  readonly titleIcon?: ReactNode;
  readonly trailing?: ReactNode;
  readonly children: ReactNode;
  readonly footer?: string;
}) {
  return (
    <View className={IOS ? "gap-1.5" : "gap-2"}>
      {props.title ? (
        <View className="flex-row items-center justify-between gap-3">
          <View className="min-w-0 flex-1 flex-row items-center gap-2 px-4">
            {props.titleIcon}
            {IOS ? (
              <Text textRole="label" className="shrink uppercase text-foreground-muted">
                {props.title}
              </Text>
            ) : (
              <Text textRole="footnote" className="shrink font-t3-medium text-foreground-muted">
                {props.title}
              </Text>
            )}
          </View>
          {props.trailing}
        </View>
      ) : null}
      <View
        className="overflow-hidden border-continuous bg-grouped-card"
        style={{
          borderRadius:
            Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios,
        }}
      >
        {IOS ? (
          // Pulls the first row's separator under the clipped top edge.
          <View style={{ marginTop: -StyleSheet.hairlineWidth }}>
            <ListSectionSeparatorContext value={true}>{props.children}</ListSectionSeparatorContext>
          </View>
        ) : (
          props.children
        )}
      </View>
      {props.footer ? (
        <Text textRole={IOS ? "label" : "footnote"} className="px-4 text-foreground-muted">
          {props.footer}
        </Text>
      ) : null}
    </View>
  );
}
