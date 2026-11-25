import * as Dialog from "../../components/ui/Dialog";
import type { ThreadRowProviderInstance } from "./thread-provider-instance";
import {
  THREAD_LIST_V2_MONO_FONT as MONO_FONT,
  THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
  THREAD_LIST_V2_ROW_DIVIDERS,
  selectedThreadRowColors,
  getThreadListV2NewBranchMenuTitle,
  getThreadListV2RowAppearance,
} from "./thread-list-v2-row-appearance";
import { RowPressable } from "../../components/ui/RowPressable";
import { MOBILE_SHAPE } from "../../lib/designTokens";
import { flattenThemeColor, isDarkThemeColor, themeColorWithAlpha } from "../../lib/mobileTheme";
import { groupedListInsets } from "../../components/ui/listMetrics";

const GROUP_CARD_INSET = groupedListInsets(false).paddingHorizontal;
import { CustomSnoozeSheet } from "./CustomSnoozeSheet";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadArrangementOpenAtom } from "../../state/thread-order";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { useVisibleSecondClock } from "./use-visible-second-clock";
import type { ThreadMoveDestination } from "./threadOrder";
import type {
  EnvironmentProject,
  EnvironmentThreadShell,
} from "@t3tools/client-runtime/state/shell";
import type { EnvironmentThreadSearchMatch } from "@t3tools/client-runtime/state/thread-search";
import {
  formatWorkingDurationLabel,
  resolveThreadWorkingStartedAt,
} from "@t3tools/client-runtime/state/models";
import {
  AuthOrchestrationOperateScope,
  THREAD_SET_ASIDE_UNTIL,
  threadCardHasOpenAsk,
  type EnvironmentId,
  type EnvironmentMachineKind,
} from "@t3tools/contracts";
import { toServerClock } from "@t3tools/client-runtime/clock";
import type { SnoozePresetSetting } from "@t3tools/contracts/settings";
import { canSnooze, threadAskUnread } from "@t3tools/client-runtime/state/thread-settled";
import { nonMainlineBranchName } from "@t3tools/shared/git";
import {
  threadCardQuestionLabel,
  threadLaterLead,
  threadSettlePostponeLabel,
  threadRowLineText,
  threadWorkingLine,
} from "@t3tools/client-runtime/state/thread-zones";
import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import type { MenuAction } from "@react-native-menu/menu";
import { useNavigation } from "@react-navigation/native";
import { msg, T, useGT, useMessages } from "gt-react-native";
import { memo, useCallback, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { Platform, Pressable, Text as RNText, useWindowDimensions, View } from "react-native";
import type { SwipeableMethods } from "react-native-gesture-handler/ReanimatedSwipeable";

import type { ThreadListProvider } from "../../state/thread-list-environments";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Menu } from "../../components/ui/Menu";
import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { ProjectFavicon } from "../../components/ProjectFavicon";
import {
  ProviderIcon,
  ProviderInstanceIcon,
  providerInstanceNameLabel,
} from "../../components/ProviderIcon";
import { useNowAfter } from "../../lib/clock";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { copyThreadReference } from "../../lib/copyThreadReference";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { useEnvironmentScope } from "../../state/session";
import type { PendingNewTask } from "../../state/use-pending-new-tasks";
import {
  pendingDraftBranchNeedsRefs,
  resolvePendingDraftBranch,
} from "../../state/pending-new-tasks-model";
import { useBranches } from "../../state/queries";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";
import {
  resolveThreadPrBadgeAction,
  type ThreadPrPresentation,
} from "../../state/thread-pr-presentation";
import { useThreadPr } from "../../state/use-thread-pr";
import { useSwipeRowDormant } from "../home/swipe-row-activation";
import { ThreadSwipeable } from "../home/thread-swipe-actions";
import { buildThreadTitleRegenerationMenuItems } from "./thread-title-regeneration-menu";
import { canTurnThreadIntoProject, turnThreadIntoProject } from "./turnThreadIntoProject";
import { threadCanArchive } from "../home/threadArchive";
import { useCanShareWithGuest } from "./useCanShareWithGuest";
import {
  THREAD_LIST_V2_SETTLED_PAGE_COUNT,
  resolveThreadListV2SnoozeGateExpiryMs,
  resolveThreadListV2SnoozeMenuSelection,
  resolveThreadListV2SnoozePresets,
  threadHasUnseenCompletion,
  threadListV2LaterMenuActions,
  resolveThreadListV2Status,
  resolveThreadListV2ProviderDrivers,
  resolveThreadListV2SwipeActions,
  layoutThreadListV2RowMenuActions,
  threadListV2RowAccessibilityLabel,
  type ThreadListV2Status,
} from "./threadListV2";
import { QueuedMessageIcon } from "./queued-message-icon";
import { shouldRecedeThreadRow } from "./thread-row-emphasis";
import { ThreadSearchMatchExcerpt } from "./thread-search-match";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { PullRequestGlyph } from "../pull-requests/pullRequestGlyphs";
import { pullRequestStatus } from "../pull-requests/pullRequestStatus";

interface StatusLabel {
  // Null when the icon and timer carry the status on their own.
  readonly label: string | null;
  readonly icon: AppSymbolName;
  readonly className: string;
  readonly iconTintClassName: string;
  // Washed over the row's surface; null leaves the row untinted.
  readonly tint: string | null;
}
const STATUS_TINT = {
  warning: "#f59e0b",
  indigo: "#6366f1",
  fuchsia: "#d946ef",
  danger: "#ef4444",
  emerald: "#10b981",
} as const;
const STATUS_LABEL_BY_STATUS: Partial<Record<ThreadListV2Status, StatusLabel>> = {
  approval: {
    label: msg("Approval", { $context: "thread status, waiting for approval" }),
    icon: "exclamationmark.shield",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
    tint: STATUS_TINT.warning,
  },
  input: {
    label: msg("Input", { $context: "thread status, waiting for user input" }),
    icon: "questionmark.bubble",
    className: "text-adaptive-indigo-600-300",
    iconTintClassName: "accent-adaptive-indigo-600-300",
    tint: STATUS_TINT.indigo,
  },
  request: {
    label: msg("Request", { $context: "thread status, a guest request is waiting" }),
    icon: "person.crop.circle",
    className: "text-adaptive-fuchsia-600-300",
    iconTintClassName: "accent-adaptive-fuchsia-600-300",
    tint: STATUS_TINT.fuchsia,
  },
  working: {
    label: null,
    icon: "circle.dashed",
    className: "text-adaptive-sky-600-400",
    iconTintClassName: "accent-adaptive-sky-600-400",
    tint: null,
  },
  waiting: {
    label: null,
    icon: "circle.dashed.inset.filled",
    className: "text-foreground-muted",
    iconTintClassName: "accent-foreground-muted",
    tint: null,
  },
  failed: {
    label: msg("Failed", { $context: "thread status" }),
    icon: "exclamationmark.circle",
    className: "text-danger-foreground",
    iconTintClassName: "accent-danger-foreground",
    tint: STATUS_TINT.danger,
  },
  limited: {
    label: msg("Limited", { $context: "thread status, usage limit reached" }),
    icon: "exclamationmark.circle",
    className: "text-warning-foreground",
    iconTintClassName: "accent-warning-foreground",
    tint: STATUS_TINT.warning,
  },
};
const DONE_STATUS_LABEL: StatusLabel = {
  label: msg("Done", { $context: "thread status, turn finished" }),
  icon: "checkmark.circle",
  className: "text-adaptive-emerald-700-300",
  iconTintClassName: "accent-adaptive-emerald-700-300",
  tint: STATUS_TINT.emerald,
};
// A quiet thread inside its last hour before it settles on its own; the list sets its label.
const SETTLING_STATUS_LOOK: Omit<StatusLabel, "label"> = {
  icon: "clock",
  className: "text-foreground-muted",
  iconTintClassName: "accent-foreground-muted",
  tint: null,
};
// A History thread the server settled on its own, not the owner.
const AUTO_SETTLED_STATUS_LABEL: StatusLabel = {
  label: msg("Auto settled", { $context: "thread status, settled on its own" }),
  icon: "timer",
  className: "text-foreground-muted",
  iconTintClassName: "accent-foreground-muted",
  tint: null,
};
// A seen thread that its card's open question keeps in Needs you.
const QUESTION_STATUS_LABEL: StatusLabel = {
  label: msg("Question", { $context: "thread status, the card asks you something" }),
  icon: "questionmark.bubble",
  className: "text-adaptive-indigo-600-300",
  iconTintClassName: "accent-adaptive-indigo-600-300",
  tint: STATUS_TINT.indigo,
};

// DM Sans has no tabular figures, so a ticking timer in it reflows the row every second.
const TABULAR_DURATION_STYLE = {
  fontFamily: Platform.OS === "ios" ? "System" : "sans-serif",
  fontWeight: "700",
  fontVariant: ["tabular-nums"],
} as const;

function ThreadListV2Duration(props: {
  readonly environmentId: EnvironmentId;
  readonly startedAt: string | null;
  readonly leadingSpace: boolean;
}) {
  const messages = useMessages();
  const startedAtMs = Date.parse(props.startedAt ?? "");
  const nowMs = useVisibleSecondClock(Number.isFinite(startedAtMs));
  if (!Number.isFinite(startedAtMs)) return null;
  return (
    <>
      {props.leadingSpace ? " " : null}
      <RNText style={TABULAR_DURATION_STYLE}>
        {formatWorkingDurationLabel(
          toServerClock(props.environmentId, nowMs) - startedAtMs,
          messages,
        )}
      </RNText>
    </>
  );
}

/** A row's summary line, led by its status: an icon, the status word, then the text. */
function ThreadRowStatusLine(props: {
  readonly lead: {
    readonly icon: AppSymbolName | null;
    readonly iconTintClassName: string;
    readonly className: string;
    readonly label: ReactNode;
    readonly onPress?: () => void;
    readonly accessibilityLabel?: string;
  } | null;
  readonly text: string | null;
  readonly textClassName: string;
  readonly numberOfLines: number;
  readonly lineHeight: number;
}) {
  const lead = props.lead;
  return (
    <View className="flex-row items-start gap-1">
      {lead?.icon ? (
        <Pressable
          disabled={lead.onPress === undefined}
          accessibilityRole={lead.onPress ? "button" : undefined}
          accessibilityLabel={lead.accessibilityLabel}
          hitSlop={8}
          onPress={lead.onPress}
          onLongPress={lead.onPress ? () => undefined : undefined}
          className="justify-center"
          style={{ height: props.lineHeight }}
        >
          <SymbolView
            name={lead.icon}
            size={Math.round(props.lineHeight * 0.68)}
            tintColorClassName={lead.iconTintClassName}
            type="monochrome"
            weight="semibold"
          />
        </Pressable>
      ) : null}
      <Text
        className={cn("min-w-0 flex-1 text-sm", props.textClassName)}
        numberOfLines={props.numberOfLines}
      >
        {lead ? (
          <Text className={cn("font-t3-semibold", lead.className)} onPress={lead.onPress}>
            {lead.label}
          </Text>
        ) : null}
        {lead && props.text ? " · " : null}
        {props.text}
      </Text>
    </View>
  );
}

const CARD_MENU_ACTIONS: MenuAction[] = [
  { id: "settle", title: msg("Settle", { $context: "verb, thread action" }), image: "checkmark" },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const SLIM_MENU_ACTIONS: MenuAction[] = [
  {
    id: "unsettle",
    title: msg("Un-settle", { $context: "verb, thread action" }),
    image: "arrow.uturn.backward",
  },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const SNOOZED_MENU_ACTIONS: MenuAction[] = [
  { id: "unsnooze", title: msg("Wake thread"), image: "clock" },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const LEGACY_MENU_ACTIONS: MenuAction[] = [
  {
    id: "archive",
    title: msg("Archive", { $context: "verb, thread action" }),
    image: "archivebox",
  },
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

function ThreadListV2Section(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
  readonly tone?: "default" | "snoozed";
  readonly spacedAbove?: boolean;
  readonly disclosure?: {
    readonly expanded: boolean;
    readonly disabled?: boolean;
    readonly onToggle: () => void;
    readonly accessibilityLabel: string;
    readonly accessibilityHint: string;
  };
  readonly action?: {
    readonly label: string;
    readonly accessibilityLabel: string;
    readonly disabled?: boolean;
    readonly onPress: () => void;
  };
}) {
  const snoozed = props.tone === "snoozed";
  const sidebarPane = props.pane === "sidebar";
  // A full-width list labels each card like a grouped list: small caps over the card, in line
  // with the rows' text. The sidebar keeps its quiet label and rule.
  const heading = !sidebarPane;
  const className = cn(
    "flex-row items-center gap-1.5",
    "mb-1.5",
    props.spacedAbove ? "mt-8" : heading ? "mt-5" : "mt-4",
    props.pane === "sidebar" ? "px-3" : "px-9",
  );
  const content = (
    <>
      <Text
        className={cn(
          heading
            ? "text-xs uppercase text-foreground-muted"
            : "text-xs font-t3-medium text-drawer-foreground-muted",
        )}
      >
        {props.label}
      </Text>
      {props.disclosure ? (
        <SymbolView
          name="chevron.down"
          size={10}
          tintColorClassName={
            sidebarPane
              ? "accent-drawer-foreground-muted"
              : snoozed
                ? "accent-icon-muted"
                : "accent-foreground-muted"
          }
          type="monochrome"
          weight={heading ? "medium" : undefined}
          style={{ transform: [{ rotate: props.disclosure.expanded ? "180deg" : "0deg" }] }}
        />
      ) : null}
      {heading ? (
        <View className="flex-1" />
      ) : (
        <View className={cn("h-px flex-1", snoozed ? "bg-primary/20" : "bg-drawer-border")} />
      )}
    </>
  );

  const disclosure = props.disclosure;
  const toggle = (className: string) =>
    disclosure ? (
      <Pressable
        accessibilityHint={disclosure.accessibilityHint}
        accessibilityLabel={disclosure.accessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ disabled: disclosure.disabled, expanded: disclosure.expanded }}
        className={className}
        disabled={disclosure.disabled}
        onPress={disclosure.onToggle}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        {content}
      </Pressable>
    ) : null;

  if (props.action) {
    const action = props.action;
    return (
      <View className={className}>
        {/* The label still folds the section; the action sits beside it. */}
        {toggle("min-w-0 flex-1 flex-row items-center gap-2.5") ?? content}
        <Pressable
          accessibilityLabel={action.accessibilityLabel}
          accessibilityRole="button"
          accessibilityState={{ disabled: action.disabled }}
          disabled={action.disabled}
          hitSlop={8}
          onPress={action.onPress}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <Text
            className={
              sidebarPane
                ? "text-xs font-t3-medium text-drawer-foreground-muted"
                : "text-sm text-primary-text"
            }
          >
            {action.label}
          </Text>
        </Pressable>
      </View>
    );
  }

  return toggle(className) ?? <View className={className}>{content}</View>;
}

const ThreadListV2SectionDivider = memo(function ThreadListV2SectionDivider(props: {
  readonly label: string;
  readonly pane?: "screen" | "sidebar";
}) {
  return <ThreadListV2Section {...props} />;
});

type ThreadListV2ShelfHeaderProps = {
  /** Replaces the shelf's own name, such as "Later" for the snoozed shelf. */
  readonly label?: string;
  /** A trailing action beside the fold, such as History's "All". */
  readonly action?: {
    readonly label: string;
    readonly accessibilityLabel: string;
    readonly onPress: () => void;
  };
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
  readonly spacedAbove?: boolean;
};

const SHELF_COPY = {
  working: {
    label: msg("Working", { $context: "thread list section" }),
    count: msg("{count, plural, one {{count} working thread} other {{count} working threads}}"),
    collapse: msg("Collapses the working threads."),
    expand: msg("Expands the working threads."),
  },
  snoozed: {
    label: msg("Snoozed", { $context: "thread list section" }),
    count: msg("{count, plural, one {{count} snoozed thread} other {{count} snoozed threads}}"),
    collapse: msg("Collapses the snoozed threads."),
    expand: msg("Expands the snoozed threads."),
  },
  settled: {
    label: msg("Settled", { $context: "thread list section" }),
    count: msg("{count, plural, one {{count} settled thread} other {{count} settled threads}}"),
    collapse: msg("Collapses the settled threads."),
    expand: msg("Expands the settled threads."),
  },
} as const;

function ThreadListV2ShelfHeader(
  props: ThreadListV2ShelfHeaderProps & { readonly kind: keyof typeof SHELF_COPY },
) {
  const gt = useGT();
  const m = useMessages();
  const copy = SHELF_COPY[props.kind];
  const label = props.label ?? m(copy.label);
  return (
    <ThreadListV2Section
      label={props.expanded ? label : gt("{label} ({count})", { label, count: props.count })}
      pane={props.pane}
      tone={props.kind === "snoozed" ? "snoozed" : "default"}
      spacedAbove={props.spacedAbove}
      disclosure={{
        expanded: props.expanded,
        disabled: props.disabled,
        onToggle: props.onToggle,
        accessibilityLabel: m(copy.count, { count: props.count }),
        accessibilityHint: m(props.expanded ? copy.collapse : copy.expand),
      }}
      {...(props.action === undefined
        ? {}
        : { action: { ...props.action, disabled: props.disabled } })}
    />
  );
}

export const ThreadListV2WorkingShelfHeader = memo(function ThreadListV2WorkingShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="working" />;
});

export const ThreadListV2SnoozedShelfHeader = memo(function ThreadListV2SnoozedShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="snoozed" />;
});

/** History's "All": every topic across threads, on its own screen. */
export const historyAllAction = (onPress: () => void) => ({
  label: "All",
  accessibilityLabel: "Open History, every topic across threads",
  onPress,
});

export const ThreadListV2SettledShelfHeader = memo(function ThreadListV2SettledShelfHeader(
  props: ThreadListV2ShelfHeaderProps,
) {
  return <ThreadListV2ShelfHeader {...props} kind="settled" />;
});

/** A section that does not fold, such as Needs you, with an optional Clear. */
export const ThreadListV2SectionHeader = memo(function ThreadListV2SectionHeader(props: {
  readonly title: string;
  readonly count: number;
  readonly disabled?: boolean;
  readonly onClear?: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const gt = useGT();
  const onClear = props.onClear;
  const label = props.title === "By meaning" ? gt("By meaning") : props.title;
  return (
    <ThreadListV2Section
      label={label}
      pane={props.pane}
      {...(onClear === undefined
        ? {}
        : {
            action: {
              label: "Clear",
              accessibilityLabel: `Clear ${label}, settling its threads except the open one`,
              disabled: props.disabled,
              onPress: onClear,
            },
          })}
    />
  );
});

export const ThreadListV2TrailMoreRow = memo(function ThreadListV2TrailMoreRow(props: {
  readonly label: string;
  readonly expanded: boolean;
  readonly disabled?: boolean;
  readonly onToggle: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const sidebarPane = props.pane === "sidebar";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: props.disabled, expanded: props.expanded }}
      disabled={props.disabled}
      onPress={props.onToggle}
      className={cn("flex-row items-center gap-2 py-2.5", sidebarPane ? "px-3" : "px-9")}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name="chevron.down"
        size={10}
        tintColorClassName={
          sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
        }
        type="monochrome"
        style={{ transform: [{ rotate: props.expanded ? "180deg" : "0deg" }] }}
      />
      <Text
        className={cn(
          "text-sm",
          sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
});

export const ThreadListV2SettledAwayRow = memo(function ThreadListV2SettledAwayRow(props: {
  readonly titles: ReadonlyArray<string>;
  readonly disabled?: boolean;
  readonly onShow: () => void;
  readonly onUndo: () => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const gt = useGT();
  const sidebarPane = props.pane === "sidebar";
  const label =
    props.titles.length === 1
      ? gt("Settled “{title}” while you were away", { title: props.titles[0]! })
      : gt(
          "{count, plural, one {Settled {count} while you were away} other {Settled {count} while you were away}}",
          { count: props.titles.length },
        );
  return (
    <View className={cn("flex-row items-center gap-2 py-2.5", sidebarPane ? "px-3" : "px-9")}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.titles.length === 1 ? label : [label, ...props.titles].join(", ")}
        accessibilityHint={gt("Show in History")}
        disabled={props.disabled}
        onPress={props.onShow}
        className="min-w-0 flex-1 flex-row items-center gap-2"
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <SymbolView
          name="checkmark.circle"
          size={12}
          tintColorClassName={
            sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
          }
          type="monochrome"
        />
        <Text
          numberOfLines={1}
          className={cn(
            "flex-1 text-sm",
            sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
          )}
        >
          {label}
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        disabled={props.disabled}
        onPress={props.onUndo}
        hitSlop={8}
        style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
      >
        <Text
          className={cn(
            "text-sm font-medium",
            sidebarPane ? "text-drawer-foreground" : "text-foreground",
          )}
        >
          {gt("Undo")}
        </Text>
      </Pressable>
    </View>
  );
});

export const ThreadListV2FolderHeader = memo(function ThreadListV2FolderHeader(props: {
  readonly folderKey: string;
  readonly title: string;
  readonly count: number;
  readonly disabled?: boolean;
  readonly expanded: boolean;
  readonly onToggle: (folderKey: string) => void;
  readonly pane?: "screen" | "sidebar";
}) {
  const { folderKey, onToggle } = props;
  return (
    <ThreadListV2Section
      label={props.expanded ? props.title : `${props.title} (${props.count})`}
      pane={props.pane}
      disclosure={{
        expanded: props.expanded,
        disabled: props.disabled,
        onToggle: () => onToggle(folderKey),
        accessibilityLabel: `${props.title}, ${props.count} ${props.count === 1 ? "thread" : "threads"}`,
        accessibilityHint: `${props.expanded ? "Collapses" : "Expands"} the project's threads.`,
      }}
    />
  );
});

export const ThreadListV2ShowMoreRow = memo(function ThreadListV2ShowMoreRow(props: {
  readonly pane?: "screen" | "sidebar";
  readonly hiddenCount: number;
  /** Older settled threads are loading, or their last read failed. */
  readonly state?: "loading" | "failed";
  readonly onPress: () => void;
}) {
  const gt = useGT();
  const label =
    props.state === "loading"
      ? gt("Loading", { $context: "older threads are loading" })
      : props.state === "failed"
        ? gt("Could not load older threads. Retry")
        : gt(
            "{count, plural, one {Show more ({count} settled hidden)} other {Show more ({count} settled hidden)}}",
            { count: props.hiddenCount },
          );
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        props.state === undefined
          ? gt(
              "{count, plural, one {Show {count} more settled threads} other {Show {count} more settled threads}}",
              {
                count: Math.min(props.hiddenCount, THREAD_LIST_V2_SETTLED_PAGE_COUNT),
              },
            )
          : label
      }
      disabled={props.state === "loading"}
      onPress={props.onPress}
      className={cn("flex-row items-center py-2.5", props.pane === "sidebar" ? "px-3" : "px-9")}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <Text
        className={cn(
          "text-sm",
          props.pane === "sidebar" ? "text-drawer-foreground-muted" : "text-foreground-muted",
        )}
      >
        {label}
      </Text>
    </Pressable>
  );
});

const PENDING_TASK_MENU_ACTIONS: MenuAction[] = [
  {
    id: "delete",
    title: msg("Delete", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

const DRAFT_TASK_MENU_ACTIONS: MenuAction[] = [
  {
    id: "delete",
    title: msg("Discard", { $context: "verb, thread action" }),
    image: "trash",
    attributes: { destructive: true },
  },
];

export const ThreadListV2PendingRow = memo(function ThreadListV2PendingRow(props: {
  readonly pendingTask: PendingNewTask;
  readonly selected?: boolean;
  readonly project: EnvironmentProject | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showPendingDivider: boolean;
  readonly showTrailingDivider?: boolean;
  readonly onSelectPendingTask: (pendingTask: PendingNewTask) => void;
  readonly onDeletePendingTask: (pendingTask: PendingNewTask) => void;
  readonly fullSwipeWidth?: number;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { pendingTask, onSelectPendingTask, onDeletePendingTask } = props;
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const titleTypography = useScaledTextRole("body");
  const metadataTypography = useScaledTextRole("label");
  const projectIconSize = titleTypography.fontSize * 1.25 * fontScale;
  const machineIconSize = metadataTypography.fontSize * fontScale;
  // Android's nonlinear system text scaling can differ from the fontScale estimate.
  const [androidTitleLineHeight, setTitleLineHeight] = useState(
    titleTypography.lineHeight * fontScale,
  );
  const titleLineHeight =
    Platform.OS === "android" ? androidTitleLineHeight : titleTypography.lineHeight * fontScale;
  const dormant = useSwipeRowDormant(props.activationKey);
  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected ?? false;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);
  const gt = useGT();
  const m = useMessages();
  const isDraft = pendingTask.kind === "draft";
  const deleteLabel = isDraft
    ? gt("Discard", { $context: "verb, thread action" })
    : gt("Delete", { $context: "verb, thread action" });
  const handleDelete = useCallback(
    () => onDeletePendingTask(pendingTask),
    [onDeletePendingTask, pendingTask],
  );
  const deleteAction = useMemo(
    () => ({
      accessibilityLabel: isDraft
        ? gt("Discard {title}", { title: pendingTask.title })
        : gt("Delete {title}", { title: pendingTask.title }),
      destructive: true,
      icon: "trash" as const,
      label: deleteLabel,
      onPress: handleDelete,
    }),
    [deleteLabel, gt, handleDelete, isDraft, pendingTask.title],
  );
  const projectCwd = props.project?.workspaceRoot || null;
  // Drafts only; the reads are shared per-project atoms, and queued rows skip them.
  const projectDefaults = useNewTaskProjectDefaults(isDraft ? props.project : null);
  const draftDefaults = {
    canChooseWorkspace: !projectDefaults.isScratch,
    defaultMode: projectDefaults.defaultWorkspaceMode,
    defaultModeSettled: projectDefaults.defaultWorkspaceModeSettled,
  };
  const draftBranchRefs = useBranches({
    environmentId: pendingTask.environmentId,
    cwd:
      isDraft && pendingDraftBranchNeedsRefs(pendingTask.draft, draftDefaults) ? projectCwd : null,
  });
  const branch = isDraft
    ? resolvePendingDraftBranch({
        draft: pendingTask.draft,
        defaults: draftDefaults,
        isGitRepo: draftBranchRefs.data?.isRepo ?? true,
        branches: draftBranchRefs.data?.refs ?? [],
        projectCwd,
      })
    : pendingTask.branch;

  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "delete") onDeletePendingTask(pendingTask);
    },
    [onDeletePendingTask, pendingTask],
  );

  const titleTextInset = props.project ? projectIconSize + 8 : 0;
  const rowContent = (
    <>
      <View className="flex-row items-start gap-2">
        {props.project ? (
          <View className="justify-center" style={{ height: titleLineHeight }}>
            <ProjectFavicon
              environmentId={pendingTask.environmentId}
              faviconPath={props.project.faviconPath}
              projectIcon={props.project.projectIcon}
              size={projectIconSize}
              projectTitle={props.project.title}
              workspaceRoot={props.project.workspaceRoot}
            />
          </View>
        ) : null}
        <Text
          className={cn(
            "flex-1 text-base font-t3-medium",
            selected
              ? selectedThreadRowColors.foregroundClassName
              : rowAppearance.foregroundClassName,
          )}
          numberOfLines={2}
          onTextLayout={
            Platform.OS === "android"
              ? ({ nativeEvent }) => {
                  const firstLine = nativeEvent.lines[0];
                  if (firstLine && Math.abs(firstLine.height - titleLineHeight) > 0.5) {
                    setTitleLineHeight(firstLine.height);
                  }
                }
              : undefined
          }
        >
          {pendingTask.title}
        </Text>
        {isDraft ? (
          <View className="flex-row items-center gap-1" style={{ minHeight: titleLineHeight }}>
            <SymbolView
              name="square.and.pencil"
              size={13}
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.iconTintClassName
                  : "accent-adaptive-amber-700-300"
              }
              type="monochrome"
              weight="semibold"
            />
            <Text
              className={cn(
                "text-xs font-t3-bold",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : "text-adaptive-amber-700-300",
              )}
            >
              <T>Draft</T>
            </Text>
          </View>
        ) : null}
      </View>
      {!isDraft ? (
        <View className="mt-1" style={{ paddingLeft: titleTextInset }}>
          <Text
            className={cn(
              "text-xs",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : rowAppearance.tertiaryForegroundClassName,
            )}
          >
            <T>Sends on reconnect</T>
          </Text>
        </View>
      ) : null}
      {branch || props.environmentLabel ? (
        <View className="mt-1 flex-row items-center gap-1" style={{ paddingLeft: titleTextInset }}>
          {props.environmentLabel && props.environmentMachine ? (
            <EnvironmentMachineSymbol
              kind={props.environmentMachine}
              size={machineIconSize}
              tintColorClassName={
                selected
                  ? selectedThreadRowColors.mutedIconTintClassName
                  : rowAppearance.tertiaryIconTintClassName
              }
            />
          ) : null}
          <Text
            className={cn(
              "shrink text-xs text-foreground-muted",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : rowAppearance.mutedForegroundClassName,
            )}
            numberOfLines={1}
          >
            {branch ? (
              <Text
                className={cn(
                  "text-xs",
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.mutedForegroundClassName,
                )}
                style={{ fontFamily: MONO_FONT }}
              >
                {branch}
              </Text>
            ) : null}
            {branch && props.environmentLabel ? "  ·  " : null}
            {props.environmentLabel ? (
              <Text
                className={cn(
                  "text-xs",
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.tertiaryForegroundClassName,
                )}
              >
                {props.environmentLabel}
              </Text>
            ) : null}
          </Text>
        </View>
      ) : null}
    </>
  );

  return (
    <>
      {props.showPendingDivider ? (
        <ThreadListV2SectionDivider
          label={gt("Unsent", { $context: "section of tasks not yet sent" })}
          pane={props.pane}
        />
      ) : null}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={pendingTask.key}
        backgroundColor={rowAppearance.swipeBackgroundColor}
        containerStyle={rowAppearance.swipeContainerStyle}
        enableTrackpadSwipe
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        listAnimatesLayout
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={deleteAction}
        secondaryAction={null}
        resetKey={pendingTask.key}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={pendingTask.title}
      >
        {() => (
          <Menu
            actions={(isDraft ? DRAFT_TASK_MENU_ACTIONS : PENDING_TASK_MENU_ACTIONS).map(
              (action) => ({
                ...action,
                title: m(action.title),
              }),
            )}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            <RowPressable
              accessibilityHint={
                isDraft
                  ? gt("Opens the draft in the new task composer. Swipe left to discard.")
                  : gt(
                      "Sends when the environment reconnects. Opens the task for editing. Swipe left to delete.",
                    )
              }
              accessibilityLabel={pendingTask.title}
              accessibilityRole="button"
              accessibilityState={{ selected: props.selected ?? false }}
              key={pendingTask.key}
              className={rowAppearance.className}
              interactionClassName={rowAppearance.interactionClassName}
              interactionOpacity={rowAppearance.interactionOpacity}
              onPress={() => onSelectPendingTask(pendingTask)}
              style={rowAppearance.cardStyle}
            >
              {sidebarPane ? (
                rowContent
              ) : (
                <View>
                  <View className={THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME}>{rowContent}</View>
                  {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
                    <View className="ml-5 h-px bg-border-subtle" />
                  ) : null}
                </View>
              )}
            </RowPressable>
          </Menu>
        )}
      </ThreadSwipeable>
    </>
  );
});

export const ThreadListV2Row = memo(function ThreadListV2Row(props: {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  /** Shown under the title; null keeps the row as it is without a card. */
  readonly cardLine?: string | null;
  /** A slim row's project, on its own line above the title. */
  readonly projectLine?: string | null;
  /** "Settling soon" or its countdown, in a quiet row's last hour before it settles. */
  readonly settlingLabel?: string;
  /** The self-filing list, where card rows share the slim rows' anatomy. */
  readonly selfFiling?: boolean;
  /** A Needs you row, whose card takes the primary tint as on web. */
  readonly needsYou?: boolean;
  /** First and last rows of a run, which round its grouped card. */
  readonly groupStart?: boolean;
  readonly groupEnd?: boolean;
  readonly hasQueuedMessages?: boolean;
  readonly snoozed?: boolean;
  readonly pinned?: boolean;
  readonly wokeAt: string | null;
  readonly snoozeWakeLabelText?: string;
  readonly timeLabel: string;
  readonly snoozePresetMinute: string;
  readonly project: EnvironmentProject | null;
  readonly providers: ReadonlyArray<ThreadListProvider> | undefined;
  readonly providerInstance: ThreadRowProviderInstance | null;
  readonly environmentLabel: string | null;
  readonly environmentMachine?: EnvironmentMachineKind;
  readonly pane?: "screen" | "sidebar";
  readonly showTrailingDivider?: boolean;
  readonly selected?: boolean;
  readonly fullSwipeWidth?: number;
  readonly onSelectThread: (thread: EnvironmentThreadShell) => void;
  readonly onOpenThreadPullRequests: (
    thread: EnvironmentThreadShell,
    pr: ThreadPrPresentation,
  ) => void;
  readonly onDeleteThread: (thread: EnvironmentThreadShell) => void;
  readonly onNewThreadOnBranch: (thread: EnvironmentThreadShell) => void;
  readonly onRenameThread: (thread: EnvironmentThreadShell) => void;
  readonly onRegenerateThreadTitle: (thread: EnvironmentThreadShell) => void;
  readonly onSettleThread: (thread: EnvironmentThreadShell) => Promise<boolean>;
  readonly onSnoozeThread: (thread: EnvironmentThreadShell, snoozedUntil: string) => void;
  readonly onUnsnoozeThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnsettleThread: (thread: EnvironmentThreadShell) => void;
  readonly onArchiveThread: (thread: EnvironmentThreadShell) => void;
  readonly onPinThread: (thread: EnvironmentThreadShell) => void;
  readonly onUnpinThread: (thread: EnvironmentThreadShell) => void;
  readonly onSetThreadAutoSettle: (
    thread: EnvironmentThreadShell,
    enabled: boolean,
    options?: { readonly postpone?: boolean },
  ) => void;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
  readonly snoozePresets: ReadonlyArray<SnoozePresetSetting> | undefined;
  readonly pinningSupported: boolean;
  readonly autoSettleOptOutSupported: boolean;
  readonly titleRegenerationSupported: boolean;
  readonly reorderSupported?: boolean;
  readonly onMoveThread?: (
    thread: EnvironmentThreadShell,
    direction: ThreadMoveDestination,
  ) => void;
  readonly canMoveUp?: boolean;
  readonly canMoveDown?: boolean;
  readonly onSwipeableWillOpen: (methods: SwipeableMethods) => void;
  readonly onSwipeableClose: (methods: SwipeableMethods) => void;
  readonly activationKey?: string;
  readonly searchMatch?: EnvironmentThreadSearchMatch;
  readonly searchQuery?: string;
  readonly simultaneousSwipeGesture?: ComponentProps<typeof ThreadSwipeable>["simultaneousWith"];
}) {
  const { width: windowWidth, fontScale } = useWindowDimensions();
  const titleTypography = useScaledTextRole("body");
  const metadataTypography = useScaledTextRole("label");
  const summaryLineHeight = useScaledTextRole("footnote").lineHeight * fontScale;
  const projectIconSize = titleTypography.fontSize * 1.25 * fontScale;
  const machineIconSize = metadataTypography.fontSize * fontScale;
  // Android's nonlinear system text scaling can differ from the fontScale estimate.
  const [androidTitleLineHeight, setTitleLineHeight] = useState(
    titleTypography.lineHeight * fontScale,
  );
  const titleLineHeight =
    Platform.OS === "android" ? androidTitleLineHeight : titleTypography.lineHeight * fontScale;
  const gt = useGT();
  const m = useMessages();
  const {
    thread,
    variant,
    onSelectThread,
    onOpenThreadPullRequests,
    onDeleteThread,
    onRenameThread,
    onRegenerateThreadTitle,
    onNewThreadOnBranch,
    onSettleThread,
    onSnoozeThread,
    onUnsnoozeThread,
    onUnsettleThread,
    onArchiveThread,
    onPinThread,
    onUnpinThread,
    onSetThreadAutoSettle,
    onMoveThread,
  } = props;
  const snoozedRow = props.snoozed === true;
  const pinnedRow = props.pinned === true;
  const workingLine = snoozedRow ? null : threadWorkingLine(thread);
  const cardLine = workingLine ?? props.cardLine ?? null;
  const projectLine = props.projectLine ?? null;
  const dormant = useSwipeRowDormant(props.activationKey);

  const selectThread = () => onSelectThread(thread);
  const { providerDrivers, providerIconUrl } = useMemo(() => {
    const provider = props.providers?.find(
      (candidate) =>
        candidate.instanceId ===
        (thread.runtime?.providerInstanceId ?? thread.modelSelection.instanceId),
    );
    return {
      providerDrivers: resolveThreadListV2ProviderDrivers(thread, props.providers),
      providerIconUrl: provider?.iconUrl,
    };
  }, [thread, props.providers]);

  const providerInstance = props.providerInstance;
  const providerNameLabel = providerInstance
    ? providerInstanceNameLabel({
        provider: providerInstance.driverKind,
        iconUrl: providerIconUrl,
        displayName: providerInstance.displayName,
        showBadge: providerInstance.showBadge,
      })
    : null;
  const pr = useThreadPr(thread);
  const prBadgeLabel = pr ? resolveThreadPrBadgeAction(pr, m).accessibilityLabel : null;
  const handleOpenPullRequests = useCallback(() => {
    if (pr) onOpenThreadPullRequests(thread, pr);
  }, [onOpenThreadPullRequests, pr, thread]);

  const theme = useUniwindTheme();
  const sidebarPane = props.pane === "sidebar";
  const selected = props.selected === true;
  const rowAppearance = getThreadListV2RowAppearance(theme, sidebarPane, selected);
  // The full-width self-filing list sets each section's rows on a raised card.
  const grouped = props.selfFiling === true && !sidebarPane;
  const groupRadius =
    Platform.OS === "android" ? MOBILE_SHAPE.group.android : MOBILE_SHAPE.group.ios;
  const groupStartRadius = props.groupStart === true ? groupRadius : 0;
  const groupEndRadius = props.groupEnd === true ? groupRadius : 0;
  const swipeContainerStyle = grouped
    ? {
        marginHorizontal: GROUP_CARD_INSET,
        overflow: "hidden" as const,
        borderCurve: "continuous" as const,
        borderTopLeftRadius: groupStartRadius,
        borderTopRightRadius: groupStartRadius,
        borderBottomLeftRadius: groupEndRadius,
        borderBottomRightRadius: groupEndRadius,
      }
    : rowAppearance.swipeContainerStyle;
  // The Needs you card takes the primary tint, as on web.
  const screenIsDark = isDarkThemeColor(theme["--color-screen"]);
  const needsYouTint =
    grouped && props.needsYou === true
      ? screenIsDark
        ? flattenThemeColor(
            themeColorWithAlpha(theme["--color-primary"], 0.15),
            theme["--color-grouped-card"],
          )
        : // The deep primary reads lavender as a pale wash, so light mode uses a brighter blue.
          flattenThemeColor(themeColorWithAlpha("#2f6bff", 0.12), "#ffffff")
      : null;

  const status = resolveThreadListV2Status(thread);
  const isUnread = status === "ready" && threadHasUnseenCompletion(thread);
  const workingLabel = STATUS_LABEL_BY_STATUS[status];
  const showsWoke = status === "ready" && props.wokeAt !== null;
  const settlingLabel = status === "ready" ? props.settlingLabel : undefined;
  const settling = settlingLabel !== undefined;
  const settlingEntry = settling ? { ...SETTLING_STATUS_LOOK, label: settlingLabel } : undefined;
  const autoSettled =
    status === "ready" && thread.settledOverride === "settled" && Boolean(thread.autoSettledAt);
  const statusEntry =
    (status === "working" && workingLabel !== undefined && thread.goal?.status === "active"
      ? {
          ...workingLabel,
          label: msg("Goal", { $context: "thread status, working toward a goal" }),
        }
      : workingLabel) ??
    // Auto settled in History; then an unread question, then Done; a read question below both.
    (autoSettled
      ? AUTO_SETTLED_STATUS_LABEL
      : status === "ready" && threadAskUnread(thread)
        ? QUESTION_STATUS_LABEL
        : isUnread
          ? DONE_STATUS_LABEL
          : status === "ready" && threadCardHasOpenAsk(thread.card)
            ? QUESTION_STATUS_LABEL
            : settlingEntry);
  const statusLabel = statusEntry && {
    ...statusEntry,
    label: statusEntry.label === null ? null : m(statusEntry.label),
  };
  const recede = shouldRecedeThreadRow({ status, selected });
  const statusTint = selected
    ? null
    : showsWoke
      ? STATUS_TINT.warning
      : (statusEntry?.tint ?? null);
  const rowTint =
    statusTint === null
      ? needsYouTint
      : flattenThemeColor(
          themeColorWithAlpha(statusTint, screenIsDark ? 0.14 : 0.08),
          needsYouTint ??
            (grouped ? theme["--color-grouped-card"] : rowAppearance.swipeBackgroundColor),
        );
  const rowSurfaceClassName =
    rowTint !== null ? undefined : grouped ? "bg-grouped-card" : rowAppearance.className;
  const showsDone =
    statusEntry === DONE_STATUS_LABEL &&
    !showsWoke &&
    (variant === "card" || (!snoozedRow && thread.settledOverride !== "settled"));
  const hasLaterLead = snoozedRow && threadLaterLead(thread, { recheckLimit: null }) !== null;
  // Slim rows lead with a question, an about-to-settle countdown, or Auto settled in History.
  const showsSlimStatus =
    props.selfFiling === true &&
    !showsDone &&
    !hasLaterLead &&
    statusEntry !== undefined &&
    (statusEntry === QUESTION_STATUS_LABEL ||
      statusEntry === settlingEntry ||
      statusEntry === AUTO_SETTLED_STATUS_LABEL);
  const isRegeneratingTitle = thread.titleRegeneration != null;
  // List items keep marked text so they stay the same objects across a language switch.
  const timeLabel = props.timeLabel && m(props.timeLabel);
  const snoozeWakeLabelText =
    props.snoozeWakeLabelText === undefined ? undefined : m(props.snoozeWakeLabelText);
  const rowAccessibilityLabel = threadListV2RowAccessibilityLabel(
    {
      title: workingLine ? `${thread.title}, ${workingLine}` : thread.title,
      variant,
      woke: showsWoke,
      // Working and waiting rows show only an icon and a duration, so name them for speech.
      // Done is read only where the row shows it.
      statusLabel:
        statusEntry === DONE_STATUS_LABEL && !showsDone
          ? undefined
          : statusLabel &&
            (statusLabel.label ??
              (status === "waiting"
                ? gt("Waiting", { $context: "thread status" })
                : gt("Working", { $context: "thread status" }))),
      timeLabel,
      snoozeWakeLabel: snoozedRow ? snoozeWakeLabelText : undefined,
      providerNameLabel,
      hasQueuedMessages: props.hasQueuedMessages === true,
      regeneratingTitle: isRegeneratingTitle,
    },
    m,
  );

  const visitThread = useAtomCommand(threadEnvironment.visit, { reportFailure: false });
  const clearFollowUp = useAtomCommand(threadEnvironment.clearFollowUp, {
    label: "cancel re-check",
  });
  const setStandingCheck = useAtomCommand(threadEnvironment.setStandingCheck, {
    label: "stop standing check",
  });
  const markThreadUnread = useAtomCommand(threadEnvironment.markUnread, { reportFailure: false });
  const handleAcknowledgeWoke = useCallback(() => {
    if (props.wokeAt === null) return;
    void visitThread({
      environmentId: thread.environmentId,
      input: { threadId: thread.id, visitedAt: props.wokeAt },
    });
  }, [props.wokeAt, thread.environmentId, thread.id, visitThread]);
  // VoiceOver cannot focus buttons inside the accessible row.
  const rowAccessibilityActions = useMemo(
    () => [
      ...(prBadgeLabel ? [{ name: "openPullRequests", label: prBadgeLabel }] : []),
      ...(showsWoke ? [{ name: "dismissWoke", label: gt("Dismiss Woke notification") }] : []),
    ],
    [gt, prBadgeLabel, showsWoke],
  );

  const handleDelete = useCallback(() => onDeleteThread(thread), [onDeleteThread, thread]);
  const handleRename = useCallback(() => onRenameThread(thread), [onRenameThread, thread]);
  const canOperateThread = useEnvironmentScope(thread.environmentId, AuthOrchestrationOperateScope);
  const canShareWithGuest = useCanShareWithGuest(thread.environmentId);
  const navigation = useNavigation();
  const handleRegenerateTitle = useCallback(
    () => onRegenerateThreadTitle(thread),
    [onRegenerateThreadTitle, thread],
  );
  const handleSettle = useCallback(() => onSettleThread(thread), [onSettleThread, thread]);
  const [customSnoozeOpen, setCustomSnoozeOpen] = useState(false);
  // Recycling changes identity without remounting; clear local UI directly because equality may skip the render closure.
  const rowIdentity = `${thread.environmentId}:${thread.id}`;
  const [boundIdentity, setBoundIdentity] = useState(rowIdentity);
  if (boundIdentity !== rowIdentity) {
    setBoundIdentity(rowIdentity);
    setCustomSnoozeOpen(false);
  }
  const handleSnooze = useCallback(
    (snoozedUntil: string) => onSnoozeThread(thread, snoozedUntil),
    [onSnoozeThread, thread],
  );
  const handleUnsnooze = useCallback(() => onUnsnoozeThread(thread), [onUnsnoozeThread, thread]);
  const handleUnsettle = useCallback(() => onUnsettleThread(thread), [onUnsettleThread, thread]);
  const handlePin = useCallback(() => onPinThread(thread), [onPinThread, thread]);
  const handleUnpin = useCallback(() => onUnpinThread(thread), [onUnpinThread, thread]);
  const handleSetAutoSettle = useCallback(
    (enabled: boolean) => onSetThreadAutoSettle(thread, enabled),
    [onSetThreadAutoSettle, thread],
  );
  const handlePostponeSettle = useCallback(
    () => onSetThreadAutoSettle(thread, true, { postpone: true }),
    [onSetThreadAutoSettle, thread],
  );
  const handleMoveUp = useCallback(() => onMoveThread?.(thread, "up"), [onMoveThread, thread]);
  const handleMoveDown = useCallback(() => onMoveThread?.(thread, "down"), [onMoveThread, thread]);
  const handleArchive = useCallback(() => onArchiveThread(thread), [onArchiveThread, thread]);

  // Trail rows are slim too, but only settled ones un-settle.
  const canUnsettle = variant === "slim" && thread.settledOverride === "settled";
  // The gate's only time-dependent edge is the queued-turn grace window, so its
  // expiry is known without a clock: evaluate at the message's own timestamp.
  // A gate held by runtime status has no expiry, and no clock tick opens it.
  const snoozeGateExpiryMs = props.snoozeSupported
    ? resolveThreadListV2SnoozeGateExpiryMs(thread, { now: thread.latestUserMessageAt ?? "" })
    : null;
  // The window is inclusive, so wake just past it.
  const snoozeGateNowMs = useNowAfter(snoozeGateExpiryMs === null ? null : snoozeGateExpiryMs + 1);
  const snoozeGateNow = new Date(snoozeGateNowMs).toISOString();
  const swipeActions = resolveThreadListV2SwipeActions({
    settled: canUnsettle,
    settlementSupported: props.settlementSupported,
    snoozeSupported: props.snoozeSupported,
    snoozable: canSnooze(thread, { now: snoozeGateNow }),
    snoozed: snoozedRow,
  });
  const snoozePresets = resolveThreadListV2SnoozePresets(
    {
      secondary: swipeActions.secondary,
      now: props.snoozePresetMinute || snoozeGateNow,
      presets: props.snoozePresets,
    },
    m,
  );
  const snoozePresetActions = useMemo<MenuAction[]>(
    () => [
      ...snoozePresets.map((preset) => ({
        id: `snooze:${preset.id}`,
        title: preset.label,
        subtitle: preset.whenLabel,
      })),
      { id: "snooze:custom", title: gt("Custom…", { $context: "custom snooze time" }) },
      { id: "later:set-aside", title: gt("Set aside") },
    ],
    [gt, snoozePresets],
  );
  const reorderMenuItems = useMemo<MenuAction[]>(
    () =>
      props.reorderSupported === true
        ? [
            { id: "arrange", title: gt("Arrange threads…"), image: "line.3.horizontal" },
            {
              id: "move-up",
              title: gt("Move up"),
              image: "arrow.up",
              attributes: { disabled: props.canMoveUp !== true },
            } satisfies MenuAction,
            {
              id: "move-down",
              title: gt("Move down"),
              image: "arrow.down",
              attributes: { disabled: props.canMoveDown !== true },
            } satisfies MenuAction,
          ]
        : [],
    [gt, props.canMoveDown, props.canMoveUp, props.reorderSupported],
  );
  const pinMenuItems = useMemo<MenuAction[]>(
    () =>
      props.pinningSupported
        ? [
            thread.pinnedAt != null
              ? {
                  id: "unpin",
                  title: gt("Unpin", { $context: "verb, thread action" }),
                  image: "pin.slash",
                }
              : { id: "pin", title: gt("Pin", { $context: "verb, thread action" }), image: "pin" },
          ]
        : [],
    [gt, props.pinningSupported, thread.pinnedAt],
  );
  const autoSettleMenuItems = useMemo<MenuAction[]>(
    () =>
      props.autoSettleOptOutSupported
        ? [
            {
              id: "auto-settle",
              title: gt("Auto-settle behavior"),
              image: "timer",
              subactions: [
                {
                  id: "auto-settle:enabled",
                  title: gt("Follow settings"),
                  state: thread.autoSettleDisabledAt == null ? "on" : "off",
                },
                {
                  id: "auto-settle:disabled",
                  title: gt("Never", { $context: "never auto-settle this thread" }),
                  state: thread.autoSettleDisabledAt == null ? "off" : "on",
                },
              ],
            } satisfies MenuAction,
          ]
        : [],
    [gt, props.autoSettleOptOutSupported, thread.autoSettleDisabledAt],
  );
  const canTurnIntoProject = canTurnThreadIntoProject(thread);
  const titleMenuItems = useMemo<MenuAction[]>(
    () => [
      {
        id: "rename",
        title: gt("Rename", { $context: "verb, thread action" }),
        image: "square.and.pencil",
      },
      ...buildThreadTitleRegenerationMenuItems(
        {
          supported: props.titleRegenerationSupported,
          isRegenerating: isRegeneratingTitle,
        },
        m,
      ),
      { id: "mark-unread", title: gt("Mark unread"), image: "envelope.badge" },
      ...(canTurnIntoProject
        ? [
            {
              id: "turn-into-project",
              title: gt("Turn into project"),
              image: "folder.badge.plus",
              attributes: { disabled: !threadCanArchive(thread.runtime) },
            } satisfies MenuAction,
          ]
        : []),
    ],
    [
      canTurnIntoProject,
      gt,
      m,
      props.titleRegenerationSupported,
      thread.runtime,
      isRegeneratingTitle,
    ],
  );
  const menuActions = useMemo<MenuAction[]>(() => {
    const nested = Platform.OS === "ios";
    const localized = (action: MenuAction): MenuAction => ({ ...action, title: m(action.title) });
    const direct: MenuAction[] = [
      ...(thread.branch
        ? [
            {
              id: "new-thread-on-branch",
              title: getThreadListV2NewBranchMenuTitle(thread.branch, m),
              image: "square.and.pencil",
            },
          ]
        : []),
      { id: "copy-thread", title: gt("Copy thread"), image: "text.bubble" },
      { id: "copy-thread-id", title: gt("Copy thread ID"), image: "doc.on.doc" },
      ...(canShareWithGuest
        ? [{ id: "share-guest", title: gt("Share with guest"), image: "person.badge.plus" }]
        : []),
    ];
    if (snoozedRow) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [
            ...direct,
            localized(SNOOZED_MENU_ACTIONS[0]!),
            ...threadListV2LaterMenuActions(thread),
          ],
          reorder: [],
          pin: [],
          secondary: [
            ...titleMenuItems,
            ...autoSettleMenuItems,
            localized(LEGACY_MENU_ACTIONS[0]!),
            localized(SNOOZED_MENU_ACTIONS[1]!),
          ],
        },
        m,
      );
    }
    if (!props.settlementSupported) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [...direct, localized(LEGACY_MENU_ACTIONS[0]!)],
          reorder: reorderMenuItems,
          pin: pinMenuItems,
          secondary: [...titleMenuItems, localized(LEGACY_MENU_ACTIONS[1]!)],
        },
        m,
      );
    }
    if (canUnsettle) {
      return layoutThreadListV2RowMenuActions(
        {
          nested,
          direct: [...direct, localized(SLIM_MENU_ACTIONS[0]!)],
          reorder: reorderMenuItems.filter(
            (action) => action.id !== "move-up" && action.id !== "move-down",
          ),
          pin: pinMenuItems,
          secondary: [
            ...titleMenuItems,
            ...autoSettleMenuItems,
            localized(LEGACY_MENU_ACTIONS[0]!),
            localized(SLIM_MENU_ACTIONS[1]!),
          ],
        },
        m,
      );
    }
    return layoutThreadListV2RowMenuActions(
      {
        nested,
        direct: [
          ...direct,
          localized(CARD_MENU_ACTIONS[0]!),
          ...(settling && props.autoSettleOptOutSupported
            ? [
                {
                  id: "postpone-settle",
                  title: threadSettlePostponeLabel(thread, m),
                  image: "timer",
                },
              ]
            : []),
          ...(swipeActions.secondary === "snooze"
            ? [
                {
                  id: "snooze",
                  title: gt("Snooze", { $context: "verb, thread action" }),
                  image: "clock",
                  subactions: snoozePresetActions,
                },
              ]
            : []),
          // An agent can arm a re-check before the thread files into Later.
          ...threadListV2LaterMenuActions(thread),
        ],
        reorder: reorderMenuItems,
        pin: pinMenuItems,
        secondary: [
          ...titleMenuItems,
          ...autoSettleMenuItems,
          localized(LEGACY_MENU_ACTIONS[0]!),
          localized(CARD_MENU_ACTIONS[1]!),
        ],
      },
      m,
    );
  }, [
    autoSettleMenuItems,
    canShareWithGuest,
    canUnsettle,
    pinMenuItems,
    props.autoSettleOptOutSupported,
    props.settlementSupported,
    reorderMenuItems,
    settling,
    snoozePresetActions,
    snoozedRow,
    gt,
    m,
    swipeActions.secondary,
    thread,
    titleMenuItems,
  ]);
  const handleMenuAction = useCallback(
    ({ nativeEvent }: { readonly nativeEvent: { readonly event: string } }) => {
      if (nativeEvent.event === "new-thread-on-branch") onNewThreadOnBranch(thread);
      if (nativeEvent.event === "settle") handleSettle();
      if (nativeEvent.event === "unsettle") handleUnsettle();
      if (nativeEvent.event === "unsnooze") handleUnsnooze();
      if (nativeEvent.event === "later:set-aside") handleSnooze(THREAD_SET_ASIDE_UNTIL);
      if (nativeEvent.event === "later:cancel-recheck") {
        void clearFollowUp({ environmentId: thread.environmentId, input: { threadId: thread.id } });
      }
      if (nativeEvent.event === "later:stop-standing-check") {
        void setStandingCheck({
          environmentId: thread.environmentId,
          input: { threadId: thread.id, enabled: false },
        });
      }
      if (nativeEvent.event === "pin") handlePin();
      if (nativeEvent.event === "unpin") handleUnpin();
      if (nativeEvent.event === "auto-settle:enabled") handleSetAutoSettle(true);
      if (nativeEvent.event === "auto-settle:disabled") handleSetAutoSettle(false);
      if (nativeEvent.event === "postpone-settle") handlePostponeSettle();
      if (nativeEvent.event === "arrange") appAtomRegistry.set(threadArrangementOpenAtom, true);
      if (nativeEvent.event === "move-up") handleMoveUp();
      if (nativeEvent.event === "move-down") handleMoveDown();
      if (nativeEvent.event === "archive") handleArchive();
      if (nativeEvent.event === "rename") handleRename();
      if (nativeEvent.event === "regenerate-title") handleRegenerateTitle();
      if (nativeEvent.event === "turn-into-project") void turnThreadIntoProject(thread);
      if (nativeEvent.event === "mark-unread") {
        void markThreadUnread({
          environmentId: thread.environmentId,
          input: { threadId: thread.id },
        });
      }
      if (nativeEvent.event === "copy-thread") {
        const target = threadChipCopyTarget(
          { environmentId: thread.environmentId, threadId: thread.id },
          thread.title,
          undefined,
          m,
        );
        void copyThreadReference(target).then((didCopy) => {
          if (!didCopy) Dialog.alert(target.failureTitle, gt("Try copying this thread again."));
        });
      }
      if (nativeEvent.event === "copy-thread-id") {
        copyTextWithHaptic(thread.id, { target: "thread-id" });
      }
      if (nativeEvent.event === "share-guest") {
        navigation.navigate("ThreadGuestShare", {
          environmentId: thread.environmentId,
          threadId: thread.id,
        });
      }
      if (nativeEvent.event === "delete") handleDelete();
      if (nativeEvent.event === "snooze:custom") {
        setCustomSnoozeOpen(true);
        return;
      }
      const snoozeSelection = resolveThreadListV2SnoozeMenuSelection({
        event: nativeEvent.event,
        displayedPresets: snoozePresets,
        now: new Date(),
        presets: props.snoozePresets,
      });
      if (snoozeSelection._tag === "selected") {
        handleSnooze(snoozeSelection.preset.snoozedUntil);
      } else if (snoozeSelection._tag === "expired") {
        Dialog.alert(
          gt("Could not snooze thread"),
          gt("That snooze time has passed. Choose another time."),
        );
      }
    },
    [
      gt,
      m,
      onNewThreadOnBranch,
      thread,
      navigation,
      handleArchive,
      handleDelete,
      handleRegenerateTitle,
      handleRename,
      handleMoveDown,
      handleMoveUp,
      handlePin,
      handleSettle,
      handleSnooze,
      handleSetAutoSettle,
      handlePostponeSettle,
      handleUnpin,
      handleUnsettle,
      handleUnsnooze,
      clearFollowUp,
      setStandingCheck,
      markThreadUnread,
      setCustomSnoozeOpen,
      snoozePresets,
      props.snoozePresets,
    ],
  );
  const primaryAction = useMemo(() => {
    if (swipeActions.primary === "archive") {
      return {
        accessibilityLabel: gt("Archive {title}", { title: thread.title }),
        icon: "archivebox" as const,
        label: gt("Archive", { $context: "verb, thread action" }),
        swipeHint: gt("Opens the thread. Swipe left to archive."),
        swipeSnoozeHint: gt("Opens the thread. Swipe left for archive and snooze actions."),
        onPress: handleArchive,
      };
    }
    if (swipeActions.primary === "unsnooze") {
      return {
        accessibilityLabel: gt("Wake {title} now", { title: thread.title }),
        icon: "clock" as const,
        label: gt("Wake", { $context: "verb, thread action" }),
        swipeHint: gt("Opens the thread. Swipe left to wake."),
        swipeSnoozeHint: gt("Opens the thread. Swipe left for wake and snooze actions."),
        onPress: handleUnsnooze,
      };
    }
    return swipeActions.primary === "unsettle"
      ? {
          accessibilityLabel: gt("Un-settle {title}", { title: thread.title }),
          icon: "arrow.uturn.backward" as const,
          label: gt("Un-settle", { $context: "verb, thread action" }),
          swipeHint: gt("Opens the thread. Swipe left to un-settle."),
          swipeSnoozeHint: gt("Opens the thread. Swipe left for un-settle and snooze actions."),
          onPress: handleUnsettle,
        }
      : {
          accessibilityLabel: gt("Settle {title}", { title: thread.title }),
          icon: "checkmark" as const,
          label: gt("Settle", { $context: "verb, thread action" }),
          swipeHint: gt("Opens the thread. Swipe left to settle."),
          swipeSnoozeHint: gt("Opens the thread. Swipe left for settle and snooze actions."),
          onPress: handleSettle,
        };
  }, [
    gt,
    handleArchive,
    handleSettle,
    handleUnsettle,
    handleUnsnooze,
    swipeActions.primary,
    thread.title,
  ]);
  const secondaryAction = useMemo(
    () =>
      swipeActions.secondary === "snooze"
        ? {
            accessibilityLabel: gt("Choose when to snooze {title}", { title: thread.title }),
            icon: "clock" as const,
            label: gt("Snooze", { $context: "verb, thread action" }),
            menu: {
              actions: snoozePresetActions,
              onPressAction: handleMenuAction,
              title: gt("Snooze until"),
            },
            onPress: () => undefined,
          }
        : null,
    [gt, handleMenuAction, snoozePresetActions, swipeActions.secondary, thread.title],
  );
  const swipeAccessibilityHint = !canOperateThread
    ? gt("Opens the thread")
    : secondaryAction === null
      ? primaryAction.swipeHint
      : primaryAction.swipeSnoozeHint;

  const mailCard = props.selfFiling === true && !sidebarPane;
  const titleTextInset = !mailCard && props.project ? projectIconSize + 8 : 0;
  const rowBranch = nonMainlineBranchName(thread.branch);
  const unreadDot = showsDone ? (
    <View className="size-1.5 shrink-0 self-center rounded-full bg-adaptive-emerald-600-400" />
  ) : null;
  const cardTrailing = (
    <View className="flex-row items-center gap-1.5" style={{ minHeight: titleLineHeight }}>
      {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
      {pinnedRow ? (
        <SymbolView
          name="pin"
          size={11}
          tintColorClassName={rowAppearance.mutedIconTintClassName}
          type="monochrome"
        />
      ) : null}
      {showsWoke ? (
        <Pressable
          className="-m-2.5 flex-row items-center gap-1 p-2.5"
          accessibilityRole="button"
          accessibilityLabel={gt("Dismiss Woke notification")}
          onPress={handleAcknowledgeWoke}
          onLongPress={() => undefined}
          style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
        >
          <SymbolView
            name="bell.badge"
            size={13}
            tintColorClassName={
              selected ? selectedThreadRowColors.iconTintClassName : "accent-warning-foreground"
            }
            type="monochrome"
            weight="semibold"
          />
          <Text
            className={cn(
              "text-xs font-t3-bold",
              selected ? selectedThreadRowColors.foregroundClassName : "text-warning-foreground",
            )}
          >
            {gt("Woke", { $context: "thread came back from snooze" })}
          </Text>
        </Pressable>
      ) : statusLabel ? (
        <View className="flex-row items-center gap-1">
          <SymbolView
            name={statusLabel.icon}
            size={13}
            tintColorClassName={
              selected ? selectedThreadRowColors.iconTintClassName : statusLabel.iconTintClassName
            }
            type="monochrome"
            weight="semibold"
          />
          <Text
            className={cn(
              "text-xs font-t3-bold",
              selected ? selectedThreadRowColors.foregroundClassName : statusLabel.className,
            )}
          >
            {statusLabel.label}
            {status === "working" ? (
              <ThreadListV2Duration
                environmentId={thread.environmentId}
                startedAt={resolveThreadWorkingStartedAt(thread)}
                leadingSpace={statusLabel.label !== null}
              />
            ) : status === "waiting" ? (
              <ThreadListV2Duration
                environmentId={thread.environmentId}
                startedAt={thread.latestRun?.completedAt ?? null}
                leadingSpace={statusLabel.label !== null}
              />
            ) : null}
          </Text>
        </View>
      ) : (
        <Text
          className={cn(
            "text-xs tabular-nums",
            selected
              ? selectedThreadRowColors.foregroundClassName
              : rowAppearance.tertiaryForegroundClassName,
          )}
        >
          {timeLabel}
        </Text>
      )}
    </View>
  );
  const statusDuration =
    status === "working" ? (
      <ThreadListV2Duration
        environmentId={thread.environmentId}
        startedAt={resolveThreadWorkingStartedAt(thread)}
        leadingSpace={statusLabel?.label != null}
      />
    ) : status === "waiting" ? (
      <ThreadListV2Duration
        environmentId={thread.environmentId}
        startedAt={thread.latestRun?.completedAt ?? null}
        leadingSpace={statusLabel?.label != null}
      />
    ) : null;
  // A finished card row whose question was read and left leads with it, after Done's check.
  const owedLead = statusEntry === DONE_STATUS_LABEL ? threadCardQuestionLabel(thread.card) : null;
  const cardStatusLead = showsWoke
    ? {
        icon: "bell.badge" as const,
        iconTintClassName: selected
          ? selectedThreadRowColors.iconTintClassName
          : "accent-warning-foreground",
        className: selected
          ? selectedThreadRowColors.foregroundClassName
          : "text-warning-foreground",
        label: gt("Woke", { $context: "thread came back from snooze" }),
        onPress: handleAcknowledgeWoke,
        accessibilityLabel: gt("Dismiss Woke notification"),
      }
    : owedLead !== null
      ? {
          // The run is done, so it keeps Done's green check; the word says a question is left.
          icon: DONE_STATUS_LABEL.icon,
          iconTintClassName: selected
            ? selectedThreadRowColors.iconTintClassName
            : DONE_STATUS_LABEL.iconTintClassName,
          className: selected ? selectedThreadRowColors.foregroundClassName : "text-foreground",
          label: owedLead,
        }
      : statusLabel
        ? {
            icon: statusLabel.icon,
            iconTintClassName: selected
              ? selectedThreadRowColors.iconTintClassName
              : statusLabel.iconTintClassName,
            className: selected
              ? selectedThreadRowColors.foregroundClassName
              : statusLabel.className,
            label: (
              <>
                {statusLabel.label}
                {statusDuration}
              </>
            ),
          }
        : null;
  // The time keeps the top right; status leads the summary line instead.
  const mailTrailing = (
    <View className="flex-row items-center gap-1.5">
      {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
      {pinnedRow ? (
        <SymbolView
          name="pin"
          size={11}
          tintColorClassName={rowAppearance.mutedIconTintClassName}
          type="monochrome"
        />
      ) : null}
      <Text
        className={cn(
          "text-xs tabular-nums",
          selected
            ? selectedThreadRowColors.mutedForegroundClassName
            : rowAppearance.tertiaryForegroundClassName,
        )}
      >
        {timeLabel}
      </Text>
    </View>
  );
  // The project and branch close the row in small text: the title leads, the repeated metadata recedes.
  const projectFooter = (
    <View className="mt-1 flex-row items-center gap-1.5">
      {props.project ? (
        <ProjectFavicon
          environmentId={thread.environmentId}
          faviconPath={props.project.faviconPath}
          projectIcon={props.project.projectIcon}
          size={Math.round(metadataTypography.fontSize * fontScale)}
          projectTitle={props.project.title}
          workspaceRoot={props.project.workspaceRoot}
        />
      ) : null}
      <Text
        className={cn(
          "shrink text-2xs",
          selected
            ? selectedThreadRowColors.mutedForegroundClassName
            : rowAppearance.tertiaryForegroundClassName,
        )}
        numberOfLines={1}
      >
        {projectLine}
      </Text>
      {rowBranch ? (
        <>
          <SymbolView
            name="arrow.triangle.branch"
            size={Math.round(metadataTypography.fontSize * fontScale * 0.8)}
            tintColorClassName={
              selected
                ? selectedThreadRowColors.mutedIconTintClassName
                : rowAppearance.tertiaryIconTintClassName
            }
            type="monochrome"
          />
          <Text
            className={cn(
              "shrink text-2xs",
              selected
                ? selectedThreadRowColors.mutedForegroundClassName
                : rowAppearance.tertiaryForegroundClassName,
            )}
            ellipsizeMode="middle"
            numberOfLines={1}
          >
            {rowBranch}
          </Text>
        </>
      ) : null}
    </View>
  );
  const cardTitle = (
    <Text
      className={cn(
        "flex-1 text-base",
        !recede && "font-t3-semibold",
        selected ? selectedThreadRowColors.foregroundClassName : rowAppearance.foregroundClassName,
        isRegeneratingTitle && "opacity-55",
      )}
      numberOfLines={2}
    >
      {thread.title}
    </Text>
  );
  // Full-width rows drop the model icon; their last line shows only what is worth reading.
  const cardMetaVisible =
    !mailCard ||
    ((status === "failed" || status === "limited") && Boolean(thread.runtime?.lastError)) ||
    Boolean(props.environmentLabel) ||
    pr !== null;
  const cardContent = (
    <>
      {mailCard ? (
        <>
          <View className="flex-row items-start gap-2">
            {unreadDot}
            {cardTitle}
            <View className="justify-center" style={{ height: titleLineHeight }}>
              {mailTrailing}
            </View>
          </View>
          {cardStatusLead || cardLine ? (
            <View className="mt-0.5">
              <ThreadRowStatusLine
                lead={cardStatusLead}
                text={cardLine}
                textClassName={
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.mutedForegroundClassName
                }
                numberOfLines={2}
                lineHeight={summaryLineHeight}
              />
            </View>
          ) : null}
          {projectLine ? projectFooter : null}
        </>
      ) : (
        <View className="flex-row items-start gap-2">
          {props.project ? (
            <View className="justify-center" style={{ height: titleLineHeight }}>
              <ProjectFavicon
                environmentId={thread.environmentId}
                faviconPath={props.project.faviconPath}
                projectIcon={props.project.projectIcon}
                size={projectIconSize}
                projectTitle={props.project.title}
                workspaceRoot={props.project.workspaceRoot}
              />
            </View>
          ) : null}
          {unreadDot}
          <Text
            className={cn(
              "flex-1 text-base",
              !recede && "font-t3-semibold",
              selected
                ? selectedThreadRowColors.foregroundClassName
                : rowAppearance.foregroundClassName,
              isRegeneratingTitle && "opacity-55",
            )}
            numberOfLines={2}
            onTextLayout={
              Platform.OS === "android"
                ? ({ nativeEvent }) => {
                    const firstLine = nativeEvent.lines[0];
                    if (firstLine && Math.abs(firstLine.height - titleLineHeight) > 0.5) {
                      setTitleLineHeight(firstLine.height);
                    }
                  }
                : undefined
            }
          >
            {thread.title}
          </Text>
          {cardTrailing}
        </View>
      )}
      {cardLine && !mailCard ? (
        <Text
          className={cn(
            "mt-0.5 text-sm",
            selected
              ? selectedThreadRowColors.mutedForegroundClassName
              : rowAppearance.mutedForegroundClassName,
          )}
          numberOfLines={2}
          style={{ paddingLeft: titleTextInset }}
        >
          {cardLine}
        </Text>
      ) : null}
      {props.searchMatch ? (
        <View className="mt-1" style={{ paddingLeft: titleTextInset }}>
          <ThreadSearchMatchExcerpt
            sidebar={sidebarPane}
            match={props.searchMatch}
            query={props.searchQuery ?? ""}
            selected={selected}
          />
        </View>
      ) : null}
      {cardMetaVisible ? (
        <View className="mt-1 flex-row items-center gap-2" style={{ paddingLeft: titleTextInset }}>
          {(status === "failed" || status === "limited") && thread.runtime?.lastError ? (
            <Text
              className={cn(
                "flex-1 text-xs",
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : status === "limited"
                    ? "text-warning-foreground"
                    : "text-danger-foreground",
              )}
              numberOfLines={1}
            >
              {thread.runtime.lastError}
            </Text>
          ) : props.environmentLabel ? (
            <View className="min-w-0 flex-1 flex-row items-center gap-1">
              {props.environmentMachine ? (
                <EnvironmentMachineSymbol
                  kind={props.environmentMachine}
                  size={machineIconSize}
                  tintColorClassName={
                    selected
                      ? selectedThreadRowColors.mutedIconTintClassName
                      : rowAppearance.tertiaryIconTintClassName
                  }
                />
              ) : null}
              <Text
                className={cn(
                  "shrink text-xs",
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.tertiaryForegroundClassName,
                )}
                numberOfLines={1}
              >
                {props.environmentLabel}
              </Text>
            </View>
          ) : (
            <View className="flex-1" />
          )}
          {pr ? (
            <Pressable
              // Padding cancelled by negative margin grows the touch target into
              // the row padding without moving the badge.
              className="-m-2.5 flex-row items-center gap-1 p-2.5"
              accessibilityRole="button"
              accessibilityLabel={prBadgeLabel ?? undefined}
              onPress={handleOpenPullRequests}
              // Handle long-press so opening the iOS row menu cannot also open the PR on release.
              onLongPress={() => undefined}
              style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
            >
              <SymbolView
                name={
                  pr.kind === "stack"
                    ? PullRequestGlyph.stack
                    : pr.state === null
                      ? PullRequestGlyph.pullRequest
                      : pullRequestStatus({ state: pr.state, isDraft: pr.isDraft }).icon
                }
                size={12}
                tintColorClassName={
                  pr.state === null || pr.isDraft
                    ? rowAppearance.mutedIconTintClassName
                    : pr.state === "open"
                      ? "accent-adaptive-emerald-600-400"
                      : pr.state === "closed"
                        ? "accent-adaptive-rose-600-400"
                        : "accent-adaptive-violet-600-400"
                }
              />
              <Text
                accessibilityLabel={pr.accessibilityLabel}
                className={cn("text-xs", pr.textClassName)}
                style={{ fontFamily: MONO_FONT }}
              >
                {pr.label}
              </Text>
            </Pressable>
          ) : null}
          {providerInstance && !mailCard ? (
            <View className="flex-row items-center">
              {providerDrivers.slice(0, -1).map(
                (driver, index) => (
                  /* oxlint-disable react/no-array-index-key -- Provider history can repeat a driver; these decorative icons have no local state. */ <View
                    key={`${driver}:${index}`}
                    className="-mr-1 opacity-30"
                  >
                    <ProviderIcon provider={driver} size={12} />
                  </View>
                ) /* oxlint-enable react/no-array-index-key */,
              )}
              <ProviderInstanceIcon
                iconUrl={providerIconUrl}
                provider={providerInstance.driverKind}
                size={14}
                displayName={providerInstance.displayName}
                accentColor={providerInstance.accentColor}
                showBadge={providerInstance.showBadge}
                surfaceColor={rowAppearance.providerIconSurfaceColor}
              />
              {providerNameLabel ? (
                <Text
                  className={cn(
                    "ml-1.5 text-xs",
                    selected
                      ? selectedThreadRowColors.mutedForegroundClassName
                      : rowAppearance.tertiaryForegroundClassName,
                  )}
                  ellipsizeMode="middle"
                  numberOfLines={1}
                  style={{ maxWidth: 140 }}
                >
                  {providerNameLabel}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>
      ) : null}
    </>
  );

  const slimTrailing = (
    <View className="flex-row items-center gap-1">
      {props.hasQueuedMessages ? <QueuedMessageIcon selected={selected} /> : null}
      <Text
        className={cn(
          "text-xs tabular-nums",
          selected
            ? selectedThreadRowColors.mutedForegroundClassName
            : snoozedRow
              ? rowAppearance.mutedForegroundClassName
              : rowAppearance.tertiaryForegroundClassName,
        )}
      >
        {snoozedRow && snoozeWakeLabelText !== undefined ? snoozeWakeLabelText : timeLabel}
      </Text>
    </View>
  );

  const slimLead = showsDone
    ? {
        icon: DONE_STATUS_LABEL.icon,
        iconTintClassName: selected
          ? selectedThreadRowColors.iconTintClassName
          : DONE_STATUS_LABEL.iconTintClassName,
        className: selected
          ? selectedThreadRowColors.foregroundClassName
          : DONE_STATUS_LABEL.className,
        label: gt("Done", { $context: "thread status, turn finished" }),
      }
    : showsSlimStatus && statusLabel
      ? {
          icon: statusLabel.icon,
          iconTintClassName: selected
            ? selectedThreadRowColors.iconTintClassName
            : statusLabel.iconTintClassName,
          className: selected ? selectedThreadRowColors.foregroundClassName : statusLabel.className,
          label: statusLabel.label,
        }
      : null;
  const slimLine = showsDone
    ? threadRowLineText({ owed: threadCardQuestionLabel(thread.card), line: cardLine })
    : cardLine;

  const fadedCardContent = recede ? (
    <View style={{ opacity: 0.55 }}>{cardContent}</View>
  ) : (
    cardContent
  );

  const rowContent = (close: () => void) =>
    variant === "card" ? (
      <RowPressable
        key={`${thread.environmentId}:${thread.id}`}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        className={rowSurfaceClassName}
        accessibilityHint={swipeAccessibilityHint}
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        accessibilityActions={rowAccessibilityActions}
        onAccessibilityAction={(event) => {
          if (event.nativeEvent.actionName === "openPullRequests") handleOpenPullRequests();
          if (event.nativeEvent.actionName === "dismissWoke") handleAcknowledgeWoke();
        }}
        onPress={() => {
          close();
          selectThread();
        }}
        style={
          rowTint === null
            ? rowAppearance.cardStyle
            : { ...rowAppearance.cardStyle, backgroundColor: rowTint }
        }
      >
        {sidebarPane ? (
          fadedCardContent
        ) : (
          <View>
            <View className={cn(THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME, grouped && "px-4")}>
              {fadedCardContent}
            </View>
            {THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
              <View
                className="h-px bg-separator"
                style={{ marginLeft: (grouped ? 16 : 20) + titleTextInset }}
              />
            ) : null}
          </View>
        )}
      </RowPressable>
    ) : (
      <RowPressable
        key={`${thread.environmentId}:${thread.id}`}
        interactionClassName={rowAppearance.interactionClassName}
        interactionOpacity={rowAppearance.interactionOpacity}
        accessibilityHint={swipeAccessibilityHint}
        accessibilityLabel={rowAccessibilityLabel}
        accessibilityRole="button"
        accessibilityState={{ selected }}
        className={rowSurfaceClassName}
        onPress={() => {
          close();
          selectThread();
        }}
        style={
          rowTint === null
            ? rowAppearance.style
            : { ...rowAppearance.style, backgroundColor: rowTint }
        }
      >
        <View
          className={cn(
            THREAD_LIST_V2_ROW_CONTENT_CLASS_NAME,
            "min-h-[44px] justify-center",
            sidebarPane && "px-3",
            grouped && "px-4",
          )}
        >
          <View className="flex-row items-center gap-2">
            {unreadDot}
            <Text
              className={cn(
                "min-w-0 flex-1 text-base",
                showsDone ? "font-t3-semibold" : "font-t3-medium",
                selected
                  ? selectedThreadRowColors.foregroundClassName
                  : rowAppearance.foregroundClassName,
                isRegeneratingTitle && "opacity-55",
              )}
              numberOfLines={1}
            >
              {thread.title}
            </Text>
            {slimTrailing}
          </View>
          {slimLine || slimLead ? (
            // Takes the provider line's place.
            <View className="mt-0.5">
              <ThreadRowStatusLine
                lead={slimLead}
                text={slimLine}
                textClassName={
                  selected
                    ? selectedThreadRowColors.mutedForegroundClassName
                    : rowAppearance.mutedForegroundClassName
                }
                numberOfLines={1}
                lineHeight={summaryLineHeight}
              />
            </View>
          ) : providerNameLabel ? (
            <Text
              className={cn(
                "text-sm",
                selected
                  ? selectedThreadRowColors.mutedForegroundClassName
                  : rowAppearance.mutedForegroundClassName,
              )}
              ellipsizeMode="middle"
              numberOfLines={1}
            >
              {providerNameLabel}
            </Text>
          ) : null}
          {projectLine ? projectFooter : null}
          {props.searchMatch ? (
            <ThreadSearchMatchExcerpt
              sidebar={sidebarPane}
              match={props.searchMatch}
              query={props.searchQuery ?? ""}
              selected={selected}
            />
          ) : null}
        </View>
        {!sidebarPane && THREAD_LIST_V2_ROW_DIVIDERS && props.showTrailingDivider !== false ? (
          // A sub-point hairline at the row's edge rounds away; one point always draws.
          <View
            pointerEvents="none"
            className={cn(
              "absolute right-0 bottom-0 h-px bg-separator",
              grouped ? "left-4" : "left-5",
            )}
          />
        ) : null}
      </RowPressable>
    );

  if (!canOperateThread) return <View style={swipeContainerStyle}>{rowContent(() => {})}</View>;

  return (
    <View collapsable={false}>
      {customSnoozeOpen && (
        <CustomSnoozeSheet onClose={() => setCustomSnoozeOpen(false)} onSnooze={handleSnooze} />
      )}
      <ThreadSwipeable
        dormant={dormant}
        threadKey={`${thread.environmentId}:${thread.id}`}
        backgroundColor={
          rowTint ?? (grouped ? theme["--color-grouped-card"] : rowAppearance.swipeBackgroundColor)
        }
        compactActions={variant === "slim"}
        containerStyle={swipeContainerStyle}
        enableTrackpadSwipe
        fullSwipeAction="primary"
        fullSwipeWidth={props.fullSwipeWidth ?? windowWidth - 32}
        listAnimatesLayout
        onDelete={handleDelete}
        onSwipeableClose={props.onSwipeableClose}
        onSwipeableWillOpen={props.onSwipeableWillOpen}
        primaryAction={primaryAction}
        secondaryAction={secondaryAction}
        resetKey={`${thread.environmentId}:${thread.id}:${variant}:${snoozedRow}:${thread.settledAt}:${thread.unsettledAt}:${thread.snoozedUntil}:${thread.pinnedAt}`}
        simultaneousWith={props.simultaneousSwipeGesture}
        threadTitle={thread.title}
      >
        {(close) => (
          <Menu
            accessibilityLabel={rowAccessibilityLabel}
            actions={menuActions}
            onPressAction={handleMenuAction}
            shouldOpenOnLongPress
          >
            {rowContent(close)}
          </Menu>
        )}
      </ThreadSwipeable>
    </View>
  );
});
