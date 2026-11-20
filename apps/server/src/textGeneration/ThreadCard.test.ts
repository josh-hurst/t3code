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
        "ask: offer | Which extra sign-in providers would you like?",
        "ask: blocking | Use Clerk or Auth0 for login?",
        "- verify: Check the redirect on a phone",
        "commit: auth/login.test.ts is uncommitted",
        "ship: Waiting on a publish",
        "followup 2030-03-04T09:00+01:00: agent | Report the error rate",
        "followup 2030-03-04T09:00+01:00: user | Re-check the nightly build",
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
      entries: [],
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

  it("accepts a bare headline and keeps any labelled fields after it", () => {
    expect(parseThreadCard('"Merge PR 412 now?"\nCommit it when ready.', NOW_MS)).toEqual({
      line: "Merge PR 412 now?",
      topics: [],
      open: [],
      entries: [],
    });
    expect(
      parseThreadCard("Push is waiting on a remote\ntopics: release\nask: Which remote?", NOW_MS),
    ).toEqual({
      line: "Push is waiting on a remote",
      topics: ["release"],
      open: [{ kind: "ask", text: "Which remote?" }],
      entries: [],
    });
    expect(parseThreadCard("topics: login\nask: Merge it?", NOW_MS)).toBeNull();
    expect(parseThreadCard("  ...  ", NOW_MS)).toBeNull();
  });

  it.each([
    [
      "an existing id",
      ["entry: e2 | Fixed; not deployed | open"],
      [["e2", null, "Fixed; not deployed"]],
    ],
    [
      "new with a title, open/done dropped",
      ["entry: new | **Export timeout** | Raised to 30 seconds | done"],
      [["new", "Export timeout", "Raised to 30 seconds"]],
    ],
    [
      "two lines; a third dropped",
      ["entry: E1 | First", "- entry: new | Dark mode | Added", "entry: e3 | Third"],
      [
        ["e1", null, "First"],
        ["new", "Dark mode", "Added"],
      ],
    ],
    [
      "a bad id and a repeated id dropped",
      ["entry: entry-2 | Nope", "entry: e1 | Once", "entry: e1 | Twice"],
      [["e1", null, "Once"]],
    ],
    ["an id with only open/done", ["entry: e4 | done"], [["e4", null, ""]]],
    ["new without a title", ["entry: new"], [["new", null, ""]]],
    ["no entry line", [], []],
  ])("reads entry lines: %s", (_name, lines, expected) => {
    const card = parseThreadCard(["line: Done", "topics: work", ...lines].join("\n"), NOW_MS);
    expect(card?.entries.map((entry) => [entry.ref, entry.title, entry.outcome])).toEqual(expected);
    expect(card?.open).toEqual([]);
  });

  it("caps entry titles and outcomes at what an entry stores", () => {
    const [entry] = parseThreadCard(
      `line: Done\nentry: new | ${"title ".repeat(30)} | ${"outcome ".repeat(30)}`,
      NOW_MS,
    )!.entries;
    expect(entry!.title!.length).toBeLessThanOrEqual(80);
    expect(entry!.outcome.length).toBeLessThanOrEqual(120);
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
  const base = {
    reply: "Done.",
    userMessage: "Fix the login test",
    previous: null,
    contents: { entries: [], previousRefs: [] },
    midRun: [],
    startedBy: "owner",
    now: "2030-03-03T13:00:00.000+01:00",
  } as const;
  const block = (prompt: string, tag: string) =>
    prompt.slice(prompt.indexOf(`<${tag}>`), prompt.indexOf(`</${tag}>`) + tag.length + 3);

  it("carries the previous card and keeps the end of a long reply", () => {
    const reply = `${"start ".repeat(1_000)}${"middle ".repeat(2_000)}Should I merge it?`;
    const prompt = buildThreadCardPrompt({
      ...base,
      reply,
      previous: {
        line: "Login test still flaky",
        topics: ["login test"],
        open: [{ kind: "followup", text: "Re-check CI", dueAt: "2030-03-04T08:00:00.000Z" }],
      },
    });
    expect(prompt).toContain("Should I merge it?");
    expect(prompt).toContain("[…]");
    expect(prompt.length).toBeLessThan(reply.length);
    expect(prompt).toContain("topics: login test\nfollowup 2030-03-04T08:00:00.000Z: Re-check CI");
    expect(prompt).toContain("<user_message>\nFix the login test\n</user_message>");
  });

  it("lists the contents with the previous run's entries, or says it is the first run", () => {
    expect(block(buildThreadCardPrompt(base), "contents")).toBe(
      "<contents>\nnone yet: this is the first run of the thread\n</contents>",
    );
    const prompt = buildThreadCardPrompt({
      ...base,
      contents: {
        entries: [
          { ref: "e1", title: "Login test", outcome: "Fixed", open: false },
          { ref: "e2", title: "Reset email", outcome: "Queued; not committed", open: true },
        ],
        previousRefs: ["e2"],
      },
    });
    expect(block(prompt, "contents")).toBe(
      [
        "<contents>",
        "e1 | Login test | Fixed | done",
        "e2 | Reset email | Queued; not committed | open",
        "The previous run was filed under: e2",
        "</contents>",
      ].join("\n"),
    );
    expect(prompt.indexOf("</contents>")).toBeLessThan(prompt.indexOf("Current time:"));
  });

  it.each([
    ["owner", "Fix the login test", [], "<user_message>\nFix the login test\n</user_message>"],
    [
      "owner",
      "Fix the login test",
      ["also the reset email"],
      "<user_message>\nFix the login test\n[The user added while the agent was working:] also the reset email\n</user_message>",
    ],
    [
      "report",
      "Task finished",
      ["how is it going?"],
      "<user_message>\n[No new message from the user started this run. A background task or subagent reported back.]\n[The user added while the agent was working:] how is it going?\n</user_message>",
    ],
    ["other", null, [], "<user_message>\n\n</user_message>"],
  ] as const)(
    "writes the user block for a run started by %s",
    (startedBy, userMessage, midRun, expected) => {
      expect(
        block(buildThreadCardPrompt({ ...base, startedBy, userMessage, midRun }), "user_message"),
      ).toBe(expected);
    },
  );
});
