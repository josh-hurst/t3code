import { describe, expect, it } from "vite-plus/test";
import { MessageId, RunId, ThreadEntryId } from "@t3tools/contracts";
import { ATTACHMENT_ONLY_BOOTSTRAP_PROMPT } from "@t3tools/shared/composerContextReferences";

import { deriveTimelineMinimapItems, resolveTimelineMinimapPreview } from "./timelineMinimapItems";

describe("deriveTimelineMinimapItems", () => {
  it.each(["", "Ultrathink:\n"])(
    "omits bootstrap text from the minimap label and tooltip (%j)",
    (prefix) => {
      const at = "2026-10-01T00:00:00Z";
      const items = deriveTimelineMinimapItems([
        {
          kind: "message",
          id: "image-only",
          createdAt: at,
          showAssistantMeta: false,
          showAssistantCopyButton: false,
          assistantCopyStreaming: false,
          message: {
            id: MessageId.make("image-only"),
            role: "user",
            text: prefix + ATTACHMENT_ONLY_BOOTSTRAP_PROMPT,
            runId: null,
            streaming: false,
            createdAt: at,
            updatedAt: at,
          },
        },
      ]);
      expect(items).toEqual([{ id: "image-only", rowIndex: 0, userText: "", assistantText: null }]);
      expect(resolveTimelineMinimapPreview(items[0]!)?.userText).toBeNull();
    },
  );
});

describe("deriveTimelineMinimapItems topic marks", () => {
  const at = "2026-10-01T00:00:00Z";
  const userRow = (id: string, runId: string | null) => ({
    kind: "message" as const,
    id,
    createdAt: at,
    showAssistantMeta: false,
    showAssistantCopyButton: false,
    assistantCopyStreaming: false,
    message: {
      id: MessageId.make(id),
      role: "user" as const,
      text: id,
      runId: runId === null ? null : RunId.make(runId),
      streaming: false,
      createdAt: at,
      updatedAt: at,
    },
  });

  it("marks where each topic starts, and a return to one after another", () => {
    const lobby = { id: ThreadEntryId.make("e1"), title: "Lobby test" };
    const locker = { id: ThreadEntryId.make("e2"), title: "Locker" };
    const byRun = new Map([
      [RunId.make("a"), lobby],
      [RunId.make("b"), locker],
      [RunId.make("c"), lobby],
      [RunId.make("d"), lobby],
    ]);
    const items = deriveTimelineMinimapItems(
      [
        userRow("a", "a"),
        userRow("b", "b"),
        userRow("c", "c"),
        userRow("running", "e"),
        userRow("d", "d"),
      ],
      byRun,
    );
    expect(items.map((item) => [item.entryTitle, item.startsEntry])).toEqual([
      ["Lobby test", true],
      ["Locker", true],
      ["Lobby test", true],
      [undefined, undefined],
      ["Lobby test", false],
    ]);
  });
});

describe("resolveTimelineMinimapPreview", () => {
  it("previews a thread autolink as prose, not its URL", () => {
    const preview = resolveTimelineMinimapPreview({
      id: "turn-1",
      rowIndex: 0,
      userText: null,
      assistantText:
        "Started <t3-thread://v2/env-1/thread-1> and [Fix CI](t3-thread://v2/env-1/t2).",
    });
    expect(preview?.assistantText).toBe("Started a thread and Fix CI.");
  });
});
