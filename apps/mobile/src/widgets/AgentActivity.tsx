import { HStack, Image, Link, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  activityBackgroundTint,
  background,
  cornerRadius,
  fixedSize,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  minimumScaleFactor,
  padding,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import {
  createLiveActivity,
  type LiveActivityComponent,
  type LiveActivityLayout,
} from "expo-widgets";

type ProjectArtwork = Readonly<Record<string, string>>;
type LiveActivityEnvironment = Parameters<LiveActivityComponent<AgentActivityProps>>[1] & {
  readonly isDynamicIslandLimitedInWidth?: boolean;
  readonly localData?: ProjectArtwork;
};

export type AgentActivityPhase =
  | "starting"
  | "running"
  | "waiting_for_approval"
  | "waiting_for_input"
  | "completed"
  | "failed"
  | "stale";

export interface AgentActivityRowProps {
  readonly environmentId: string;
  readonly threadId: string;
  readonly projectTitle: string;
  readonly threadTitle: string;
  readonly modelTitle: string;
  readonly phase: AgentActivityPhase;
  readonly status: string;
  readonly updatedAt: string;
  readonly deepLink: string;
}

/**
 * Copy for the widget extension, which runs without the app's catalogs. Count-keyed tables hold
 * one string per count. Live Activities updated by push have none and fall back to English.
 */
export interface AgentActivityText {
  readonly outOfDate: string;
  readonly failed: string;
  readonly done: string;
  readonly workFailed: string;
  readonly workCompleted: string;
  readonly statusOutOfDate: string;
  readonly approval: string;
  readonly input: string;
  readonly noActiveAgents: string;
  readonly activeAgents: Readonly<Record<string, string>>;
  readonly active: Readonly<Record<string, string>>;
  readonly needAttention: Readonly<Record<string, string>>;
  readonly needYou: Readonly<Record<string, string>>;
}

export interface AgentActivityProps {
  readonly text?: AgentActivityText;
  readonly title: string;
  readonly subtitle: string;
  readonly activeCount: number;
  readonly updatedAt: string;
  readonly activities: ReadonlyArray<AgentActivityRowProps>;
}

// The extension evaluates the serialized function without the app's module scope.
function AgentActivity(
  props: AgentActivityProps,
  host: LiveActivityEnvironment,
): LiveActivityLayout {
  "widget";
  const dark = host.colorScheme === "dark";
  const system =
    host.widgetRenderingMode === "accented" ||
    host.widgetRenderingMode === "vibrant" ||
    host.isLuminanceReduced;
  type Ink = Parameters<typeof foregroundStyle>[0];
  const primary = { type: "hierarchical", style: "primary" } as const;
  const secondary = { type: "hierarchical", style: "secondary" } as const;
  const style = (phase: AgentActivityPhase) => {
    switch (phase) {
      case "waiting_for_approval":
        return {
          rank: 0,
          glyph: "hand.raised.fill",
          label: "Approval needed",
          light: "#9B4D1C",
          dark: "#F7BB81",
        } as const;
      case "waiting_for_input":
        return {
          rank: 0,
          glyph: "bubble.left.fill",
          label: "Input needed",
          light: "#9B4D1C",
          dark: "#F7BB81",
        } as const;
      case "failed":
        return {
          rank: 1,
          glyph: "exclamationmark.triangle.fill",
          label: "Agent failed",
          light: "#AA3937",
          dark: "#FFA69E",
        } as const;
      case "starting":
        return {
          rank: 2,
          glyph: "power",
          label: "Starting",
          light: "#176951",
          dark: "#89DFC1",
        } as const;
      case "running":
        return {
          rank: 2,
          glyph: "terminal",
          label: "Working",
          light: "#176951",
          dark: "#89DFC1",
        } as const;
      case "stale":
        return {
          rank: 3,
          glyph: "clock",
          label: props.text?.outOfDate ?? "Out of date",
          light: "#596960",
          dark: "#B7C4BD",
        } as const;
      case "completed":
        return {
          rank: 4,
          glyph: "checkmark",
          label: "Completed",
          light: "#207540",
          dark: "#72DB95",
        } as const;
    }
  };
  const phaseOf = (row: AgentActivityRowProps): AgentActivityPhase =>
    host.isStale && row.phase !== "completed" && row.phase !== "failed" ? "stale" : row.phase;
  const rows = [...(props.activities ?? [])].sort(
    (a, b) => style(phaseOf(a)).rank - style(phaseOf(b)).rank,
  );
  const first = rows[0];
  const phase = first
    ? phaseOf(first)
    : host.isStale
      ? "stale"
      : props.activeCount
        ? "running"
        : "completed";
  const focus = style(phase);
  const total = host.isStale ? 0 : props.activeCount;
  const countLabel = total ? (props.text?.active[String(total)] ?? total + " active") : focus.label;
  const accent: Ink = system ? primary : dark ? focus.dark : focus.light;
  const islandInk: Ink = system ? primary : focus.dark;
  const destination = (row?: AgentActivityRowProps) =>
    row?.deepLink.startsWith("/") && !row.deepLink.startsWith("//")
      ? "t3code://" + row.deepLink.slice(1)
      : null;
  const target = destination(first);
  const link = target ? [widgetURL(target)] : [];
  const statusSymbol = (size: number, color: Ink) => (
    <HStack modifiers={[foregroundStyle(color)]}>
      <Image systemName={focus.glyph} size={size} />
    </HStack>
  );
  const statusCount = (label: string, size: number, color: Ink, textColor = color) => (
    <HStack spacing={4}>
      {statusSymbol(size, color)}
      <Text
        modifiers={[
          font({ size, weight: "semibold", design: "rounded" }),
          foregroundStyle(textColor),
          lineLimit(1),
          minimumScaleFactor(0.8),
        ]}
      >
        {label}
      </Text>
    </HStack>
  );
  const rowIcon = (row: AgentActivityRowProps, size: number) => {
    const tile = frame({ width: size, height: size });
    if (row.phase === "completed") {
      const done = style("completed");
      return (
        <HStack modifiers={[tile, foregroundStyle(dark ? done.dark : done.light)]}>
          <Image
            systemName="checkmark"
            size={size - 1}
            modifiers={[accessibilityLabel(done.label)]}
          />
        </HStack>
      );
    }
    const icons = host.localData;
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
  const threadList = (limit: number, narrow: boolean) => {
    const visible = rows.slice(0, limit);
    if (!visible.length)
      return (
        <Text modifiers={[font({ size: 14, weight: "semibold" }), lineLimit(2)]}>
          {props.subtitle || focus.label}
        </Text>
      );
    return (
      <VStack
        alignment="leading"
        spacing={narrow ? 2 : 4}
        modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
      >
        {visible.map((row) => {
          const look = style(phaseOf(row));
          const titleMods = [
            font({ size: narrow ? 12 : 14, weight: "semibold" }),
            foregroundStyle(primary),
            lineLimit(1),
          ];
          const projectMods = [
            font({ size: narrow ? 10 : 12, weight: "medium" }),
            foregroundStyle(secondary),
            lineLimit(1),
          ];
          const status =
            look.rank !== 2 && row.phase !== "completed" ? (
              <Image
                systemName={look.glyph}
                size={10}
                modifiers={[foregroundStyle(secondary), accessibilityLabel(look.label)]}
              />
            ) : null;
          const content = narrow ? (
            <VStack
              alignment="leading"
              spacing={0}
              modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
            >
              <Text modifiers={titleMods}>{row.threadTitle}</Text>
              <HStack spacing={4}>
                {rowIcon(row, 11)}
                <Text modifiers={projectMods}>{row.projectTitle}</Text>
                {status}
              </HStack>
            </VStack>
          ) : (
            <HStack spacing={8}>
              {rowIcon(row, 17)}
              <Text modifiers={[...titleMods, frame({ maxWidth: Infinity, alignment: "leading" })]}>
                {row.threadTitle}
              </Text>
              {status}
              <Text
                modifiers={[
                  ...projectMods,
                  frame({ maxWidth: 91, alignment: "trailing" }),
                  fixedSize({ horizontal: true, vertical: false }),
                  layoutPriority(1),
                ]}
              >
                {row.projectTitle}
              </Text>
            </HStack>
          );
          const url = destination(row);
          const key = row.environmentId + "/" + row.threadId;
          return url ? (
            <Link key={key} destination={url}>
              {content}
            </Link>
          ) : (
            <HStack key={key}>{content}</HStack>
          );
        })}
      </VStack>
    );
  };
  const numberShown = rows
    .slice(0, 5)
    .filter((row) => row.phase !== "completed" && row.phase !== "failed").length;
  const more = Math.max(0, total - numberShown);
  const headerText = more > 0 ? countLabel + " · +" + more + " more" : countLabel;
  const header = (
    <HStack spacing={6}>
      <Text
        modifiers={[font({ size: 12, weight: "semibold" }), foregroundStyle(primary), lineLimit(1)]}
      >
        Agents
      </Text>
      <Spacer minLength={4} />
      {statusCount(headerText, 12, accent, secondary)}
    </HStack>
  );
  const voiceLabel = [countLabel, first?.threadTitle, first?.projectTitle]
    .filter(Boolean)
    .join(", ");
  const accessible = [accessibilityElement("ignore"), accessibilityLabel(voiceLabel)];
  const islandStatus = (size: number) =>
    total > 0 ? statusCount(String(total), size, islandInk) : statusSymbol(size + 1, islandInk);
  const compactBadge = host.isDynamicIslandLimitedInWidth
    ? []
    : [
        padding({ horizontal: 5, vertical: 2 }),
        background(system ? { type: "hierarchical", style: "quaternary" } : "#272D2B", {
          shape: "capsule",
        }),
      ];
  return {
    banner: (
      <VStack
        alignment="leading"
        spacing={9}
        modifiers={[
          padding({ vertical: 12, horizontal: 16 }),
          activityBackgroundTint(system ? null : dark ? "#17241F" : "#EEF4ED"),
          ...link,
        ]}
      >
        {header}
        {threadList(5, false)}
      </VStack>
    ),
    bannerSmall: (
      <VStack
        alignment="leading"
        spacing={2}
        modifiers={[padding({ horizontal: 8, vertical: 2 }), ...link]}
      >
        {statusCount(countLabel, 11, accent)}
        {threadList(2, true)}
      </VStack>
    ),
    compactTrailing: (
      <HStack modifiers={[...compactBadge, ...accessible, ...link]}>
        {islandStatus(host.isDynamicIslandLimitedInWidth ? 10 : 12)}
      </HStack>
    ),
    minimal: <HStack modifiers={[...accessible, ...link]}>{islandStatus(10)}</HStack>,
    expandedLeading: (
      <Text
        modifiers={[
          font({ size: 12, weight: "semibold" }),
          foregroundStyle(primary),
          padding({ leading: 5 }),
          ...link,
        ]}
      >
        Agents
      </Text>
    ),
    expandedTrailing: (
      <HStack modifiers={[padding({ trailing: 5 }), ...link]}>
        {statusCount(headerText, 12, islandInk, secondary)}
      </HStack>
    ),
    expandedBottom: (
      <VStack alignment="leading" modifiers={[padding({ horizontal: 5, vertical: 3 }), ...link]}>
        {threadList(5, false)}
      </VStack>
    ),
  };
}

export default createLiveActivity<AgentActivityProps>("AgentActivity", AgentActivity);
