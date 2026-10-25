import type { SVGProps } from "react";

// Text rather than outlined glyphs, so the viewBox is sized to a bold cap
// height of 57 and textLength pins the width whatever font the UI resolves.
export function AppWordmark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg {...props} viewBox="0 0 88 57" xmlns="http://www.w3.org/2000/svg">
      <text
        x="0"
        y="57"
        fontSize="79"
        fontWeight="700"
        textLength="88"
        lengthAdjust="spacingAndGlyphs"
        fill="currentColor"
      >
        J6
      </text>
    </svg>
  );
}
