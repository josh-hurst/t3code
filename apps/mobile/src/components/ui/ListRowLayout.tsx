import { use, type ReactNode } from "react";
import { Platform, StyleSheet, useWindowDimensions, View } from "react-native";

import { cn } from "../../lib/cn";
import { AppText } from "./AppText";
import { SymbolView, type AppSymbolName } from "./AppSymbol";
import { ListSectionSeparatorContext } from "./ListSection";

const IOS = Platform.OS === "ios";
const IOS_ICON_TILE_SIZE = 30;

export interface ListRowContentProps {
  readonly icon?: AppSymbolName;
  /** On iOS, draws the icon white on a rounded tile of this color, like the Settings app. */
  readonly iconTileColor?: string;
  /** Drawn in the icon column for marks a single symbol can't express. */
  readonly leading?: ReactNode;
  readonly label: string;
  readonly description?: string;
  readonly detail?: string;
  /** Rich secondary content under the description, such as scores with emphasized values. */
  readonly meta?: ReactNode;
  readonly disabled?: boolean;
}

export function ListRowLayout({
  icon,
  iconTileColor,
  leading,
  label,
  description,
  detail,
  meta,
  disabled,
  accessory,
  tone = "default",
}: ListRowContentProps & { readonly accessory?: ReactNode; readonly tone?: "default" | "danger" }) {
  const { fontScale } = useWindowDimensions();
  const stackDetail = fontScale >= 1.5;
  const separated = use(ListSectionSeparatorContext);
  const tile = IOS && iconTileColor !== undefined && icon !== undefined;
  const leadingWidth = tile ? IOS_ICON_TILE_SIZE : icon || leading ? 24 : 0;
  const separator = separated ? (
    <View
      pointerEvents="none"
      className="absolute top-0 right-0 bg-separator"
      style={{
        left: 16 + (leadingWidth > 0 ? leadingWidth + 12 : 0),
        height: StyleSheet.hairlineWidth,
      }}
    />
  ) : null;
  const row = (
    <View
      className={cn(
        "flex-row items-center",
        IOS ? "min-h-13 gap-3 px-4 py-2.5" : "min-h-14 gap-3 px-4 py-3",
        description && (IOS ? "min-h-16" : "min-h-18"),
        disabled && "opacity-45",
      )}
    >
      {tile ? (
        <View
          className="items-center justify-center border-continuous"
          style={{
            width: IOS_ICON_TILE_SIZE,
            height: IOS_ICON_TILE_SIZE,
            borderRadius: 8,
            backgroundColor: iconTileColor,
          }}
        >
          <SymbolView name={icon} size={17} tintColor="#ffffff" type="monochrome" weight="medium" />
        </View>
      ) : icon ? (
        <View className="size-6 items-center justify-center">
          <SymbolView
            name={icon}
            size={Platform.OS === "android" ? 24 : 22}
            tintColorClassName={tone === "danger" ? "accent-danger-foreground" : "accent-icon"}
            type="monochrome"
            weight="regular"
          />
        </View>
      ) : leading ? (
        <View className="size-6 items-center justify-center">{leading}</View>
      ) : null}
      <View className={cn("min-w-0 flex-1", IOS ? "gap-0.5" : "gap-1")}>
        <AppText
          textRole="body"
          className={tone === "danger" ? "text-danger-foreground" : "text-foreground"}
        >
          {label}
        </AppText>
        {description ? (
          <AppText textRole="footnote" className="text-foreground-muted">
            {description}
          </AppText>
        ) : null}
        {meta}
        {detail && stackDetail ? (
          <AppText textRole="footnote" className="text-foreground-muted">
            {detail}
          </AppText>
        ) : null}
      </View>
      {detail && !stackDetail ? (
        <AppText
          textRole="footnote"
          className="max-w-[40%] shrink text-right text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {detail}
        </AppText>
      ) : null}
      {accessory}
    </View>
  );
  // The separator stays outside the row so a disabled row doesn't fade it.
  return separator ? (
    <View>
      {row}
      {separator}
    </View>
  ) : (
    row
  );
}
