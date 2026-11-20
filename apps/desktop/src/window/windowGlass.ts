import type * as Electron from "electron";

/** Where the OS can blur the desktop behind a window: vibrancy on macOS, acrylic on Windows. */
export function windowGlassSupported(platform: NodeJS.Platform): boolean {
  return platform === "darwin" || platform === "win32";
}

export function getInitialWindowBackgroundColor(shouldUseDarkColors: boolean): string {
  return shouldUseDarkColors ? "#000000" : "#ffffff";
}

/** Constructor options for a glass window; the page paints the theme tint over it. */
export function windowGlassOptions(
  platform: NodeJS.Platform,
): Electron.BrowserWindowConstructorOptions {
  if (platform === "darwin") return { vibrancy: "under-window", backgroundColor: "#00000000" };
  if (platform === "win32") return { backgroundMaterial: "acrylic", backgroundColor: "#00000000" };
  return {};
}

export function setWindowGlass(
  window: Electron.BrowserWindow,
  glass: boolean,
  platform: NodeJS.Platform,
  shouldUseDarkColors: boolean,
): void {
  if (window.isDestroyed() || !windowGlassSupported(platform)) return;
  if (platform === "darwin") window.setVibrancy(glass ? "under-window" : null);
  else window.setBackgroundMaterial(glass ? "acrylic" : "none");
  window.setBackgroundColor(
    glass ? "#00000000" : getInitialWindowBackgroundColor(shouldUseDarkColors),
  );
}
