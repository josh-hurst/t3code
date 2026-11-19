import { describe, expect, it } from "vite-plus/test";

import {
  resolveAppearance,
  resolveAppearancePreferences,
  resolveComposerTextRole,
} from "./appearancePreferences";

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

  it("scales the iOS composer text with the system text size", () => {
    const body = { fontSize: 16, lineHeight: 23 };
    expect(resolveComposerTextRole(body, 1, "ios")).toEqual(body);
    expect(resolveComposerTextRole(body, 2.643, "ios")).toEqual({
      fontSize: 16 * 2.643,
      lineHeight: 23 * 2.643,
    });
    expect(resolveComposerTextRole(body, 2.643, "android")).toEqual(body);
  });
});
