import { expect, it } from "vite-plus/test";

import { askSpanInReply, findAskInThread, markdownPlainText } from "./awaitingQuestion.logic";

const quoted = (text: string, ask: string) => {
  const span = askSpanInReply(text, ask);
  return span === null ? null : text.slice(span.start, span.end);
};

it.each([
  [
    "the question the card paraphrases",
    "Fixed the saves. Want me to add tracking? Do you want all of it, or just items 1 and 2?",
    "Build all six items, or just 1 and 2?",
    "Do you want all of it, or just items 1 and 2?",
  ],
  [
    "the last question when no sentence shares its words",
    "Why did it fail? The cache was stale.\n\nShould I push it?",
    "Ready to merge?",
    "Should I push it?",
  ],
  [
    "a question ending in a quote",
    'Fixed.\n\nShould I run "vp test"?',
    "Run the vp tests?",
    'Should I run "vp test"?',
  ],
  // The card words decisions offered for overruling as one question.
  [
    "decisions the card turned into a question",
    [
      "The planner is running again.",
      "",
      "Three decisions I took that you may want to overrule:",
      "",
      "The move try-out court is left out. It could trade match time for lobby time.",
      "The results card keeps a SHOP button, because SHOP on results drew 5,776 players.",
      "The showroom moves no stands in this version.",
      "",
      "I used the default model for the planner.",
    ].join("\n"),
    "Keep move try-out court excluded, SHOP on results, and stands fixed?",
    "The move try-out court is left out. It could trade match time for lobby time.\nThe results card keeps a SHOP button, because SHOP on results drew 5,776 players.\nThe showroom moves no stands in this version.",
  ],
  [
    "a sentence naming a file",
    "Done. I logged this check in history.md for tomorrow.",
    "Log the check in history for tomorrow?",
    "I logged this check in history.md for tomorrow.",
  ],
  [
    "nothing without a question or a match",
    "Fixed the bug. Let me know.",
    "Silence the warning?",
    null,
  ],
])("finds %s", (_, text, ask, expected) => {
  expect(quoted(text, ask)).toBe(expected);
});

it("finds an ask carried forward from an earlier reply", () => {
  const ask = "Keep the try-out court excluded and SHOP on results?";
  const match = findAskInThread(
    [
      {
        id: "a",
        role: "assistant",
        text: "- **The move try-out court is left out.**\n- SHOP on results stays.",
      },
      { id: "u", role: "user", text: "Restart the planner." },
      { id: "b", role: "assistant", text: "The planner is running again." },
    ],
    ask,
  );
  expect(match?.messageId).toBe("a");
  expect(match && match.text.slice(match.start, match.end)).toBe(
    "The move try-out court is left out.\nSHOP on results stays.",
  );
});

it("drops markdown marks but keeps the words a reply renders", () => {
  expect(markdownPlainText("- **Brief**: [BRIEF.md](/a/BRIEF.md) sets `loadout_bar`.")).toBe(
    "Brief: BRIEF.md sets loadout_bar.",
  );
});
