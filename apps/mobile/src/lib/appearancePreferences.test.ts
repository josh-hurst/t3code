import { describe, expect, it } from "vite-plus/test";

import { resolveAppearance, resolveAppearancePreferences } from "./appearancePreferences";

describe("appearancePreferences", () => {
  it("migrates the legacy markdownFontSize key to baseFontSize", () => {
    expect(resolveAppearancePreferences({ markdownFontSize: 18 }).baseFontSize).toBe(18);
    expect(
      resolveAppearancePreferences({ baseFontSize: 16, markdownFontSize: 18 }).baseFontSize,
    ).toBe(16);
  });

  it("follows the text size for chat until a chat size is set", () => {
    expect(resolveAppearance(resolveAppearancePreferences({ baseFontSize: 18 })).chatFontSize).toBe(
      18,
    );
    expect(
      resolveAppearance(resolveAppearancePreferences({ baseFontSize: 18, chatFontSize: 15 }))
        .chatFontSize,
    ).toBe(15);
  });
});
