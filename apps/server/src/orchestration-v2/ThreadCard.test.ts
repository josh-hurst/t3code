import { CommandId, MessageId, RunId, type ThreadCard } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { cardCallsForRetitle, nextThreadCard, unreadVisitedAt } from "./ThreadCard.ts";

const input = (run: number, overrides: Partial<Parameters<typeof nextThreadCard>[0]> = {}) => ({
  previous: null,
  runId: RunId.make(`run:${run}`),
  messageId: MessageId.make(`message:${run}`),
  line: `Line ${run}`,
  topics: [],
  open: [],
  at: "2026-06-20T00:00:00.000Z",
  repliedAt: `2026-06-20T00:00:0${run}.000Z`,
  answered: false,
  ...overrides,
});

describe("nextThreadCard", () => {
  it("describes the newest run only", () => {
    let card: ThreadCard | null = null;
    for (let run = 1; run <= 3; run++) card = nextThreadCard(input(run, { previous: card }));
    expect(card).toEqual({
      line: "Line 3",
      topics: [],
      open: [],
      messageId: "message:3",
      at: "2026-06-20T00:00:00.000Z",
      runId: "run:3",
    });
  });

  it("puts the new topics first, drops repeats in any case, and keeps five", () => {
    const previous = nextThreadCard(input(1, { topics: ["Login test", "CI", "auth", "docs"] }));
    const card = nextThreadCard(input(2, { previous, topics: ["billing", "login test", "sso"] }));
    expect(card.topics).toEqual(["billing", "login test", "sso", "CI", "auth"]);
  });

  it("drops questions the user has already written past, and keeps the rest", () => {
    const open = [
      { kind: "ask" as const, text: "Merge PR 412 now?" },
      { kind: "verify" as const, text: "Check the redirect on a phone" },
    ];
    expect(nextThreadCard(input(1, { open })).open).toEqual(open);
    expect(nextThreadCard(input(1, { open, answered: true })).open).toEqual([open[1]]);
  });

  it("times a question from the reply that first raised it", () => {
    const ask = (text: string) => ({ kind: "ask" as const, text });
    const first = nextThreadCard(input(1, { open: [ask("Merge PR 412 now?")] }));
    expect(first.askedAt).toBe("2026-06-20T00:00:01.000Z");
    // A report that repeats it, reworded only in case and punctuation, is not a new question.
    const carried = nextThreadCard(input(2, { previous: first, open: [ask("merge PR 412 now")] }));
    expect(carried.askedAt).toBe(first.askedAt);
    const added = nextThreadCard(
      input(3, { previous: carried, open: [ask("Merge PR 412 now?"), ask("Tag the release?")] }),
    );
    expect(added.askedAt).toBe("2026-06-20T00:00:03.000Z");
    expect(nextThreadCard(input(4, { previous: added })).askedAt).toBeUndefined();
    expect(
      nextThreadCard(input(4, { previous: added, open: added.open, answered: true })).askedAt,
    ).toBeUndefined();
  });
});

it("marks unread from before a carried question's reply, else from before the latest run's end", () => {
  const completedAt = DateTime.makeUnsafe("2026-06-20T00:00:09.000Z");
  const before = (iso: string) => DateTime.makeUnsafe(Date.parse(iso) - 1);
  const asked = nextThreadCard(input(1, { open: [{ kind: "ask", text: "Merge PR 412 now?" }] }));
  expect(unreadVisitedAt(null, completedAt)).toEqual(before("2026-06-20T00:00:09.000Z"));
  expect(unreadVisitedAt(asked, completedAt)).toEqual(before("2026-06-20T00:00:01.000Z"));
  expect(unreadVisitedAt({ ...asked, open: [] }, completedAt)).toEqual(
    before("2026-06-20T00:00:09.000Z"),
  );
});

describe("cardCallsForRetitle", () => {
  const card = nextThreadCard(input(1, { topics: ["login test", "CI"] }));
  const idle = { card, titleEditedAt: null, titleRegeneration: null };
  const regenerating = {
    requestId: CommandId.make("command:title"),
    startedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
  };
  it.each([
    ["the same topics in another case", idle, ["Login Test ", "ci"], false],
    ["a topic the last card did not have", idle, ["login test", "billing"], true],
    ["a first card", { ...idle, card: undefined }, ["billing"], false],
    [
      "a first card after a guessed title",
      { ...idle, card: undefined, titleNeedsRefinement: true },
      [],
      true,
    ],
    [
      "a thread named by hand",
      { ...idle, titleEditedAt: "2026-06-20T00:00:00.000Z" },
      ["billing"],
      false,
    ],
    [
      "a title already being generated",
      { ...idle, titleRegeneration: regenerating },
      ["billing"],
      false,
    ],
  ])("%s: %s", (_name, thread, topics, expected) => {
    expect(cardCallsForRetitle(thread, topics)).toBe(expected);
  });
});
