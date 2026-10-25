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

  it("disables archive while the thread is running", () => {
    const archiveItem = buildThreadActionMenuItems({ ...baseState, isRunning: true }).find(
      (item) => item.id === "archive",
    );
    expect(archiveItem?.disabled).toBe(true);
  });

  it("offers folders, checks the current one, and removal only when filed", () => {
    const folderMenu = (currentFolderId: string | null) =>
      buildThreadActionMenuItems({
        ...baseState,
        folders: {
          items: [
            { id: "f1", name: "Bugs" },
            { id: "f2", name: "Ideas" },
          ],
          currentFolderId,
        },
      }).find((item) => item.id === "folder");
    expect(folderMenu("f2")?.children?.map((child) => [child.id, child.checked ?? false])).toEqual([
      ["folder:f1", false],
      ["folder:f2", true],
      ["folder:new", false],
      ["folder:none", false],
    ]);
    expect(folderMenu(null)?.children?.map((child) => child.id)).not.toContain("folder:none");
    expect(
      buildThreadActionMenuItems({ ...baseState, folders: null }).some(
        (item) => item.id === "folder",
      ),
    ).toBe(false);
  });

  it("keeps folder moves available to read-only connections", () => {
    const folderItem = buildThreadActionMenuItems({
      ...baseState,
      canOperate: false,
      folders: { items: [], currentFolderId: null },
    }).find((item) => item.id === "folder");
    expect(folderItem?.disabled).toBeUndefined();
    expect(folderItem?.children?.every((child) => child.disabled === undefined)).toBe(true);
  });
});
