import { MessageId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { recheckFormDefaults, recheckReason } from "./LaterRecheckDialog.logic";

const NOW = Date.parse("2026-11-16T10:00:00.000Z");
const card = (
  open: ReadonlyArray<{ kind: "followup" | "verify"; text: string; dueAt?: string }>,
) => ({
  line: "Outcome",
  topics: [],
  open,
  messageId: MessageId.make("message:card"),
  at: "2026-11-16T09:00:00.000Z",
});

describe("recheckReason", () => {
  it("keeps the first line and cuts it to the row's length", () => {
    expect(recheckReason("  Did the A/B test finish?\nCompare with yesterday.")).toBe(
      "Did the A/B test finish?",
    );
    const long = recheckReason("x".repeat(200));
    expect(long).toHaveLength(80);
    expect(long.endsWith("…")).toBe(true);
  });
});

describe("recheckFormDefaults", () => {
  it("edits the armed re-check, else starts from the card's follow-up item", () => {
    expect(
      recheckFormDefaults({
        armed: { question: "Any result?", dueAt: "2026-11-17T09:00:00.000Z" },
        card: card([{ kind: "followup", text: "Check the rollout" }]),
        nowMs: NOW,
      }),
    ).toEqual({ question: "Any result?", dueAt: "2026-11-17T09:00:00.000Z", afterPublish: false });
    // An armed re-check with no time waits for the next publish.
    expect(
      recheckFormDefaults({
        armed: { question: "Crash rate?", dueAt: null },
        card: null,
        nowMs: NOW,
      }),
    ).toEqual({ question: "Crash rate?", dueAt: null, afterPublish: true });
    expect(
      recheckFormDefaults({
        armed: null,
        card: card([
          { kind: "verify", text: "Run the tests" },
          { kind: "followup", text: "Check the rollout", dueAt: "2026-11-18T09:00:00.000Z" },
        ]),
        nowMs: NOW,
      }),
    ).toEqual({
      question: "Check the rollout",
      dueAt: "2026-11-18T09:00:00.000Z",
      afterPublish: false,
    });
  });

  it("drops a time that has passed and starts empty with no card", () => {
    expect(
      recheckFormDefaults({
        armed: null,
        card: card([{ kind: "followup", text: "Check", dueAt: "2026-11-15T09:00:00.000Z" }]),
        nowMs: NOW,
      }),
    ).toEqual({ question: "Check", dueAt: null, afterPublish: false });
    expect(recheckFormDefaults({ armed: null, card: null, nowMs: NOW })).toEqual({
      question: "",
      dueAt: null,
      afterPublish: false,
    });
  });
});
