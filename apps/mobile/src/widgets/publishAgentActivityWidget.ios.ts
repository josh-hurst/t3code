import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { PROJECT_FAVICON_MAX_DATA_URL_LENGTH } from "@t3tools/client-runtime/project-favicon-cache";
import { Atom } from "effect/reactivity";
import { requireOptionalNativeModule } from "expo";

import { m, type MessageResolver } from "../i18n/messages";
import { resolveProjectIconSymbol } from "../lib/projectIcon";
import { appAtomRegistry } from "../state/atom-registry";
import {
  agentActivityWidgetTimeline,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

let generation = 0;
let unsubscribe: (() => void) | undefined;
let last: { readonly source: AgentActivityWidgetSource; readonly publishedAt: number } | null =
  null;

export async function publishAgentActivityWidget(
  source: AgentActivityWidgetSource,
  resolve: MessageResolver = m,
) {
  const publishedAt = Date.now();
  last = { source, publishedAt };
  await updateTimeline(source, publishedAt, resolve);
}

/** Re-renders the last published state for a UI language switch, keeping its stale deadline. */
export async function republishAgentActivityWidget(resolve: MessageResolver) {
  if (last !== null) await updateTimeline(last.source, last.publishedAt, resolve);
}

async function updateTimeline(
  source: AgentActivityWidgetSource,
  publishedAt: number,
  resolve: MessageResolver,
) {
  const current = ++generation;
  unsubscribe?.();
  unsubscribe = undefined;
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./AgentActivityWidget");
  if (generation !== current) return;
  const timeline = agentActivityWidgetTimeline(source, publishedAt, resolve);
  const rows = source.kind === "snapshot" ? source.aggregate?.activities : undefined;
  if (!rows?.length) {
    widget.updateTimeline(timeline);
    return;
  }

  const [{ projectChipIconForThreadAtom }, { environmentProjects }] = await Promise.all([
    import("../state/entities"),
    import("../state/projects"),
  ]);
  if (generation !== current) return;
  const artwork = Atom.make((get) => {
    const projects = get(environmentProjects.projectsAtom);
    const icons: Record<string, string> = {};
    for (const row of rows) {
      const key = JSON.stringify([row.environmentId, row.projectTitle]);
      if (icons[key]) continue;
      const matches = projects.filter(
        (p) => p.environmentId === row.environmentId && p.title === row.projectTitle,
      );
      const symbol =
        matches.length === 1 ? resolveProjectIconSymbol(matches[0]?.projectIcon) : null;
      if (symbol) {
        icons[key] = typeof symbol.name === "string" ? symbol.name : symbol.name.ios;
        continue;
      }
      const uri = get(
        projectChipIconForThreadAtom(scopeThreadRef(row.environmentId, row.threadId)),
      );
      // Asset URLs can carry temporary access tokens. Only share the cached image bytes with WidgetKit.
      if (!uri?.startsWith("data:image/") || uri.length > PROJECT_FAVICON_MAX_DATA_URL_LENGTH)
        continue;
      icons[
        matches.length === 1
          ? key
          : JSON.stringify([row.environmentId, row.projectTitle, row.threadId])
      ] = uri;
    }
    return icons;
  });
  let previous: Record<string, string> | undefined;
  unsubscribe = appAtomRegistry.subscribe(
    artwork,
    (icons) => {
      if (current !== generation) return;
      if (
        previous &&
        Object.keys(previous).length === Object.keys(icons).length &&
        Object.entries(icons).every(([key, uri]) => previous?.[key] === uri)
      )
        return;
      try {
        widget.updateTimeline(
          timeline.map(({ date, props }) => ({ date, props: { ...props, localData: icons } })),
        );
        previous = icons;
      } catch (error) {
        console.warn("Could not update Agent Activity widget", error);
      }
    },
    { immediate: true },
  );
}
