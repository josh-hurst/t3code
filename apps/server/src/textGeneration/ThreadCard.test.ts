import { describe, expect, it } from "vite-plus/test";

import { buildThreadCardPrompt, parseThreadCard, sanitizeReplySummary } from "./ThreadCard.ts";

const NOW_MS = Date.parse("2030-03-03T12:00:00.000Z");

describe("sanitizeReplySummary", () => {
  it.each([
    ['"Fixed flaky login test; 2 retries removed."', "Fixed flaky login test; 2 retries removed"],
    ["**Summary:** `vp test` passes after cache fix", "vp test passes after cache fix"],
    ["Merge PR 412 now?", "Merge PR 412 now?"],
    [
      "Blocked on missing STRIPE_KEY\nI could not run the webhook tests.",
      "Blocked on missing STRIPE_KEY",
    ],
    [
      "Added retry backoff to sync worker plus tests docs and a migration note for operators",
      "Added retry backoff to sync worker plus tests docs and",
    ],
    ["  ...  ", null],
  ])("%j becomes %j", (raw, expected) => {
    expect(sanitizeReplySummary(raw)).toBe(expected);
  });

  it("cuts long output at a word boundary", () => {
    const summary = sanitizeReplySummary(
      "Renamed useEnvironmentConnectionSupervisorRegistry to useSupervisorRegistry everywhere",
    );
    expect(summary).toBe("Renamed useEnvironmentConnectionSupervisorRegistry to");
    expect(summary!.length).toBeLessThanOrEqual(72);
  });
});

describe("parseThreadCard", () => {
  it("reads the line, topics and each kind of open item", () => {
    const card = parseThreadCard(
      [
        "line: Fixed flaky login test; 2 retries removed.",
        "topics: login test, **session cookie**, Login Test, ",
        "ask: Use Clerk or Auth0 for login?",
        "- verify: Check the redirect on a phone",
        "commit: auth/login.test.ts is uncommitted",
        "ship: Waiting on a publish",
        "followup 2030-03-04T09:00+01:00: Re-check the nightly build",
        "Some trailing prose the model added.",
      ].join("\n"),
      NOW_MS,
    );
    expect(card).toEqual({
      line: "Fixed flaky login test; 2 retries removed",
      topics: ["login test", "session cookie"],
      open: [
        { kind: "ask", text: "Use Clerk or Auth0 for login?" },
        { kind: "verify", text: "Check the redirect on a phone" },
        { kind: "commit", text: "auth/login.test.ts is uncommitted" },
        { kind: "ship", text: "Waiting on a publish" },
        {
          kind: "followup",
          text: "Re-check the nightly build",
          dueAt: "2030-03-04T08:00:00.000Z",
        },
      ],
    });
  });

  it.each([
    ["followup 2030-03-01T09:00Z: Re-check the build", "a time already past"],
    ["followup tomorrow: Re-check the build", "a time that is not a date"],
    ["followup: Re-check the build", "no time"],
  ])("keeps the follow-up %j without a due time: %s", (line) => {
    expect(parseThreadCard(`line: Build queued\n${line}`, NOW_MS)?.open).toEqual([
      { kind: "followup", text: "Re-check the build" },
    ]);
  });

  it("treats output with no labels as the line alone", () => {
    expect(parseThreadCard('"Merge PR 412 now?"\nCommit it when ready.', NOW_MS)).toEqual({
      line: "Merge PR 412 now?",
      topics: [],
      open: [],
    });
    expect(parseThreadCard("topics: login\nask: Merge it?", NOW_MS)).toBeNull();
    expect(parseThreadCard("  ...  ", NOW_MS)).toBeNull();
  });

  it("caps topics, open items and their lengths at what the card stores", () => {
    const card = parseThreadCard(
      [
        "line: Done",
        `topics: one, two, three, four, five, six, ${"t".repeat(60)}`,
        ...Array.from({ length: 8 }, (_, index) => `verify: check ${index} ${"word ".repeat(40)}`),
      ].join("\n"),
      NOW_MS,
    )!;
    expect(card.topics).toEqual(["one", "two", "three", "four", "five"]);
    expect(card.open).toHaveLength(6);
    expect(Math.max(...card.open.map((item) => item.text.length))).toBeLessThanOrEqual(140);
    expect(parseThreadCard(`line: Done\ntopics: ${"t".repeat(60)}`, NOW_MS)?.topics).toEqual([
      "t".repeat(32),
    ]);
  });
});

describe("buildThreadCardPrompt", () => {
  it("carries the previous card and keeps the end of a long reply", () => {
    const reply = `${"start ".repeat(1_000)}${"middle ".repeat(2_000)}Should I merge it?`;
    const prompt = buildThreadCardPrompt({
      reply,
      userMessage: "Fix the login test",
      previous: {
        line: "Login test still flaky",
        topics: ["login test"],
        open: [{ kind: "followup", text: "Re-check CI", dueAt: "2030-03-04T08:00:00.000Z" }],
      },
      now: "2030-03-03T13:00:00.000+01:00",
    });
    expect(prompt).toContain("Should I merge it?");
    expect(prompt).toContain("[…]");
    expect(prompt.length).toBeLessThan(reply.length);
    expect(prompt).toContain("topics: login test\nfollowup 2030-03-04T08:00:00.000Z: Re-check CI");
    expect(prompt).toContain("<user_message>\nFix the login test\n</user_message>");
  });
});
