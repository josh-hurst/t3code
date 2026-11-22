import { Link } from "@tanstack/react-router";
import { useGT } from "gt-react";

import { cn } from "../../lib/utils";
import { T3Wordmark } from "../T3Wordmark";

/** The wordmark that heads the sidebar's content and links home. */
export function SidebarBrand({ className }: { className?: string }) {
  const gt = useGT();
  return (
    <Link
      aria-label={gt("T3 Code home")}
      className={cn(
        "flex h-7 min-w-0 items-center overflow-hidden rounded-md px-(--sidebar-row-content-inset) text-sidebar-foreground outline-hidden ring-ring focus-visible:ring-2 focus-visible:ring-inset",
        className,
      )}
      to="/"
    >
      <span className="inline-flex min-w-0 items-baseline gap-1 text-base font-semibold tracking-tight">
        <T3Wordmark aria-label="T3" className="h-[1cap] w-auto shrink-0" />
        <span className="truncate text-sidebar-muted-foreground [text-box:trim-both_cap_alphabetic] supports-[text-box:trim-both_cap_alphabetic]:py-1">
          {/* oxlint-disable-next-line t3code/no-untranslated-copy -- product wordmark */}
          {"Code"}
        </span>
      </span>
    </Link>
  );
}
