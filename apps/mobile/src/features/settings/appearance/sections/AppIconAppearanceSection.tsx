import { useEffect, useState } from "react";
import { View } from "react-native";

import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { getAppIcon, setAppIcon, supportsAppIconChoice } from "../../../../native/appIcon";
import type { AppIconChoice } from "../../../../native/appIcon.types";
import { SettingsSection } from "../../components/SettingsSection";

export function AppIconAppearanceSection() {
  const [icon, setIcon] = useState<AppIconChoice | null>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- iOS owns the current alternate icon
  useEffect(() => {
    let cancelled = false;
    void getAppIcon().then((current) => {
      if (!cancelled) setIcon(current);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!supportsAppIconChoice) return null;

  const choose = (next: AppIconChoice) => {
    const previous = icon;
    setIcon(next);
    setAppIcon(next).catch(() => setIcon(previous));
  };

  return (
    <SettingsSection title="App icon">
      <View accessibilityRole="radiogroup">
        <SettingsChoiceRow
          label="Copper"
          disabled={icon === null}
          selected={icon === "copper"}
          onPress={() => choose("copper")}
        />
        <SettingsChoiceRow
          label="Blue"
          disabled={icon === null}
          selected={icon === "blue"}
          onPress={() => choose("blue")}
          separated
        />
      </View>
    </SettingsSection>
  );
}
