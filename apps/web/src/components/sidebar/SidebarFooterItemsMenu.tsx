import { T, useMessages } from "gt-react";

import {
  getClientSettings,
  updateClientSettings,
  useClientSettings,
} from "../../hooks/useSettings";
import { MenuCheckboxItem, MenuGroup, MenuGroupLabel, MenuItem, MenuSeparator } from "../ui/menu";
import {
  isDefaultSidebarFooterVisibility,
  resolveSidebarFooterVisibility,
  RESET_SIDEBAR_FOOTER_ITEMS,
  setSidebarFooterItem,
  SIDEBAR_FOOTER_ITEMS,
} from "./sidebarFooterItems";

/** Menu body that shows and hides sidebar footer buttons. The footer's context menu and Settings share it. */
export function SidebarFooterItemsMenuItems() {
  const visibility = useClientSettings(resolveSidebarFooterVisibility);
  const m = useMessages();
  return (
    <>
      <MenuGroup>
        <MenuGroupLabel>
          <T>Show in sidebar footer</T>
        </MenuGroupLabel>
        {SIDEBAR_FOOTER_ITEMS.map((item) => (
          <MenuCheckboxItem
            key={item.id}
            checked={visibility[item.id]}
            onCheckedChange={(checked) =>
              updateClientSettings({
                sidebarFooterItems: setSidebarFooterItem(getClientSettings(), item, checked),
              })
            }
          >
            {m(item.label)}
          </MenuCheckboxItem>
        ))}
      </MenuGroup>
      <MenuSeparator />
      <MenuItem
        disabled={isDefaultSidebarFooterVisibility(visibility)}
        onClick={() => updateClientSettings(RESET_SIDEBAR_FOOTER_ITEMS)}
      >
        <T>Reset to default</T>
      </MenuItem>
    </>
  );
}
