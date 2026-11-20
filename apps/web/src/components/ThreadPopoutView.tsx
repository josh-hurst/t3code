import type { ScopedThreadRef } from "@t3tools/contracts";
import type { CSSProperties } from "react";

import { isElectron } from "../env";
import { isMacPlatform } from "../lib/utils";
import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentShellStatus } from "../state/shell";
import { useEnvironmentThread } from "../state/threads";
import { isThreadRouteSnapshotAuthoritative, resolveThreadRouteRenderState } from "../threadRoutes";
import ChatView from "./ChatView";
import { useOpenThreadFamily } from "./ThreadRouteView";
import { Button } from "./ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import { SidebarProvider } from "./ui/sidebar";

// No sidebar toggle here, so the title starts right after the window controls.
const titlebarStyle = {
  "--workspace-titlebar-content-left":
    isElectron && isMacPlatform(navigator.platform)
      ? "var(--desktop-window-controls-inset, 84px)"
      : "var(--workspace-gutter-start)",
} as CSSProperties;

/** One thread in its own floating window: the full chat, without the app's sidebar. */
export function ThreadPopoutView({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const shell = useQuietThreadShell(threadRef);
  const bootstrapComplete = isThreadRouteSnapshotAuthoritative(
    useEnvironmentShellStatus(threadRef.environmentId),
  );
  const unlistedRef = shell === null ? threadRef : null;
  const unlistedDetail = useEnvironmentThread(
    unlistedRef?.environmentId ?? null,
    unlistedRef?.threadId ?? null,
  );
  useOpenThreadFamily(threadRef, bootstrapComplete && unlistedRef !== null);
  const renderState = resolveThreadRouteRenderState({
    bootstrapComplete,
    serverThreadExists: shell !== null,
    serverThreadDeleted: shell?.deletedAt != null,
    unlistedThreadDetail: unlistedDetail,
    draftThreadExists: false,
  });

  return (
    <SidebarProvider
      defaultOpen={false}
      className="h-dvh! min-h-0!"
      data-window-glass-shell=""
      style={titlebarStyle}
    >
      <main
        className="relative flex h-dvh min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        data-window-glass-pane=""
      >
        {renderState === "ready" || (renderState === "loading" && shell !== null) ? (
          <ChatView
            environmentId={threadRef.environmentId}
            threadId={threadRef.threadId}
            routeKind="server"
          />
        ) : (
          // The chat header is the window's drag handle; without it the window still needs one.
          <div className="drag-region h-[var(--workspace-topbar-height)] shrink-0" />
        )}
        {renderState === "missing" ? (
          <Empty className="flex-1">
            <EmptyHeader>
              <EmptyTitle>This thread is gone</EmptyTitle>
              <EmptyDescription>
                It was deleted or archived after this window opened.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => window.close()}>
                Close window
              </Button>
            </EmptyContent>
          </Empty>
        ) : null}
      </main>
    </SidebarProvider>
  );
}
