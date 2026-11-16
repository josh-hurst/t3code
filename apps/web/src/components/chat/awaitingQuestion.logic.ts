// Punctuation ends a sentence only before a space, so `history.md` and `v1.2` stay whole.
const SENTENCE = /(?:[^.!?\n]|[.!?](?=[^\s.!?]))+[.!?]*["'”’)\]*]*/g;
const ENDS_IN_QUESTION = /\?["'”’)\]*]*$/;
const WORD = /[\p{L}\p{N}]{3,}/gu;
const STOP_WORDS = new Set(["the", "and", "for", "you", "your", "with", "that", "this", "are"]);
// A passage is anchored on a sentence sharing this many words with the card's wording.
const MIN_SHARED_WORDS = 2;
// Sentences sharing any word join it from at most one sentence away, so the rest of a list of
// decisions comes along, up to this length.
const MAX_PASSAGE_CHARS = 600;
const MESSAGES_SEARCHED = 10;

export interface TextSpan {
  readonly start: number;
  readonly end: number;
}

const words = (text: string) =>
  new Set(
    text
      .toLowerCase()
      .match(WORD)
      ?.filter((word) => !STOP_WORDS.has(word)),
  );

function sentences(text: string) {
  return [...text.matchAll(SENTENCE)].flatMap((match) => {
    const sentence = match[0].trim();
    if (sentence.length === 0) return [];
    const start = match.index + match[0].indexOf(sentence);
    return [{ sentence, start, end: start + sentence.length }];
  });
}

/**
 * The passage of a reply that states what the card's `ask` paraphrases, anchored on the sentence
 * sharing the most words with it (a question scores a point extra); its score is that sentence's.
 */
function askPassage(text: string, ask: string): (TextSpan & { readonly score: number }) | null {
  const askWords = words(ask);
  const scored = sentences(text).map((sentence) => {
    let shared = 0;
    for (const word of words(sentence.sentence)) if (askWords.has(word)) shared += 1;
    const question = ENDS_IN_QUESTION.test(sentence.sentence) ? 1 : 0;
    return { ...sentence, shared, score: shared + question };
  });
  let anchor = -1;
  scored.forEach((sentence, index) => {
    if (
      sentence.shared >= MIN_SHARED_WORDS &&
      (anchor < 0 || sentence.score >= scored[anchor]!.score)
    ) {
      anchor = index;
    }
  });
  if (anchor < 0) return null;
  let first = anchor;
  let last = anchor;
  const joins = (index: number) =>
    scored[index]!.shared > 0 &&
    Math.max(scored[last]!.end, scored[index]!.end) -
      Math.min(scored[first]!.start, scored[index]!.start) <=
      MAX_PASSAGE_CHARS;
  for (let index = first - 1; index >= 0 && index >= first - 2; index -= 1) {
    if (joins(index)) first = index;
  }
  for (let index = last + 1; index < scored.length && index <= last + 2; index += 1) {
    if (joins(index)) last = index;
  }
  return { start: scored[first]!.start, end: scored[last]!.end, score: scored[anchor]!.score };
}

function lastQuestion(text: string): TextSpan | null {
  const question = sentences(text).findLast(({ sentence }) => ENDS_IN_QUESTION.test(sentence));
  return question === undefined ? null : { start: question.start, end: question.end };
}

/** Where a rendered reply states the card's `ask`, else its last question. */
export function askSpanInReply(text: string, ask: string): TextSpan | null {
  return askPassage(text, ask) ?? lastQuestion(text);
}

/** Close enough to rendered text to find a quote in it: drops markdown marks, keeps words. */
export function markdownPlainText(markdown: string): string {
  return markdown
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\*\*|__|`/g, "")
    .replace(/^ {0,3}(?:#{1,6}|>|[-*+]|\d{1,9}[.)])[ \t]+/gm, "");
}

/**
 * The reply that states the card's `ask` among the thread's latest replies, newest first: the
 * strongest match, else the last reply's last question. The card may carry an ask forward from
 * an earlier reply, and may word as a question what the reply listed as decisions to overrule.
 */
export function findAskInThread<Id extends string>(
  messages: ReadonlyArray<{ readonly id: Id; readonly role: string; readonly text: string }>,
  ask: string,
): (TextSpan & { readonly messageId: Id; readonly text: string }) | null {
  const replies = messages
    .filter((message) => message.role === "assistant")
    .slice(-MESSAGES_SEARCHED);
  let best: (TextSpan & { messageId: Id; text: string; score: number }) | null = null;
  for (const reply of replies.toReversed()) {
    const text = markdownPlainText(reply.text);
    const passage = askPassage(text, ask);
    if (passage !== null && (best === null || passage.score > best.score)) {
      best = { ...passage, messageId: reply.id, text };
    }
  }
  if (best !== null) return best;
  const latest = replies.at(-1);
  if (latest === undefined) return null;
  const text = markdownPlainText(latest.text);
  const question = lastQuestion(text);
  return question === null ? null : { ...question, messageId: latest.id, text };
}
