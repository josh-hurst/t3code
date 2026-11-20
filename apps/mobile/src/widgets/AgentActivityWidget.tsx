import { HStack, Image, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityLabel,
  containerBackground,
  cornerRadius,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  lineLimit,
  minimumScaleFactor,
  layoutPriority,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type {
  AgentActivityPhase,
  AgentActivityProps,
  AgentActivityRowProps,
} from "./AgentActivity";

type AgentWidgetProps = Partial<AgentActivityProps> & {
  readonly localData?: Readonly<Record<string, string>>;
};

export function AgentActivityWidget(
  props: AgentWidgetProps | undefined,
  environment: WidgetEnvironment & { showsContainerBackground?: boolean },
) {
  "widget";
  const small = environment.widgetFamily === "systemSmall";
  const accessory = environment.widgetFamily === "accessoryRectangular";
  const dark = environment.colorScheme === "dark";
  const system =
    accessory ||
    environment.widgetRenderingMode === "accented" ||
    environment.widgetRenderingMode === "vibrant" ||
    environment.isLuminanceReduced ||
    environment.showsContainerBackground === false;
  type Ink = Parameters<typeof foregroundStyle>[0];
  const primary: Ink = system
    ? { type: "hierarchical", style: "primary" }
    : dark
      ? "#F1F5EF"
      : "#182E28";
  const secondary: Ink = system
    ? { type: "hierarchical", style: "secondary" }
    : dark
      ? "#A3B6AE"
      : "#52685F";
  const phaseStyle = (phase: AgentActivityPhase) => {
    switch (phase) {
      case "waiting_for_approval":
        return {
          rank: 0,
          color: dark ? "#F7BB81" : "#9B4D1C",
          symbol: "hand.raised.fill",
          label: "Approval",
        } as const;
      case "waiting_for_input":
        return {
          rank: 0,
          color: dark ? "#F7BB81" : "#9B4D1C",
          symbol: "bubble.left.fill",
          label: "Input",
        } as const;
      case "failed":
        return {
          rank: 1,
          color: dark ? "#FFA69E" : "#AA3937",
          symbol: "exclamationmark.triangle.fill",
          label: "Failed",
        } as const;
      case "starting":
      case "running":
        return {
          rank: 2,
          color: dark ? "#89DFC1" : "#176951",
          symbol: "terminal",
          label: "Active",
        } as const;
      case "stale":
        return {
          rank: 3,
          color: dark ? "#A3B6AE" : "#52685F",
          symbol: "clock",
          label: "Out of date",
        } as const;
      case "completed":
        return {
          rank: 4,
          color: dark ? "#72DB95" : "#207540",
          symbol: "checkmark",
          label: "Done",
        } as const;
    }
  };
  const rows = [...(props?.activities ?? [])].sort(
    (a, b) => phaseStyle(a.phase).rank - phaseStyle(b.phase).rank,
  );
  const first = rows[0];
  const state = first ? phaseStyle(first.phase) : undefined;
  const multiple = rows.length > 1;
  const visible = rows.slice(0, accessory ? 2 : small ? 3 : 5);
  const shownActive = visible.filter(
    (row) => row.phase !== "completed" && row.phase !== "failed",
  ).length;
  const more = Math.max(rows.length - visible.length, (props?.activeCount ?? 0) - shownActive);
  const count =
    state?.rank === 2
      ? (props?.activeCount ?? rows.length)
      : rows.filter((row) => phaseStyle(row.phase).rank === state?.rank).length;
  const caption =
    state?.rank === 0
      ? count === 1
        ? "needs you"
        : "need you"
      : state?.rank === 1
        ? "failed"
        : state?.rank === 2
          ? "active"
          : state?.rank === 3
            ? "out of date"
            : "done";
  const accent = !system && state ? state.color : primary;
  const url = (row: AgentActivityRowProps) =>
    row.deepLink.startsWith("/") && !row.deepLink.startsWith("//")
      ? "t3code://" + row.deepLink.slice(1)
      : null;
  const firstURL = first && url(first);
  const root = [
    ...(accessory
      ? [containerBackground("clear", "widget")]
      : system
        ? []
        : [containerBackground(dark ? "#17241F" : "#ECF4EC", "widget")]),
    ...(firstURL ? [widgetURL(firstURL)] : []),
  ];
  const heading = (
    <HStack spacing={5}>
      {!small && !accessory ? (
        <Image
          systemName={state?.symbol ?? "terminal"}
          size={12}
          modifiers={[foregroundStyle(accent)]}
        />
      ) : null}
      <Text
        modifiers={[font({ size: 13, weight: "semibold" }), foregroundStyle(primary), lineLimit(1)]}
      >
        Agents
      </Text>
    </HStack>
  );
  const empty = props?.subtitle ?? "Open T3 Code to load activity";
  if (!first || !state) {
    return (
      <VStack alignment="leading" spacing={accessory ? 3 : 9} modifiers={root}>
        {heading}
        {!accessory ? <Spacer minLength={0} /> : null}
        <Text
          modifiers={[
            font({ size: accessory ? 13 : 19, weight: "semibold" }),
            foregroundStyle(primary),
            lineLimit(3),
          ]}
        >
          {empty}
        </Text>
      </VStack>
    );
  }
  const rowIcon = (row: AgentActivityRowProps, size: number) => {
    const tile = frame({ width: size, height: size });
    if (row.phase === "completed") {
      return (
        <HStack modifiers={[tile, foregroundStyle(phaseStyle("completed").color)]}>
          <Image
            systemName="checkmark"
            size={size - 1}
            modifiers={[accessibilityLabel("Completed")]}
          />
        </HStack>
      );
    }
    const icons = props?.localData;
    const uri =
      icons?.[JSON.stringify([row.environmentId, row.projectTitle, row.threadId])] ??
      icons?.[JSON.stringify([row.environmentId, row.projectTitle])];
    return uri?.startsWith("data:image/") ? (
      <Image uiImage={uri} modifiers={[resizable(), tile, cornerRadius(4)]} />
    ) : (
      <HStack modifiers={[tile, foregroundStyle(secondary)]}>
        <Image systemName={uri === "text.bubble" ? "text.bubble" : "folder"} size={size - 3} />
      </HStack>
    );
  };
  const narrow = small || accessory;
  const rowView = (row: AgentActivityRowProps) => {
    const look = phaseStyle(row.phase);
    const titleMods = [
      font({ size: accessory ? 12 : small ? 13 : 14, weight: "semibold" }),
      foregroundStyle(primary),
      lineLimit(1),
    ];
    const projectMods = [
      font({ size: accessory ? 10 : small ? 11 : 12, weight: "medium" }),
      foregroundStyle(secondary),
      lineLimit(1),
    ];
    const key = row.environmentId + "/" + row.threadId;
    const status =
      look.rank !== 2 && row.phase !== "completed" ? (
        <Image
          systemName={look.symbol}
          size={10}
          modifiers={[
            foregroundStyle(system ? primary : look.color),
            accessibilityLabel(look.label),
          ]}
        />
      ) : null;
    const content = narrow ? (
      <VStack
        key={key}
        alignment="leading"
        spacing={0}
        modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
      >
        <Text modifiers={titleMods}>{row.threadTitle}</Text>
        <HStack spacing={4}>
          {rowIcon(row, accessory ? 11 : 13)}
          <Text modifiers={projectMods}>{row.projectTitle}</Text>
          {status}
        </HStack>
      </VStack>
    ) : (
      <HStack key={key} spacing={8}>
        {rowIcon(row, 18)}
        <Text modifiers={[...titleMods, frame({ maxWidth: Infinity, alignment: "leading" })]}>
          {row.threadTitle}
        </Text>
        {status}
        <Text
          modifiers={[
            ...projectMods,
            frame({ maxWidth: 90, alignment: "trailing" }),
            fixedSize({ horizontal: true, vertical: false }),
            layoutPriority(1),
          ]}
        >
          {row.projectTitle}
        </Text>
      </HStack>
    );
    const destination = !narrow && url(row);
    return destination ? (
      <Link key={key} destination={destination}>
        {content}
      </Link>
    ) : (
      content
    );
  };
  const total = props?.activeCount ?? 0;
  const countText = total > 0 && state.rank !== 3 ? total + " active" : count + " " + caption;
  const summary = countText + (more > 0 ? " · +" + more : "");
  if (!multiple && !accessory) {
    return (
      <VStack alignment="leading" spacing={4} modifiers={root}>
        {heading}
        <Spacer minLength={0} />
        <Text
          modifiers={[
            font({ size: small ? 29 : 34, weight: "bold", design: "rounded" }),
            foregroundStyle(accent),
            lineLimit(1),
            minimumScaleFactor(0.7),
          ]}
        >
          {count} {caption}
        </Text>
        <Spacer minLength={1} />
        {rowView(first)}
      </VStack>
    );
  }
  return (
    <VStack alignment="leading" spacing={accessory ? 1 : small ? 4 : 3} modifiers={root}>
      <HStack spacing={5}>
        {accessory ? <Image systemName={state.symbol} size={11} /> : heading}
        <Spacer minLength={1} />
        <Text
          modifiers={[
            font({ size: narrow ? 11 : 12, weight: "semibold", design: "rounded" }),
            foregroundStyle(accent),
            lineLimit(1),
            minimumScaleFactor(0.8),
          ]}
        >
          {summary}
        </Text>
      </HStack>
      {visible.map(rowView)}
    </VStack>
  );
}

export default createWidget<AgentWidgetProps>("AgentActivity", AgentActivityWidget);
