import type { EnvironmentId, UsageLimitDrivers } from "@t3tools/contracts";
import { makeWindow } from "@t3tools/shared/usageFormat";
import { useState } from "react";

import { serverEnvironment } from "~/state/server";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const COLLAPSED_SOURCES = 5;

type DriversWindow = "24h" | "7d";

const SOURCE_SUFFIX = { subagent: "Subagent", mcp: "MCP", skill: "Skill" } as const;

function percent(share: number): string {
  return `${Math.round(share * 100)}%`;
}

function sourceLabel(source: UsageLimitDrivers["sources"][number]): string {
  const name = source.kind === "skill" ? `/${source.name}` : source.name;
  return `${name} ${SOURCE_SUFFIX[source.kind]}`;
}

/** Claude Code records what it charges each call to; T3 reads the same history it writes. */
export function ComposerLimitDrivers({ environmentId }: { readonly environmentId: EnvironmentId }) {
  // Fixed when the panel opens so the query keeps one key while it is shown.
  const [windows] = useState(() => {
    const now = new Date();
    return {
      "24h": { ...makeWindow(1, now, "hour"), drivers: "claude" as const },
      "7d": { ...makeWindow(7, now), drivers: "claude" as const },
    };
  });
  const [window, setWindow] = useState<DriversWindow>("24h");
  const [expanded, setExpanded] = useState(false);
  const { data, error, isPending } = useEnvironmentQuery(
    serverEnvironment.usageSummary({ environmentId, input: windows[window] }),
  );
  const drivers = data?.drivers;
  const sources = drivers?.sources ?? [];
  const shownSources = expanded ? sources : sources.slice(0, COLLAPSED_SOURCES);
  const causes: ReadonlyArray<[number, string]> = drivers
    ? [
        [drivers.largeContextShare, "ran above 150k context"],
        [drivers.subagentHeavyShare, "came from subagent-heavy sessions"],
        [drivers.parallelShare, "ran while 4+ sessions were in parallel"],
        [drivers.longSessionShare, "came from sessions active for 8+ hours"],
      ]
    : [];

  return (
    <div className="flex min-w-0 flex-col gap-1.5 border-t border-border/60 pt-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-foreground">What's using your limits?</span>
        <ToggleGroup
          aria-label="Usage window"
          variant="segmented"
          value={[window]}
          onValueChange={(value) => {
            const next = value[0];
            if (next === "24h" || next === "7d") {
              setWindow(next);
              setExpanded(false);
            }
          }}
        >
          <Toggle value="24h">24h</Toggle>
          <Toggle value="7d">7d</Toggle>
        </ToggleGroup>
      </div>
      <span className="text-xs text-muted-foreground">
        {window === "24h" ? "Last 24h" : "Last 7 days"} · approximate, overlapping measures · this
        machine only, excludes claude.ai
      </span>
      {drivers === undefined ? (
        <span className="text-xs text-muted-foreground">
          {error ?? (isPending ? "Reading Claude history…" : "No Claude usage in this window.")}
        </span>
      ) : drivers.costUsd === 0 ? (
        <span className="text-xs text-muted-foreground">No Claude usage in this window.</span>
      ) : (
        <>
          <div className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-xs">
            {causes.map(([share, label]) => (
              <div key={label} className="contents">
                <span className="text-end font-medium text-foreground tabular-nums">
                  {percent(share)}
                </span>
                <span className="text-muted-foreground">{label}</span>
              </div>
            ))}
          </div>
          {shownSources.length > 0 ? (
            <div className="grid grid-cols-[minmax(0,1fr)_minmax(3rem,8rem)_auto] items-center gap-x-3 gap-y-1 text-xs">
              {shownSources.map((source) => (
                <div key={`${source.kind}:${source.name}`} className="contents">
                  <span className="truncate text-muted-foreground">{sourceLabel(source)}</span>
                  <span className="relative h-1.5 rounded-full bg-muted">
                    <span
                      className="absolute inset-y-0 left-0 rounded-full bg-primary"
                      style={{ width: `${Math.max(2, source.share * 100)}%` }}
                    />
                  </span>
                  <span className="text-end font-medium text-foreground tabular-nums">
                    {percent(source.share)}
                  </span>
                </div>
              ))}
            </div>
          ) : null}
          {sources.length > COLLAPSED_SOURCES ? (
            <Button
              size="xs"
              variant="link"
              className="self-start"
              onClick={() => setExpanded((current) => !current)}
            >
              {expanded ? "Show less" : `Show ${sources.length - COLLAPSED_SOURCES} more`}
            </Button>
          ) : null}
        </>
      )}
    </div>
  );
}
