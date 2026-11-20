import { isElectron } from "../env";
import { isMacPlatform, isWindowsPlatform } from "./utils";

/** Desktop on macOS and Windows can show the blurred desktop behind its windows. */
export function isNativeWindowGlassSupported(): boolean {
  return isElectron && (isMacPlatform(navigator.platform) || isWindowsPlatform(navigator.platform));
}

let glassAtLaunch: boolean | null = null;

/** Records the first saved Window glass setting this page sees: the one its window was created with. */
export function noteWindowGlassAtLaunch(enabled: boolean): void {
  glassAtLaunch ??= enabled;
}

/** Whether this window was created with glass; null until settings have loaded. */
export function windowGlassAtLaunch(): boolean | null {
  return glassAtLaunch;
}
