import { describe, expect, it } from "vite-plus/test";

import {
  resolveSidebarFooterVisibility,
  setSidebarFooterItem,
  SIDEBAR_FOOTER_ITEMS,
} from "./sidebarFooterItems";

const pullRequests = SIDEBAR_FOOTER_ITEMS.find((item) => item.id === "pullRequests")!;
const usage = SIDEBAR_FOOTER_ITEMS.find((item) => item.id === "usage")!;

describe("sidebar footer items", () => {
  it("hides pull requests and issues by default and honors overrides", () => {
    expect(resolveSidebarFooterVisibility({ sidebarFooterItems: {} })).toEqual({
      pullRequests: false,
      issues: false,
      changes: true,
      usage: true,
    });
    expect(
      resolveSidebarFooterVisibility({
        sidebarFooterItems: { pullRequests: true, usage: false, retired: true },
      }),
    ).toMatchObject({ pullRequests: true, issues: false, usage: false });
  });

  it("stores only choices that differ from the default", () => {
    const empty = { sidebarFooterItems: {} };
    expect(setSidebarFooterItem(empty, pullRequests, true)).toEqual({ pullRequests: true });
    expect(setSidebarFooterItem(empty, pullRequests, false)).toEqual({});
    expect(setSidebarFooterItem({ sidebarFooterItems: { usage: false } }, usage, true)).toEqual({});
  });
});
