import { Observe } from "expo-observe";

// Mobile crash and startup-timing telemetry is disabled in this fork.
export const crashReportingAvailable: boolean = false;

export async function setCrashReportsEnabled(_enabled: boolean) {
  Observe.configure({ dispatchingEnabled: false });
}

void setCrashReportsEnabled(false);
