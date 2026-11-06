import type { AppIconChoice } from "./appIcon.types";

export const supportsAppIconChoice = false;

export async function getAppIcon(): Promise<AppIconChoice> {
  return "copper";
}

export async function setAppIcon(_icon: AppIconChoice): Promise<void> {}
