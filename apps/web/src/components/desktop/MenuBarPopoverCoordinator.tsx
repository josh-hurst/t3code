import { MENU_BAR_POPOVER_FRAME_PREFIX } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { createPortal } from "react-dom";

import { AppWindowContext } from "../../lib/appWindow";
import { attachSidebarWindow } from "../sidebar/DetachedSidebarWindow";
import { MenuBarPopover } from "./MenuBarPopover";

function MenuBarPopoverPortal({
  view,
  onClose,
}: {
  readonly view: Window;
  readonly onClose: () => void;
}) {
  const closed = useEffectEvent(onClose);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the menu bar popover's lifecycle, theme, and stylesheet sync
  useEffect(
    () =>
      attachSidebarWindow(view, () => closed(), {
        title: "T3 Code",
        attachCommands: false,
      }),
    [view],
  );

  const closeNow = () => {
    if (!view.closed) view.close();
    onClose();
  };

  return createPortal(
    <AppWindowContext value={view}>
      <MenuBarPopover onClose={closeNow} />
    </AppWindowContext>,
    view.document.body,
  );
}

export function MenuBarPopoverCoordinator() {
  const [popoverWindow, setPopoverWindow] = useState<Window | null>(null);

  const openPopover = useEffectEvent(() => {
    if (popoverWindow && !popoverWindow.closed) popoverWindow.close();
    setPopoverWindow(
      window.open(
        "about:blank",
        `${MENU_BAR_POPOVER_FRAME_PREFIX}${Math.random().toString(36).slice(2)}`,
        "popup,width=340,height=460",
      ),
    );
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to desktop tray clicks over the bridge
  useEffect(() => {
    const subscribe = window.desktopBridge?.onMenuBarItemToggle;
    if (!subscribe) return;
    return subscribe(() => {
      openPopover();
    });
  }, []);

  if (popoverWindow === null || popoverWindow.closed) return null;

  return <MenuBarPopoverPortal view={popoverWindow} onClose={() => setPopoverWindow(null)} />;
}
