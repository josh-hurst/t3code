import { useEffect, useEffectEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { useAtomValue } from "@effect/atom-react";

import { AppWindowContext, isAppWindowRegistered, registerAppWindow } from "../../lib/appWindow";
import { attachCommandWindow } from "../../shortcuts/dispatcher";
import { resolveShortcutCommand } from "../../keybindings";
import { primaryServerKeybindingsAtom } from "../../state/server";
import { useSidebar } from "../ui/sidebar";

export function attachSidebarWindow(
  view: Window,
  onClose: () => void,
  options?: {
    readonly title?: string;
    readonly attachCommands?: boolean;
  },
) {
  const target = view.document;
  target.title = options?.title ?? "Threads - T3 Code";
  const base = target.createElement("base");
  base.href = document.baseURI;
  target.head.append(base);
  const syncTheme = () => {
    for (const attribute of document.documentElement.attributes) {
      target.documentElement.setAttribute(attribute.name, attribute.value);
    }
    const removedAttributes = Array.from(target.documentElement.attributes).filter(
      (attribute) => !document.documentElement.hasAttribute(attribute.name),
    );
    for (const attribute of removedAttributes)
      target.documentElement.removeAttribute(attribute.name);
    target.body.className = document.body.className;
  };
  let styles: Element[] = [];
  const syncStyles = () => {
    for (const style of styles) style.remove();
    styles = [...document.querySelectorAll('style, link[rel="stylesheet"]')].map((style) => {
      const clone = style.cloneNode(true) as Element;
      target.head.append(clone);
      return clone;
    });
  };
  syncTheme();
  syncStyles();
  const themeObserver = new MutationObserver(syncTheme);
  themeObserver.observe(document.documentElement, { attributes: true });
  const isStylesheet = (node: Node) =>
    node instanceof Element && node.matches('style, link[rel="stylesheet"]');
  const styleObserver = new MutationObserver((changes) => {
    if (
      changes.some(
        (change) =>
          isStylesheet(change.target) ||
          Array.from(change.addedNodes).some(isStylesheet) ||
          Array.from(change.removedNodes).some(isStylesheet) ||
          (change.target.parentElement && isStylesheet(change.target.parentElement)),
      )
    )
      syncStyles();
  });
  styleObserver.observe(document.head, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ["href", "rel"],
  });
  const unregister = registerAppWindow(view);
  const detachCommands = options?.attachCommands === false ? null : attachCommandWindow(view);
  const onParentPageHide = () => view.close();
  view.addEventListener("pagehide", onClose);
  view.addEventListener("beforeunload", onClose);
  window.addEventListener("pagehide", onParentPageHide);
  view.focus();
  return () => {
    view.removeEventListener("pagehide", onClose);
    view.removeEventListener("beforeunload", onClose);
    window.removeEventListener("pagehide", onParentPageHide);
    themeObserver.disconnect();
    styleObserver.disconnect();
    detachCommands?.();
    unregister();
    base.remove();
    for (const style of styles) style.remove();
    // Strict Mode reattaches effects before this microtask, so only a real unmount closes the window.
    queueMicrotask(() => {
      if (!isAppWindowRegistered(view)) view.close();
    });
  };
}

export function DetachedSidebarWindow({
  view,
  onClose,
  children,
}: {
  readonly view: Window;
  readonly onClose: () => void;
  readonly children: ReactNode;
}) {
  const { toggleSidebar } = useSidebar();
  const keybindings = useAtomValue(primaryServerKeybindingsAtom);
  const closed = useEffectEvent(onClose);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- owns the popup's lifecycle, styles, theme, and keyboard subscriptions
  useEffect(() => attachSidebarWindow(view, () => closed()), [view]);

  return createPortal(
    <AppWindowContext value={view}>
      <div
        data-sidebar-window="detached"
        className="flex h-dvh min-h-0 flex-col bg-sidebar surface-grain text-sidebar-foreground dark:bg-(--surface-raised) [&_[data-sidebar=rail]]:hidden"
        onKeyDownCapture={(event) => {
          if (resolveShortcutCommand(event.nativeEvent, keybindings) !== "sidebar.toggle") return;
          event.preventDefault();
          event.stopPropagation();
          toggleSidebar();
        }}
      >
        {children}
      </div>
    </AppWindowContext>,
    view.document.body,
  );
}
