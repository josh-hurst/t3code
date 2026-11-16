import { RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { contentsCount, splitTopicsBlocker } from "./threadContents.logic";

const runs = (...ids: string[]) =>
  ids.map((id) => ({ runId: RunId.make(id), source: "online" as const }));

describe("thread contents", () => {
  it("counts topics, and the ones that still owe something", () => {
    const owing = { open: ["publish", "check"] };
    expect(contentsCount([{ open: [] }, owing, { open: [] }])).toBe("3 topics · 1 open");
    expect(contentsCount([{ open: [] }, { open: [] }])).toBe("2 topics");
  });

  it("says why a split would do nothing", () => {
    expect(splitTopicsBlocker({ summariesEnabled: false, entries: null })).toMatch(/are off/);
    expect(splitTopicsBlocker({ summariesEnabled: true, entries: [] })).toBe(
      "This thread has no topics yet.",
    );
    // A run filed under two topics is still one reply.
    expect(
      splitTopicsBlocker({
        summariesEnabled: true,
        entries: [{ runs: runs("a") }, { runs: runs("a") }],
      }),
    ).toMatch(/two summarized replies/);
    expect(
      splitTopicsBlocker({ summariesEnabled: true, entries: [{ runs: runs("a", "b") }] }),
    ).toBeNull();
  });
});
