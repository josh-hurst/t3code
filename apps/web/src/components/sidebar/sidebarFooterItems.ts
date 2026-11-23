import type { ClientSettings } from "@t3tools/contracts";
import { msg } from "gt-react";

// Ids are stored in client settings, so never rename one. Settings is not listed: it always
// shows, so there is always a way back to this choice.
export const SIDEBAR_FOOTER_ITEMS = [
  { id: "pullRequests", label: msg("Pull requests"), defaultVisible: false },
  {
    id: "issues",
    label: msg("Issues", { $context: "sidebar link to the list of issues" }),
    defaultVisible: false,
  },
  { id: "changes", label: msg("Changes"), defaultVisible: true },
  { id: "usage", label: msg("Usage"), defaultVisible: true },
] as const;

type SidebarFooterItem = (typeof SIDEBAR_FOOTER_ITEMS)[number];
export type SidebarFooterItemId = SidebarFooterItem["id"];
export type SidebarFooterVisibility = Readonly<Record<SidebarFooterItemId, boolean>>;
type SidebarFooterItemSettings = Pick<ClientSettings, "sidebarFooterItems">;

export function resolveSidebarFooterVisibility(
  settings: SidebarFooterItemSettings,
): SidebarFooterVisibility {
  return Object.fromEntries(
    SIDEBAR_FOOTER_ITEMS.map((item) => [
      item.id,
      settings.sidebarFooterItems[item.id] ?? item.defaultVisible,
    ]),
  ) as Record<SidebarFooterItemId, boolean>;
}

/** Stores only choices that differ from the default, so a later default change reaches everyone else. */
export function setSidebarFooterItem(
  settings: SidebarFooterItemSettings,
  item: SidebarFooterItem,
  visible: boolean,
): ClientSettings["sidebarFooterItems"] {
  const { [item.id]: _previous, ...rest } = settings.sidebarFooterItems;
  return visible === item.defaultVisible ? rest : { ...rest, [item.id]: visible };
}

export function isDefaultSidebarFooterVisibility(visibility: SidebarFooterVisibility) {
  return SIDEBAR_FOOTER_ITEMS.every((item) => visibility[item.id] === item.defaultVisible);
}

export const RESET_SIDEBAR_FOOTER_ITEMS = {
  sidebarFooterItems: {},
} satisfies Partial<ClientSettings>;
