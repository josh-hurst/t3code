import { Capsule, HStack, Image, Rectangle, Spacer, Text, VStack } from "@expo/ui/swift-ui";
import {
  accessibilityElement,
  accessibilityLabel,
  containerBackground,
  environment,
  font,
  foregroundStyle,
  frame,
  layoutPriority,
  lineLimit,
  minimumScaleFactor,
  opacity,
  resizable,
  widgetURL,
} from "@expo/ui/swift-ui/modifiers";
import { createWidget, type WidgetEnvironment } from "expo-widgets";
import type { SubscriptionUsageSnapshot } from "./subscriptionUsageSnapshot";

type UsageConfiguration = {
  codexPeriod?: "auto" | "session" | "weekly";
  claudePeriod?: "auto" | "session" | "weekly";
};

function SubscriptionUsage(
  published: Partial<SubscriptionUsageSnapshot> | undefined,
  host: WidgetEnvironment<UsageConfiguration> & { showsContainerBackground?: boolean },
) {
  "widget";
  const props = published ?? {};
  const accessory = host.widgetFamily === "accessoryRectangular";
  const small = host.widgetFamily === "systemSmall" || host.levelOfDetail === "simplified";
  const large = host.widgetFamily === "systemLarge" || host.widgetFamily === "systemExtraLarge";
  const system =
    accessory ||
    host.widgetRenderingMode === "accented" ||
    host.widgetRenderingMode === "vibrant" ||
    host.isLuminanceReduced ||
    host.showsContainerBackground === false;
  const appearance =
    props.theme?.mode === "light" || props.theme?.mode === "dark"
      ? props.theme.mode
      : host.colorScheme === "dark"
        ? "dark"
        : "light";
  const dark = appearance === "dark";
  const palette = props.theme?.[appearance];
  type Ink = Parameters<typeof foregroundStyle>[0];
  const primary: Ink = system
    ? { type: "hierarchical", style: "primary" }
    : (palette?.foreground ?? (dark ? "#F6F2E9" : "#262925"));
  const secondary: Ink = system
    ? { type: "hierarchical", style: "secondary" }
    : (palette?.secondary ?? (dark ? "#B0ABA3" : "#59615A"));
  const background = palette?.background ?? (dark ? "#20231F" : "#F7F6F0");
  const now = Math.max(host.date?.getTime() ?? 0, Date.now());
  const limit = host.widgetFamily === "systemExtraLarge" ? 6 : large ? 4 : 2;
  const providers = (props.providers ?? []).map((provider) => {
    const claude = provider.name === "Claude";
    const period =
      (claude ? host.configuration?.claudePeriod : host.configuration?.codexPeriod) ?? "auto";
    const expired = provider.windows.length > 0 && now >= provider.expiresAt;
    const windows = expired
      ? []
      : provider.windows.filter((window) => period === "auto" || window.kind === period);
    const featured = windows.reduce<(typeof windows)[number] | undefined>(
      (lowest, window) => (!lowest || window.remaining < lowest.remaining ? window : lowest),
      undefined,
    );
    const other = windows.filter((window) => window !== featured);
    // In the two-window sizes, keep both configured periods visible when the provider reports several weekly pools.
    const alternate = other.find((window) => window.kind !== featured?.kind);
    const remaining = alternate
      ? [alternate, ...other.filter((window) => window !== alternate)]
      : other;
    return {
      name: provider.name,
      mark: claude ? "ClaudeMark" : "CodexMark",
      ink: system
        ? primary
        : claude
          ? dark
            ? "#F0A281"
            : "#AA492B"
          : dark
            ? "#8AD9B9"
            : "#1C7058",
      featured,
      remaining: remaining.slice(0, limit - 1),
      more: featured
        ? Math.max(
            0,
            (period === "auto" ? (provider.totalWindows ?? windows.length) : windows.length) -
              limit,
          )
        : 0,
      detail: expired
        ? (props.text?.refresh ?? "Open T3 to refresh")
        : !windows.length && period !== "auto" && provider.windows.length
          ? ((period === "session" ? props.text?.noSessionLimit : props.text?.noWeeklyLimit) ??
            "No " + period + " limit")
          : provider.detail,
    };
  });
  type Provider = (typeof providers)[number];
  const brand = (name: string, width: number, height: number, color: Ink) => (
    <HStack modifiers={[frame({ width, height }), foregroundStyle(color)]}>
      <Image assetName={name} modifiers={[resizable()]} />
    </HStack>
  );
  const inkFor = (provider: Provider, value: number) =>
    !system && value <= 10 ? (palette?.danger ?? (dark ? "#FFA28F" : "#AA392A")) : provider.ink;
  const meter = (percent: number, color: Ink, segments: number) => (
    <HStack spacing={2}>
      {Array.from({ length: segments }, (_, i) => (
        <Capsule
          key={i}
          modifiers={[
            frame({ height: large ? 7 : 5 }),
            foregroundStyle(color),
            opacity(
              i < Math.round((Math.max(0, Math.min(100, percent)) * segments) / 100) ? 1 : 0.18,
            ),
          ]}
        />
      ))}
    </HStack>
  );
  const header = (
    <HStack spacing={5}>
      {brand("T3Mark", 18, 12, primary)}
      <Text
        modifiers={[
          font({ size: small ? 12 : 13, weight: "semibold" }),
          foregroundStyle(primary),
          lineLimit(1),
        ]}
      >
        Usage remaining
      </Text>
      <Spacer minLength={0} />
      {!small && props.checkedAt ? (
        <Text
          modifiers={[
            font({ size: 11, weight: "medium" }),
            foregroundStyle(secondary),
            lineLimit(1),
          ]}
        >
          {new Date(props.checkedAt).toLocaleTimeString(undefined, {
            hour: "numeric",
            minute: "2-digit",
          })}
        </Text>
      ) : null}
    </HStack>
  );
  const label = (provider: Provider, size: number) => (
    <HStack spacing={5}>
      {brand(provider.mark, size, size, provider.ink)}
      <Text
        modifiers={[font({ size, weight: "semibold" }), foregroundStyle(primary), lineLimit(1)]}
      >
        {provider.name}
      </Text>
    </HStack>
  );
  const compactRow = (provider: Provider) => {
    const w = provider.featured;
    const alternate = provider.remaining[0];
    return (
      <VStack key={provider.name} alignment="leading" spacing={2}>
        <HStack spacing={4}>
          {label(provider, accessory ? 12 : 13)}
          <Spacer minLength={1} />
          {w ? (
            <Text
              modifiers={[
                font({ size: accessory ? 14 : 20, weight: "bold", design: "rounded" }),
                foregroundStyle(inkFor(provider, w.remaining)),
                layoutPriority(1),
                lineLimit(1),
              ]}
            >
              {w.remaining}%
            </Text>
          ) : null}
        </HStack>
        <Text
          modifiers={[
            font({ size: 10, weight: "medium" }),
            foregroundStyle(secondary),
            lineLimit(1),
            minimumScaleFactor(0.85),
          ]}
        >
          {w
            ? w.label +
              (!accessory && alternate
                ? " · " + alternate.label + " " + alternate.remaining + "%"
                : "")
            : provider.detail}
        </Text>
        {w && !accessory ? meter(w.remaining, inkFor(provider, w.remaining), 16) : null}
      </VStack>
    );
  };
  const column = (provider: Provider) => {
    const w = provider.featured;
    return (
      <VStack
        key={provider.name}
        alignment="leading"
        spacing={large ? 8 : 3}
        modifiers={[frame({ maxWidth: Infinity, alignment: "leading" })]}
      >
        {label(provider, large ? 16 : 14)}
        {large &&
        provider.detail &&
        provider.detail !== (props.text?.subscriptionRemaining ?? "Subscription remaining") &&
        w ? (
          <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(1)]}>
            {provider.detail}
          </Text>
        ) : null}
        {w ? (
          <VStack
            alignment="leading"
            spacing={large ? 5 : 2}
            modifiers={[
              accessibilityElement("ignore"),
              accessibilityLabel(
                provider.name +
                  ", " +
                  w.label +
                  ", " +
                  w.remaining +
                  " percent remaining. " +
                  w.reset,
              ),
            ]}
          >
            <HStack alignment="firstTextBaseline" spacing={5}>
              <Text
                modifiers={[
                  font({
                    size: large ? 41 : 34,
                    weight: "bold",
                    design: "rounded",
                    leading: "tight",
                  }),
                  foregroundStyle(inkFor(provider, w.remaining)),
                  lineLimit(1),
                  minimumScaleFactor(0.82),
                  layoutPriority(1),
                ]}
              >
                {w.remaining}%
              </Text>
              {large ? null : (
                <Text
                  modifiers={[
                    font({ size: 10, weight: "medium" }),
                    foregroundStyle(secondary),
                    lineLimit(2),
                  ]}
                >
                  {w.label}
                </Text>
              )}
            </HStack>
            {large ? (
              <Text
                modifiers={[
                  font({ size: 13, weight: "semibold" }),
                  foregroundStyle(primary),
                  lineLimit(1),
                ]}
              >
                {w.label}
              </Text>
            ) : null}
            {meter(w.remaining, inkFor(provider, w.remaining), 14)}
            {large || !provider.remaining.length ? (
              <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary), lineLimit(2)]}>
                {w.reset}
              </Text>
            ) : null}
          </VStack>
        ) : (
          <Text modifiers={[font({ size: 13 }), foregroundStyle(secondary), lineLimit(2)]}>
            {provider.detail}
          </Text>
        )}
        {provider.remaining.map((window) => (
          <VStack
            key={window.label}
            alignment="leading"
            spacing={2}
            modifiers={[
              accessibilityElement("ignore"),
              accessibilityLabel(
                window.label + ", " + window.remaining + " percent remaining. " + window.reset,
              ),
            ]}
          >
            <HStack spacing={3}>
              <Text
                modifiers={[
                  font({ size: large ? 13 : 11 }),
                  foregroundStyle(secondary),
                  lineLimit(1),
                ]}
              >
                {window.label}
              </Text>
              <Spacer minLength={2} />
              <Text
                modifiers={[
                  font({ size: large ? 15 : 12, weight: "semibold", design: "rounded" }),
                  foregroundStyle(primary),
                  layoutPriority(1),
                  lineLimit(1),
                ]}
              >
                {window.remaining}%
              </Text>
            </HStack>
            {large ? (
              <Text modifiers={[font({ size: 10 }), foregroundStyle(secondary), lineLimit(1)]}>
                {window.reset}
              </Text>
            ) : null}
          </VStack>
        ))}
        {large && provider.more > 0 ? (
          <Text modifiers={[font({ size: 11 }), foregroundStyle(secondary)]}>
            {provider.more} more in T3
          </Text>
        ) : null}
      </VStack>
    );
  };
  const root = [
    ...(props.url ? [widgetURL(props.url)] : []),
    ...(!system
      ? [containerBackground(background, "widget"), environment("colorScheme", appearance)]
      : []),
  ];
  if (!providers.length) {
    return (
      <VStack alignment="leading" spacing={7} modifiers={root}>
        {header}
        {!accessory ? <Spacer minLength={0} /> : null}
        <Text
          modifiers={[
            font({ size: accessory ? 12 : 16, weight: "medium" }),
            foregroundStyle(secondary),
            lineLimit(3),
          ]}
        >
          {props.providers
            ? (props.text?.noLimits ?? "No subscription limits available")
            : (props.text?.tapToConnect ?? "Open T3 Code to connect")}
        </Text>
      </VStack>
    );
  }
  if (accessory)
    return (
      <VStack alignment="leading" spacing={3} modifiers={root}>
        {providers.map(compactRow)}
      </VStack>
    );
  return (
    <VStack alignment="leading" spacing={small ? 5 : 8} modifiers={root}>
      {header}
      <Spacer minLength={0} />
      {small ? (
        <VStack alignment="leading" spacing={7}>
          {providers.map(compactRow)}
        </VStack>
      ) : (
        <HStack alignment="top" spacing={13}>
          {column(providers[0]!)}
          {providers[1] ? (
            <Rectangle
              modifiers={[frame({ width: 1 }), foregroundStyle(secondary), opacity(0.24)]}
            />
          ) : null}
          {providers.slice(1).map(column)}
        </HStack>
      )}
      {large ? <Spacer minLength={0} /> : null}
    </VStack>
  );
}

export default createWidget("SubscriptionUsage", SubscriptionUsage);
