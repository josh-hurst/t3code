import { Platform, View } from "react-native";

import { AppText as Text } from "../../../../components/ui/AppText";
import { ListChoiceRow } from "../../../../components/ui/ListChoiceRow";
import {
  BASE_FONT_SIZE_STEP,
  MAX_BASE_FONT_SIZE,
  MIN_BASE_FONT_SIZE,
} from "../../../../lib/appearancePreferences";
import { CHAT_FONTS } from "../../../../lib/chatFonts";
import { FONT_FAMILIES } from "../../../../lib/fontFamilies";
import { SettingsSection } from "../../components/SettingsSection";
import { SettingsSwitchRow } from "../../components/SettingsSwitchRow";
import { useAppearancePreferences } from "../AppearancePreferencesProvider";
import { FontSizeSliderRow } from "../components/FontSizeSliderRow";

export function ChatFontAppearanceSection() {
  const { isReady, appearance, chatFont, setChatFont, setChatFontSize } =
    useAppearancePreferences();
  const customSize = appearance.isChatFontSizeCustom;
  return (
    <SettingsSection title="Chat">
      <SettingsSwitchRow
        disabled={!isReady}
        icon="textformat.size"
        label="Custom text size"
        onValueChange={(enabled) => setChatFontSize(enabled ? appearance.chatFontSize : null)}
        value={customSize}
      />
      {customSize ? (
        <FontSizeSliderRow
          disabled={!isReady}
          icon="textformat.size"
          label="Text size"
          max={MAX_BASE_FONT_SIZE}
          min={MIN_BASE_FONT_SIZE}
          onChange={setChatFontSize}
          step={BASE_FONT_SIZE_STEP}
          value={appearance.chatFontSize}
          valueLabel={`${appearance.chatFontSize} pt`}
        />
      ) : null}
      {Platform.OS === "ios" ? (
        <View accessibilityRole="radiogroup">
          {CHAT_FONTS.map((font) => (
            <ListChoiceRow
              key={font.id}
              label={font.label}
              leading={
                <Text
                  className="w-8 text-center text-foreground"
                  style={{ fontFamily: font.family ?? FONT_FAMILIES.regular, fontSize: 20 }}
                >
                  Aa
                </Text>
              }
              disabled={!isReady}
              selected={chatFont === font.id}
              onPress={() => setChatFont(font.id)}
              separated
            />
          ))}
        </View>
      ) : null}
    </SettingsSection>
  );
}
