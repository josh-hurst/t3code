import type { CSSProperties } from "react";

import { isElectron } from "../env";
import { isMacPlatform } from "../lib/utils";
import type { ThreadRouteTarget } from "../threadRoutes";
import { ThreadRouteView } from "./ThreadRouteView";
import { PopoutThreadList } from "./PopoutThreadList";
import { SidebarProvider } from "./ui/sidebar";

// No sidebar toggle here, so the title starts right after the window controls.
const titlebarStyle = {
  "--workspace-titlebar-content-left":
    isElectron && isMacPlatform(navigator.platform)
      ? "var(--desktop-window-controls-inset, 84px)"
      : "var(--workspace-gutter-start)",
} as CSSProperties;

/**
 * A thread in its own floating window: the full chat, without the app's sidebar. It shows
 * whichever thread or draft the window is on; with neither, it lists threads to pick one.
 * A standby pop-out shows nothing until the main window gives it a thread.
 */
export function ThreadPopoutView({
  target,
  standby,
}: {
  readonly target: ThreadRouteTarget | null;
  readonly standby: boolean;
}) {
  return (
    <SidebarProvider
      defaultOpen={false}
      className="h-dvh! min-h-0!"
      data-window-glass-shell=""
      style={titlebarStyle}
    >
      {target !== null ? (
        <ThreadRouteView target={target} />
      ) : standby ? null : (
        <main
          className="relative flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
          data-window-glass-pane=""
        >
          {/* The chat header is the window's drag handle; without it the window still needs one. */}
          <div className="drag-region topbar-band h-[var(--workspace-topbar-height)] shrink-0" />
          <PopoutThreadList className="min-h-0 flex-1" />
        </main>
      )}
    </SidebarProvider>
  );
}
