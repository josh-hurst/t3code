import { isElectron } from "../env";
import { isMacPlatform, isWindowsPlatform } from "./utils";

/** Desktop on macOS and Windows can show the blurred desktop behind its windows. */
export function isNativeWindowGlassSupported(): boolean {
  return isElectron && (isMacPlatform(navigator.platform) || isWindowsPlatform(navigator.platform));
}
