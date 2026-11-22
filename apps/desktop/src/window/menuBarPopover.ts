export interface ScreenRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PopoverSize {
  readonly width: number;
  readonly height: number;
}

export const MENU_BAR_POPOVER_WIDTH = 340;
export const MENU_BAR_POPOVER_HEIGHT = 460;
export const MENU_BAR_POPOVER_GAP_PX = 6;
export const MENU_BAR_POPOVER_EDGE_MARGIN_PX = 8;
// Clicking the tray icon on macOS can blur and close the popover right before the tray click fires.
export const TRAY_CLICK_BLUR_SUPPRESS_MS = 250;

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function computeMenuBarPopoverBounds(input: {
  readonly trayBounds: ScreenRect;
  readonly workArea: ScreenRect;
  readonly size?: PopoverSize;
  readonly gap?: number;
  readonly margin?: number;
}): ScreenRect {
  const targetWidth = input.size?.width ?? MENU_BAR_POPOVER_WIDTH;
  const targetHeight = input.size?.height ?? MENU_BAR_POPOVER_HEIGHT;
  const gap = input.gap ?? MENU_BAR_POPOVER_GAP_PX;
  const margin = input.margin ?? MENU_BAR_POPOVER_EDGE_MARGIN_PX;
  const { trayBounds, workArea } = input;

  const horizontalMargin = workArea.width >= targetWidth + margin * 2 ? margin : 0;
  const width = Math.round(
    Math.min(targetWidth, Math.max(0, workArea.width - horizontalMargin * 2)),
  );
  const minX = workArea.x + horizontalMargin;
  const maxX = Math.max(minX, workArea.x + workArea.width - horizontalMargin - width);
  const centeredX = Math.round(trayBounds.x + trayBounds.width / 2 - width / 2);
  const x = clamp(centeredX, minX, maxX);

  const verticalMargin = workArea.height >= targetHeight + gap + margin ? margin : 0;
  const height = Math.round(
    Math.min(targetHeight, Math.max(0, workArea.height - gap - verticalMargin)),
  );
  const trayCenterY = trayBounds.y + trayBounds.height / 2;
  const workAreaMidY = workArea.y + workArea.height / 2;
  const idealY =
    trayCenterY >= workAreaMidY
      ? Math.round(Math.min(workArea.y + workArea.height, trayBounds.y) - gap - height)
      : Math.round(Math.max(workArea.y, trayBounds.y + trayBounds.height) + gap);
  const minY = workArea.y + (trayCenterY >= workAreaMidY ? verticalMargin : 0);
  const maxY = Math.max(
    minY,
    workArea.y + workArea.height - (trayCenterY >= workAreaMidY ? 0 : verticalMargin) - height,
  );
  const y = clamp(idealY, minY, maxY);

  return { x, y, width, height };
}

export type MenuBarTrayClickAction = "open" | "close" | "ignore";

export function decideMenuBarTrayClick(input: {
  readonly isOpen: boolean;
  readonly lastDismissedByBlurAtMs: number | null;
  readonly nowMs: number;
  readonly blurSuppressMs?: number;
}): MenuBarTrayClickAction {
  if (input.isOpen) return "close";
  const suppressMs = input.blurSuppressMs ?? TRAY_CLICK_BLUR_SUPPRESS_MS;
  if (
    input.lastDismissedByBlurAtMs !== null &&
    input.nowMs - input.lastDismissedByBlurAtMs >= 0 &&
    input.nowMs - input.lastDismissedByBlurAtMs < suppressMs
  ) {
    return "ignore";
  }
  return "open";
}
