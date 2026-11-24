// @effect-diagnostics nodeBuiltinImport:off -- Reads the Windows build number synchronously at window creation.
import * as NodeOS from "node:os";

import type * as Electron from "electron";

// Electron's backgroundMaterial uses DWMWA_SYSTEMBACKDROP_TYPE (Windows 11 22H2, build 22621+).
// Older Windows 10/11 builds skip SetBackgroundMaterial while still marking the window translucent,
// so we supply DWM frame extension and SetWindowCompositionAttribute directly there.
const WINDOWS_11_22H2_BUILD = 22_621;
const WINDOWS_10_ACRYLIC_BUILD = 17_134;

const WCA_ACCENT_POLICY = 19;
const ACCENT_POLICY_SIZE_BYTES = 16;
const ACCENT_ENABLE_BLURBEHIND = 3;
const ACCENT_ENABLE_ACRYLICBLURBEHIND = 4;
const ACCENT_FLAG_BLURBEHIND = 2;
const ACCENT_FLAG_ACRYLIC = 0;
// Windows 10 acrylic ignores alpha 0; alpha 1 activates blur while letting page CSS paint the tint.
const ACRYLIC_MINIMAL_ALPHA_COLOR = 0x01_00_00_00;

export const WM_ENTERSIZEMOVE = 0x0231;
export const WM_EXITSIZEMOVE = 0x0232;

export type WindowsLegacyGlassMode = "acrylic" | "blur-behind";

export interface WindowsAccentPolicy {
  readonly accentState: number;
  readonly accentFlags: number;
  readonly gradientColor: number;
  readonly animationId: number;
}

export interface WindowsLegacyGlassApi {
  readonly extendFrameIntoClientArea: (windowHandle: bigint) => void;
  readonly setAccentPolicy: (
    windowHandle: bigint,
    pointerBytes: 4 | 8,
    policy: WindowsAccentPolicy,
  ) => boolean;
}

export interface LegacyGlassWindowLike {
  readonly isDestroyed: () => boolean;
  readonly getNativeWindowHandle: () => Buffer;
  on(event: "show", listener: () => void): unknown;
  on(event: "maximize", listener: () => void): unknown;
  on(event: "unmaximize", listener: () => void): unknown;
  on(event: "restore", listener: () => void): unknown;
  on(event: "leave-full-screen", listener: () => void): unknown;
  readonly hookWindowMessage?: (message: number, callback: () => void) => void;
}

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

/** Returns the Win32 composition fallback needed on Windows builds before 11 22H2, or null. */
export function windowsLegacyGlassMode(
  platform: NodeJS.Platform,
  osRelease: string = NodeOS.release(),
): WindowsLegacyGlassMode | null {
  if (platform !== "win32") return null;
  const parts = osRelease.split(".");
  const major = Number.parseInt(parts[0] ?? "", 10);
  const build = Number.parseInt(parts[2] ?? "", 10);
  if (!Number.isFinite(major) || !Number.isFinite(build)) return null;
  if (major > 10 || (major === 10 && build >= WINDOWS_11_22H2_BUILD)) return null;
  if (major < 10) return null;
  return build >= WINDOWS_10_ACRYLIC_BUILD ? "acrylic" : "blur-behind";
}

export function accentPolicyForMode(mode: WindowsLegacyGlassMode): WindowsAccentPolicy {
  if (mode === "acrylic") {
    return {
      accentState: ACCENT_ENABLE_ACRYLICBLURBEHIND,
      accentFlags: ACCENT_FLAG_ACRYLIC,
      gradientColor: ACRYLIC_MINIMAL_ALPHA_COLOR,
      animationId: 0,
    };
  }
  return {
    accentState: ACCENT_ENABLE_BLURBEHIND,
    accentFlags: ACCENT_FLAG_BLURBEHIND,
    gradientColor: 0,
    animationId: 0,
  };
}

function readNativeWindowHandle(buffer: Buffer): {
  readonly handle: bigint;
  readonly pointerBytes: 4 | 8;
} {
  if (buffer.length === 8) return { handle: buffer.readBigUInt64LE(), pointerBytes: 8 };
  if (buffer.length === 4) return { handle: BigInt(buffer.readUInt32LE()), pointerBytes: 4 };
  throw new Error(`Unsupported Windows window handle size: ${String(buffer.length)} bytes.`);
}

export function applyWindowsLegacyGlassWithApi(
  handleBuffer: Buffer,
  mode: WindowsLegacyGlassMode,
  api: WindowsLegacyGlassApi,
): boolean {
  const { handle, pointerBytes } = readNativeWindowHandle(handleBuffer);
  api.extendFrameIntoClientArea(handle);
  return api.setAccentPolicy(handle, pointerBytes, accentPolicyForMode(mode));
}

let windowsLegacyGlassApiPromise: Promise<WindowsLegacyGlassApi> | undefined;

function loadWindowsLegacyGlassApi(): Promise<WindowsLegacyGlassApi> {
  windowsLegacyGlassApiPromise ??= import("ffi-rs").then(({ DataType, load, open }) => {
    const dwmapi = "t3-glass-dwmapi";
    const user32 = "t3-glass-user32";
    open({ library: dwmapi, path: "dwmapi.dll" });
    open({ library: user32, path: "user32.dll" });

    const accentPolicyType = {
      AccentState: DataType.U32,
      AccentFlags: DataType.U32,
      GradientColor: DataType.U32,
      AnimationId: DataType.U32,
    };
    const compositionDataType64 = {
      Attrib: DataType.U32,
      pvData: accentPolicyType,
      cbData: DataType.U64,
    };
    const compositionDataType32 = {
      Attrib: DataType.U32,
      pvData: accentPolicyType,
      cbData: DataType.U32,
    };

    const fullClientMargins = Buffer.alloc(16);
    fullClientMargins.writeInt32LE(-1, 0);
    fullClientMargins.writeInt32LE(-1, 4);
    fullClientMargins.writeInt32LE(-1, 8);
    fullClientMargins.writeInt32LE(-1, 12);

    return {
      extendFrameIntoClientArea: (windowHandle) => {
        load({
          library: dwmapi,
          funcName: "DwmExtendFrameIntoClientArea",
          retType: DataType.I32,
          paramsType: [DataType.BigInt, DataType.U8Array],
          paramsValue: [windowHandle, fullClientMargins],
        });
      },
      setAccentPolicy: (windowHandle, pointerBytes, policy) =>
        load({
          library: user32,
          funcName: "SetWindowCompositionAttribute",
          retType: DataType.I32,
          paramsType: [
            DataType.BigInt,
            pointerBytes === 8 ? compositionDataType64 : compositionDataType32,
          ],
          paramsValue: [
            windowHandle,
            {
              Attrib: WCA_ACCENT_POLICY,
              pvData: {
                AccentState: policy.accentState,
                AccentFlags: policy.accentFlags,
                GradientColor: policy.gradientColor,
                AnimationId: policy.animationId,
              },
              cbData: ACCENT_POLICY_SIZE_BYTES,
            },
          ],
        }) !== 0,
    } satisfies WindowsLegacyGlassApi;
  });
  return windowsLegacyGlassApiPromise;
}

/**
 * Installs Windows 10 / 11 21H2 backdrop blur on a glass BrowserWindow and keeps it intact
 * across show/maximize/resize transitions where Chromium resets DWM frame margins.
 */
export function installWindowsLegacyGlass(
  window: LegacyGlassWindowLike,
  platform: NodeJS.Platform,
  options?: {
    readonly osRelease?: string;
    readonly loadApi?: () => Promise<WindowsLegacyGlassApi>;
  },
): boolean {
  const baseMode = windowsLegacyGlassMode(platform, options?.osRelease);
  if (baseMode === null) return false;

  const loadApi = options?.loadApi ?? loadWindowsLegacyGlassApi;
  let currentMode: WindowsLegacyGlassMode = baseMode;
  let resolvedApi: WindowsLegacyGlassApi | undefined;
  let pendingLoad: Promise<void> | undefined;

  const apply = () => {
    if (window.isDestroyed()) return;
    if (resolvedApi !== undefined) {
      try {
        applyWindowsLegacyGlassWithApi(window.getNativeWindowHandle(), currentMode, resolvedApi);
      } catch {}
      return;
    }
    pendingLoad ??= loadApi()
      .then((api) => {
        resolvedApi = api;
        if (!window.isDestroyed()) apply();
      })
      .catch(() => undefined);
  };

  window.on("show", apply);
  window.on("maximize", apply);
  window.on("unmaximize", apply);
  window.on("restore", apply);
  window.on("leave-full-screen", apply);

  // Windows 10 acrylic stalls dragging/resizing; step down to blur-behind during the modal loop.
  if (baseMode === "acrylic" && typeof window.hookWindowMessage === "function") {
    try {
      window.hookWindowMessage(WM_ENTERSIZEMOVE, () => {
        currentMode = "blur-behind";
        apply();
      });
      window.hookWindowMessage(WM_EXITSIZEMOVE, () => {
        currentMode = "acrylic";
        apply();
      });
    } catch {}
  }

  apply();
  return true;
}
