import { describe, expect, it } from "vite-plus/test";

import type { MessagesTimelineRow } from "./MessagesTimeline.logic";
import { openAtMessageStep } from "./openAtMessage.logic";

const rows = ["first", "second"].map(
  (id) => ({ kind: "message", id: `row:${id}`, message: { id } }) as unknown as MessagesTimelineRow,
);
const step = (input: Partial<Parameters<typeof openAtMessageStep>[0]>) =>
  openAtMessageStep({
    rows,
    messageId: "second",
    hasMoreHistory: false,
    loading: false,
    requested: false,
    ...input,
  });

describe("openAtMessageStep", () => {
  it("scrolls to a loaded message, else reads history up to it once, then gives up", () => {
    expect(step({})).toEqual({ kind: "scroll", index: 1 });
    expect(step({ messageId: "older", hasMoreHistory: true })).toEqual({ kind: "load" });
    expect(step({ messageId: "older", hasMoreHistory: true, loading: true })).toEqual({
      kind: "wait",
    });
    // Still missing after the read: rolled back, or never in this thread.
    expect(step({ messageId: "older", hasMoreHistory: true, requested: true })).toEqual({
      kind: "give-up",
    });
    expect(step({ messageId: "older" })).toEqual({ kind: "give-up" });
  });
});
