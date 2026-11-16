import { expect, it } from "vite-plus/test";

import { closingQuestionSpan } from "./awaitingQuestion.logic";

const quoted = (text: string, ask: string) => {
  const span = closingQuestionSpan(text, ask);
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
    "the later question on a tie",
    "Why did it fail? The cache was stale.\n\nShould I push it?",
    "Ready to merge?",
    "Should I push it?",
  ],
  [
    "a question ending in a quote",
    'Fixed.\n\nShould I run "vp test"?',
    "Run the tests?",
    'Should I run "vp test"?',
  ],
  ["nothing without a question", "Fixed the bug. Let me know.", "Silence the warning?", null],
])("finds %s", (_, text, ask, expected) => {
  expect(quoted(text, ask)).toBe(expected);
});
