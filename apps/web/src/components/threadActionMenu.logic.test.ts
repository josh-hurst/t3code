import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("offers each way into Later and the way back out", () => {
    const snoozeChildren = (state: Partial<ThreadActionMenuState>) =>
      buildThreadActionMenuItems({ ...baseState, ...state })
        .find((item) => item.id === "snooze")
        ?.children?.map((child) => child.id);
    expect(snoozeChildren({})).toEqual([
      "snooze:hour",
      "snooze:custom",
      "later:set-aside",
      "later:recheck",
      "later:standing-check",
    ]);
    const held = buildThreadActionMenuItems({
      ...baseState,
      isSnoozed: true,
      hasArmedRecheck: true,
      isStandingCheck: true,
    }).map((item) => item.id);
    expect(held).toEqual(
      expect.arrayContaining([
        "unsnooze",
        "later:recheck",
        "later:cancel-recheck",
        "later:stop-standing-check",
      ]),
    );
  });

  it.each([
    ["open", "pop-out"],
    ["return", "open-in-main-window"],
    ["return", "popout-new-thread"],
  ] as const)(
    "keeps moving a thread between windows open to read-only clients (%s)",
    (popout, id) => {
      const items = buildThreadActionMenuItems({ ...baseState, canOperate: false, popout });
      expect(items.find((item) => item.id === id)?.disabled).toBeUndefined();
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("disables only rename where no inline title editor exists", () => {
    const items = buildThreadActionMenuItems({ ...baseState, canRename: false });
    expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(["rename"]);
  });
});
