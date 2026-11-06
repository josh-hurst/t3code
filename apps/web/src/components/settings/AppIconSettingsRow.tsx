import type { DesktopAppIcon } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { isElectron } from "~/env";
import { isMacPlatform } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const APP_ICON_LABELS: Record<DesktopAppIcon, string> = {
  copper: "Copper",
  blue: "Blue",
};

export function AppIconSettingsRow() {
  const bridge = window.desktopBridge;
  const [icon, setIcon] = useState<DesktopAppIcon | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the choice the desktop main process stores
  useEffect(() => {
    if (!bridge) return;
    let cancelled = false;
    void bridge.getAppIcon().then((current) => {
      if (!cancelled) setIcon(current);
    });
    return () => {
      cancelled = true;
    };
  }, [bridge]);

  if (!bridge || !isElectron || !isMacPlatform(navigator.platform) || icon === null) return null;

  const choose = (next: DesktopAppIcon) => {
    setIcon(next);
    void bridge.setAppIcon(next);
  };

  return (
    <SettingsRow
      {...searchableSetting("app-icon")}
      description="Choose the Dock icon. It follows light and dark mode."
      resetAction={
        icon !== "copper" ? (
          <SettingResetButton label="app icon" onClick={() => choose("copper")} />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Select
            value={icon}
            onValueChange={(value) => {
              if (value === "copper" || value === "blue") choose(value);
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label="App icon">
              <SelectValue>{APP_ICON_LABELS[icon]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="copper">Copper (default)</SelectItem>
              <SelectItem value="blue">Blue</SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
