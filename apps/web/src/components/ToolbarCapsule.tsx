import type { ComponentPropsWithoutRef } from "react";

import { cn } from "../lib/utils";

/** Groups top bar controls in one filled capsule, the way a macOS toolbar groups its items. */
export function ToolbarCapsule({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex shrink-0 items-center gap-0.5 rounded-full border border-(--contrast-toolbar-border) bg-(--toolbar-control) shadow-xs/5 [-webkit-app-region:no-drag]",
        className,
      )}
      data-toolbar-capsule
      {...props}
    />
  );
}
