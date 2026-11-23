import { describe, expect, it } from "vite-plus/test";

import {
  resolveCtrlListNavigationKey,
  resolveVerticalListNavigationKey,
} from "./listNavigationKeys";

function keyEvent(overrides: Partial<Parameters<typeof resolveVerticalListNavigationKey>[0]> = {}) {
  return {
    key: "n",
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    isComposing: false,
    keyCode: 0,
    ...overrides,
  };
}

describe("listNavigationKeys", () => {
  it("maps Ctrl+N and Ctrl+P to ArrowDown and ArrowUp", () => {
    expect(resolveCtrlListNavigationKey(keyEvent({ key: "n", ctrlKey: true }))).toBe("ArrowDown");
    expect(resolveCtrlListNavigationKey(keyEvent({ key: "N", ctrlKey: true }))).toBe("ArrowDown");
    expect(resolveCtrlListNavigationKey(keyEvent({ key: "p", ctrlKey: true }))).toBe("ArrowUp");
    expect(resolveCtrlListNavigationKey(keyEvent({ key: "P", ctrlKey: true }))).toBe("ArrowUp");
  });

  it("ignores extra modifiers, plain letters, and IME composition", () => {
    expect(resolveCtrlListNavigationKey(keyEvent({ key: "n" }))).toBeNull();
    expect(
      resolveCtrlListNavigationKey(keyEvent({ key: "n", ctrlKey: true, shiftKey: true })),
    ).toBeNull();
    expect(
      resolveCtrlListNavigationKey(keyEvent({ key: "n", ctrlKey: true, metaKey: true })),
    ).toBeNull();
    expect(
      resolveCtrlListNavigationKey(keyEvent({ key: "n", ctrlKey: true, altKey: true })),
    ).toBeNull();
    expect(
      resolveCtrlListNavigationKey(keyEvent({ key: "n", ctrlKey: true, isComposing: true })),
    ).toBeNull();
    expect(
      resolveCtrlListNavigationKey(keyEvent({ key: "n", ctrlKey: true, keyCode: 229 })),
    ).toBeNull();
  });

  it("accepts plain arrows and Ctrl+N/P in resolveVerticalListNavigationKey", () => {
    expect(resolveVerticalListNavigationKey(keyEvent({ key: "ArrowDown" }))).toBe("ArrowDown");
    expect(resolveVerticalListNavigationKey(keyEvent({ key: "ArrowUp" }))).toBe("ArrowUp");
    expect(
      resolveVerticalListNavigationKey(keyEvent({ key: "ArrowDown", shiftKey: true })),
    ).toBeNull();
    expect(resolveVerticalListNavigationKey(keyEvent({ key: "n", ctrlKey: true }))).toBe(
      "ArrowDown",
    );
    expect(resolveVerticalListNavigationKey(keyEvent({ key: "p", ctrlKey: true }))).toBe("ArrowUp");
  });
});
