import { describe, expect, it } from "vite-plus/test";

import { buildThreadProgressPrompt, parseThreadProgress } from "./ThreadProgress.ts";

describe("buildThreadProgressPrompt", () => {
  const block = (prompt: string, tag: string) =>
    prompt.slice(prompt.indexOf(`<${tag}>`), prompt.indexOf(`</${tag}>`) + tag.length + 3);

  it("renders main agent, subagent blocks with optional todo, and previous lines", () => {
    const prompt = buildThreadProgressPrompt({
      mainAgent: {
        status: "waiting on subagents",
        recentActivity: ["subagent: Fix auth tests (running)"],
      },
      subagents: [
        {
          ref: "a1",
          status: "running",
          todo: { done: 2, total: 5 },
          task: "Fix failing auth tests",
          previousLine: "Checking auth.test.ts",
          recentActivity: [
            "todo_list: 2/5 done; now: Fix cookie expiry",
            "command_execution: vp test run auth.test.ts (running)",
          ],
        },
        {
          ref: "a2",
          status: "completed",
          todo: null,
          task: "Review SQL migrations",
          previousLine: null,
          recentActivity: [],
        },
      ],
      previousThreadLine: "1 of 2 agents done; auth tests running",
    });

    expect(block(prompt, "main_agent")).toBe(
      [
        "<main_agent>",
        "status: waiting on subagents",
        "recent activity, oldest first:",
        "- subagent: Fix auth tests (running)",
        "</main_agent>",
      ].join("\n"),
    );

    expect(block(prompt, "subagents")).toBe(
      [
        "<subagents>",
        '<subagent id="a1" status="running" todo="2/5">',
        "task: Fix failing auth tests",
        "previous line: Checking auth.test.ts",
        "recent activity, oldest first:",
        "- todo_list: 2/5 done; now: Fix cookie expiry",
        "- command_execution: vp test run auth.test.ts (running)",
        "</subagent>",
        '<subagent id="a2" status="completed">',
        "task: Review SQL migrations",
        "previous line: none",
        "recent activity, oldest first:",
        "- none",
        "</subagent>",
        "</subagents>",
      ].join("\n"),
    );

    expect(block(prompt, "previous_thread_line")).toBe(
      "<previous_thread_line>\n1 of 2 agents done; auth tests running\n</previous_thread_line>",
    );
  });

  it("writes none for an absent previous thread line and omits empty todo attributes", () => {
    const prompt = buildThreadProgressPrompt({
      mainAgent: { status: "working", recentActivity: [] },
      subagents: [
        {
          ref: "a1",
          status: "running",
          todo: { done: 0, total: 0 },
          task: "Audit logs",
          previousLine: null,
          recentActivity: [],
        },
      ],
      previousThreadLine: null,
    });

    expect(prompt).toContain('<subagent id="a1" status="running">');
    expect(prompt).not.toContain('todo="0/0"');
    expect(block(prompt, "previous_thread_line")).toBe(
      "<previous_thread_line>\nnone\n</previous_thread_line>",
    );
  });
});

describe("parseThreadProgress", () => {
  it.each([
    [
      "standard labels with markdown noise, bullets, quotes and trailing punctuation",
      [
        '- **Thread:** "2 of 3 agents done; reviewer checking migrations."',
        "- `A1`: **Fixed 2 of 5 tests** in `auth.test.ts`; rerunning suite.",
        "a2: Completed migration review; found 1 missing index;",
      ].join("\n"),
      ["a1", "a2"],
      {
        line: "2 of 3 agents done; reviewer checking migrations",
        agents: [
          { ref: "a1", line: "Fixed 2 of 5 tests in auth.test.ts; rerunning suite" },
          { ref: "a2", line: "Completed migration review; found 1 missing index" },
        ],
      },
    ],
    [
      "drops unknown and duplicated refs while keeping known ones",
      [
        "thread: Running integration suite",
        "a1: First status for a1",
        "a1: Duplicate status for a1",
        "a9: Unknown agent ref",
        "foo: Not an agent label",
      ].join("\n"),
      ["a1", "a2"],
      {
        line: "Running integration suite",
        agents: [{ ref: "a1", line: "First status for a1" }],
      },
    ],
    [
      "allows optional agent lines when only thread line is returned",
      "thread: Auditing login middleware",
      ["a1"],
      {
        line: "Auditing login middleware",
        agents: [],
      },
    ],
    ["returns null when thread line is missing or blank", "a1: Running unit tests", ["a1"], null],
    [
      "returns null when thread line reduces to empty after noise stripping",
      "thread:   ...  \na1: Checking files",
      ["a1"],
      null,
    ],
  ])("%s", (_name, raw, refs, expected) => {
    expect(parseThreadProgress(raw, refs)).toEqual(expected);
  });

  it("caps thread and agent lines at word boundaries within contract limits", () => {
    const parsed = parseThreadProgress(
      [`thread: ${"word ".repeat(30)}`, `a1: ${"detail ".repeat(30)}`].join("\n"),
      ["a1"],
    )!;
    expect(parsed.line.length).toBeLessThanOrEqual(72);
    expect(parsed.line.endsWith("word")).toBe(true);
    expect(parsed.agents[0]!.line.length).toBeLessThanOrEqual(110);
    expect(parsed.agents[0]!.line.endsWith("detail")).toBe(true);
  });
});
