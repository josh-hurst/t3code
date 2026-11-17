import type { MOBILE_TYPOGRAPHY_SCALE as DEFAULT_SCALE } from "./typographyScale";

// Apple's text styles (body 17, subheadline 15, title1 28), drawn in SF Pro.
export const MOBILE_TYPOGRAPHY_SCALE: Record<
  keyof typeof DEFAULT_SCALE,
  { readonly fontSize: number; readonly lineHeight: number }
> = {
  micro: { fontSize: 11, lineHeight: 13 },
  caption: { fontSize: 12, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 18 },
  footnote: { fontSize: 15, lineHeight: 20 },
  body: { fontSize: 17, lineHeight: 23 },
  headline: { fontSize: 17, lineHeight: 22 },
  title: { fontSize: 20, lineHeight: 25 },
  largeTitle: { fontSize: 28, lineHeight: 34 },
  display: { fontSize: 34, lineHeight: 41 },
};
