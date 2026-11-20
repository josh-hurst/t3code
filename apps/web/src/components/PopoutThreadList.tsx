import { cn } from "../lib/utils";
import ThreadSidebar from "./Sidebar";
import type { SidebarRouteReveal } from "./sidebar/routeReveal";
import { Sidebar } from "./ui/sidebar";

// One per pop-out window (each has its own module scope), like AppSidebarLayout's in the main
// window: a fresh one on every open would read as a new route and clear the project filter.
const routeReveal: SidebarRouteReveal = { observedKey: null, pendingKey: null };

/**
 * The main window's thread sidebar (Recent, Working, Later, History, search) for a pop-out,
 * where choosing a thread shows it in the pop-out.
 */
export function PopoutThreadList({ className }: { readonly className?: string }) {
  return (
    <Sidebar
      collapsible="none"
      data-app-sidebar=""
      role="navigation"
      aria-label="Threads"
      className={cn("w-full", className)}
    >
      <ThreadSidebar routeReveal={routeReveal} />
    </Sidebar>
  );
}
