import { T, useGT, Var } from "gt-react";
import { ChevronDownIcon } from "lucide-react";

import { updateClientSettings, useClientSettings } from "../../hooks/useSettings";
import { SidebarFooterItemsMenuItems } from "../sidebar/SidebarFooterItemsMenu";
import {
  isDefaultSidebarFooterVisibility,
  resolveSidebarFooterVisibility,
  RESET_SIDEBAR_FOOTER_ITEMS,
  SIDEBAR_FOOTER_ITEMS,
} from "../sidebar/sidebarFooterItems";
import { Button } from "../ui/button";
import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";

export function SidebarFooterItemsRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const visibility = useClientSettings(resolveSidebarFooterVisibility);
  const enabled = SIDEBAR_FOOTER_ITEMS.filter((item) => visibility[item.id]).length;
  return (
    <SettingsRow
      {...searchableSetting("sidebar-footer-items")}
      description={gt(
        "Choose which buttons sit beside Settings at the bottom of the sidebar. You can also right-click them.",
      )}
      resetAction={
        isDefaultSidebarFooterVisibility(visibility) ? null : (
          <SettingResetButton
            ariaLabel={gt("Reset sidebar footer to default")}
            onClick={() => updateClientSettings(RESET_SIDEBAR_FOOTER_ITEMS)}
          />
        )
      }
      control={
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="outline"
                size="sm"
                className="w-full justify-between sm:w-40"
                aria-label={gt("Sidebar footer: {enabled} of {total} on", {
                  enabled,
                  total: SIDEBAR_FOOTER_ITEMS.length,
                })}
              />
            }
          >
            <T>
              <Var>{enabled}</Var> of <Var>{SIDEBAR_FOOTER_ITEMS.length}</Var> on
            </T>
            <ChevronDownIcon aria-hidden />
          </MenuTrigger>
          <MenuPopup align="end">
            <SidebarFooterItemsMenuItems />
          </MenuPopup>
        </Menu>
      }
    />
  );
}
