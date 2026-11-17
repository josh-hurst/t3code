import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

/** Names the active filters above the list; the bar's filter button sets them. */
export function ThreadListActiveFilters(props: {
  readonly labels: ReadonlyArray<string>;
  readonly onReset: () => void;
}) {
  if (props.labels.length === 0) return null;
  return (
    <View className="flex-row items-center gap-1.5 px-9 pb-1 pt-1">
      <SymbolView
        name="line.3.horizontal.decrease.circle.fill"
        size={15}
        tintColorClassName="accent-primary-text"
        type="monochrome"
      />
      <Text numberOfLines={1} className="min-w-0 shrink text-sm text-foreground-secondary">
        {props.labels.join(" · ")}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Reset thread filters"
        hitSlop={10}
        onPress={props.onReset}
        className="ml-0.5"
      >
        <SymbolView
          name="xmark.circle.fill"
          size={15}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </View>
  );
}
