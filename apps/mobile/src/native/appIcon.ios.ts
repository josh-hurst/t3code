import { requireOptionalNativeModule } from "expo";

import type { AppIconChoice } from "./appIcon.types";

// Must match the alternate icon name the iOS build registers (see plugins/withAlternateAppIcon.cjs).
const BLUE_ICON_NAME = "app-icon-blue";

const nativeControls = requireOptionalNativeModule<{
  getAlternateAppIcon(): Promise<string | null>;
  setAlternateAppIcon(name: string | null): Promise<void>;
}>("T3NativeControls");

export const supportsAppIconChoice = nativeControls !== null;

export async function getAppIcon(): Promise<AppIconChoice> {
  return (await nativeControls?.getAlternateAppIcon()) === BLUE_ICON_NAME ? "blue" : "copper";
}

export async function setAppIcon(icon: AppIconChoice): Promise<void> {
  await nativeControls?.setAlternateAppIcon(icon === "blue" ? BLUE_ICON_NAME : null);
}
