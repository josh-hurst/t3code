export const FONT_FAMILIES = {
  regular: "DMSans-Regular",
  medium: "DMSans-Medium",
  bold: "DMSans-Bold",
} as const;

// DM Sans ships one file per weight, so the family carries the weight.
export const FONT_WEIGHTS = { regular: "normal", medium: "normal", bold: "normal" } as const;
