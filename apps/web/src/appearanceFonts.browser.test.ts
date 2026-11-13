import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { applyAppearanceFontVariables } from "./appearanceFonts";

function renderedFontSize(style: (probe: HTMLElement) => void): string {
  const probe = document.createElement("div");
  style(probe);
  document.body.append(probe);
  try {
    return getComputedStyle(probe).fontSize;
  } finally {
    probe.remove();
  }
}

const composerFontSize = () =>
  renderedFontSize((probe) => {
    // The composer editor's own size class.
    probe.className = "text-(length:--font-size-prompt,var(--text-sm))";
  });

const touchComposerFontSize = () =>
  renderedFontSize((probe) => {
    probe.style.fontSize = "var(--font-size-prompt-touch)";
  });

const basePreferences = {
  sans: "",
  code: "",
  composer: "",
  sidebar: "",
  chat: "",
  sizeInterface: 20,
  sizePrompt: 14,
  sizeCode: 13,
  sizeSidebar: null,
  sizeChat: null,
  smoothing: true,
  separate: false,
};

function nestedFontSize(markup: string): string {
  const host = document.createElement("div");
  host.innerHTML = markup;
  document.body.append(host);
  try {
    const probe = host.querySelector<HTMLElement>("[data-probe]");
    if (probe === null) throw new Error("missing probe");
    return getComputedStyle(probe).fontSize;
  } finally {
    host.remove();
  }
}

const chatFontSize = () =>
  nestedFontSize(
    '<div data-chat-message=""><div class="chat-markdown text-sm" data-probe></div></div>',
  );

const chatHeadingFontSize = () =>
  nestedFontSize(
    '<div data-chat-message=""><div class="chat-markdown text-sm"><h1 data-probe></h1></div></div>',
  );

const sidebarFontSize = () =>
  nestedFontSize('<div data-app-sidebar=""><span class="text-xs" data-probe></span></div>');

describe("applyAppearanceFontVariables", () => {
  it("sizes the composer from the interface size until fonts are set separately", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    try {
      applyAppearanceFontVariables(root, { ...basePreferences, separate: false });
      expect(composerFontSize()).toBe("17.5px");
      expect(touchComposerFontSize()).toBe("17.5px");

      applyAppearanceFontVariables(root, { ...basePreferences, separate: true });
      expect(composerFontSize()).toBe("14px");
      // iOS zooms into inputs under 16px.
      expect(touchComposerFontSize()).toBe("16px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });

  it("sizes chat and sidebar text from the interface size until set", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    try {
      applyAppearanceFontVariables(root, basePreferences);
      expect(chatFontSize()).toBe("17.5px");
      expect(chatHeadingFontSize()).toBe("25px");
      expect(sidebarFontSize()).toBe("15px");

      applyAppearanceFontVariables(root, { ...basePreferences, sizeChat: 16, sizeSidebar: 12 });
      expect(chatFontSize()).toBe("16px");
      // Headings keep their ratio to the chat size.
      expect(Number.parseFloat(chatHeadingFontSize())).toBeCloseTo((16 * 1.25) / 0.875, 1);
      expect(sidebarFontSize()).toBe("9px");
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });

  it("widens the numbered-list gutter only when the interface font's marker would clip", () => {
    const root = document.documentElement;
    const style = root.getAttribute("style");
    const gutter = (sans: string) => {
      applyAppearanceFontVariables(root, {
        ...basePreferences,
        sans,
        code: "",
        composer: "",
        sizeInterface: 16,
        sizePrompt: 14,
        sizeCode: 13,
        smoothing: true,
        separate: false,
      });
      const markdown = document.createElement("div");
      markdown.className = "chat-markdown";
      markdown.style.fontSize = "14px";
      const list = document.createElement("ol");
      markdown.append(list);
      document.body.append(markdown);
      try {
        return Number.parseFloat(getComputedStyle(list).paddingInlineStart);
      } finally {
        markdown.remove();
      }
    };
    try {
      // `0. ` in a 14px monospace font is about 25px, past the 20px default.
      expect(gutter("monospace")).toBeGreaterThan(24);
      expect(gutter("sans-serif")).toBe(20);
    } finally {
      if (style === null) root.removeAttribute("style");
      else root.setAttribute("style", style);
    }
  });
});
