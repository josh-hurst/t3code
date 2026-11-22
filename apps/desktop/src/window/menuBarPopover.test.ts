import { assert, describe, it } from "@effect/vitest";

import {
  computeMenuBarPopoverBounds,
  decideMenuBarTrayClick,
  MENU_BAR_POPOVER_EDGE_MARGIN_PX,
  MENU_BAR_POPOVER_GAP_PX,
  MENU_BAR_POPOVER_HEIGHT,
  MENU_BAR_POPOVER_WIDTH,
  TRAY_CLICK_BLUR_SUPPRESS_MS,
} from "./menuBarPopover.ts";

describe("computeMenuBarPopoverBounds", () => {
  it("centers the popover horizontally under a top menu bar icon", () => {
    const bounds = computeMenuBarPopoverBounds({
      trayBounds: { x: 1000, y: 0, width: 28, height: 25 },
      workArea: { x: 0, y: 25, width: 1512, height: 957 },
    });

    assert.deepEqual(bounds, {
      x: 1000 + 14 - MENU_BAR_POPOVER_WIDTH / 2,
      y: 25 + MENU_BAR_POPOVER_GAP_PX,
      width: MENU_BAR_POPOVER_WIDTH,
      height: MENU_BAR_POPOVER_HEIGHT,
    });
  });

  it("clamps to the right and left work area edges with margin", () => {
    const rightClamped = computeMenuBarPopoverBounds({
      trayBounds: { x: 1480, y: 0, width: 24, height: 25 },
      workArea: { x: 0, y: 25, width: 1512, height: 957 },
    });
    assert.equal(rightClamped.x, 1512 - MENU_BAR_POPOVER_EDGE_MARGIN_PX - MENU_BAR_POPOVER_WIDTH);

    const leftClamped = computeMenuBarPopoverBounds({
      trayBounds: { x: 10, y: 0, width: 24, height: 25 },
      workArea: { x: 0, y: 25, width: 1512, height: 957 },
    });
    assert.equal(leftClamped.x, MENU_BAR_POPOVER_EDGE_MARGIN_PX);
  });

  it("handles secondary displays with negative coordinates", () => {
    const bounds = computeMenuBarPopoverBounds({
      trayBounds: { x: -120, y: 0, width: 24, height: 37 },
      workArea: { x: -1440, y: 37, width: 1440, height: 863 },
    });

    assert.equal(bounds.x, -MENU_BAR_POPOVER_EDGE_MARGIN_PX - MENU_BAR_POPOVER_WIDTH);
    assert.equal(bounds.y, 37 + MENU_BAR_POPOVER_GAP_PX);
  });

  it("places the popover above a bottom-aligned tray icon", () => {
    const bounds = computeMenuBarPopoverBounds({
      trayBounds: { x: 1300, y: 1040, width: 24, height: 40 },
      workArea: { x: 0, y: 0, width: 1920, height: 1040 },
    });

    assert.equal(bounds.y, 1040 - MENU_BAR_POPOVER_GAP_PX - MENU_BAR_POPOVER_HEIGHT);
  });

  it("shrinks to fit a narrow or short work area", () => {
    const bounds = computeMenuBarPopoverBounds({
      trayBounds: { x: 100, y: 0, width: 20, height: 24 },
      workArea: { x: 0, y: 24, width: 280, height: 300 },
    });

    assert.equal(bounds.x, 0);
    assert.equal(bounds.width, 280);
    assert.equal(bounds.y, 24 + MENU_BAR_POPOVER_GAP_PX);
    assert.equal(bounds.height, 300 - MENU_BAR_POPOVER_GAP_PX);
  });
});

describe("decideMenuBarTrayClick", () => {
  it("opens when closed and not recently blurred", () => {
    assert.equal(
      decideMenuBarTrayClick({
        isOpen: false,
        lastDismissedByBlurAtMs: null,
        nowMs: 1_000,
      }),
      "open",
    );
  });

  it("closes when the popover is currently open", () => {
    assert.equal(
      decideMenuBarTrayClick({
        isOpen: true,
        lastDismissedByBlurAtMs: null,
        nowMs: 1_000,
      }),
      "close",
    );
  });

  it("ignores a tray click right after a blur dismissal so the click does not reopen the popover", () => {
    assert.equal(
      decideMenuBarTrayClick({
        isOpen: false,
        lastDismissedByBlurAtMs: 1_000,
        nowMs: 1_000 + TRAY_CLICK_BLUR_SUPPRESS_MS - 1,
      }),
      "ignore",
    );
  });

  it("opens again once the blur suppression window has elapsed", () => {
    assert.equal(
      decideMenuBarTrayClick({
        isOpen: false,
        lastDismissedByBlurAtMs: 1_000,
        nowMs: 1_000 + TRAY_CLICK_BLUR_SUPPRESS_MS,
      }),
      "open",
    );
  });
});
