// Families iOS ships on every device; an unknown name silently falls back to the system font.
export const CHAT_FONTS = [
  { id: "system", label: "SF Pro", family: null },
  { id: "charter", label: "Charter", family: "Charter" },
  { id: "iowan", label: "Iowan Old Style", family: "Iowan Old Style" },
  { id: "georgia", label: "Georgia", family: "Georgia" },
  { id: "palatino", label: "Palatino", family: "Palatino" },
  { id: "avenir-next", label: "Avenir Next", family: "Avenir Next" },
] as const;

export type ChatFontId = (typeof CHAT_FONTS)[number]["id"];

export const DEFAULT_CHAT_FONT: ChatFontId = "system";

export function normalizeChatFont(value: unknown): ChatFontId {
  return CHAT_FONTS.find((font) => font.id === value)?.id ?? DEFAULT_CHAT_FONT;
}

export function chatFontFamily(id: ChatFontId): string | null {
  return CHAT_FONTS.find((font) => font.id === id)?.family ?? null;
}
