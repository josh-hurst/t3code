import { createContext, use } from "react";

export const AppWindowContext = createContext<Window | null>(null);

export function useAppWindow() {
  return use(AppWindowContext) ?? window;
}

const auxiliaryWindows = new Set<Window>();

export function registerAppWindow(view: Window) {
  auxiliaryWindows.add(view);
  return () => {
    auxiliaryWindows.delete(view);
  };
}

export function isAppWindowRegistered(view: Window) {
  return auxiliaryWindows.has(view);
}

export function getFocusedAppWindow() {
  for (const view of auxiliaryWindows) {
    if (!view.closed && view.document.hasFocus()) return view;
  }
  return window;
}
