const SENTENCE = /[^.!?\n]+[.!?]*["'”’)\]]*/g;
const WORD = /[\p{L}\p{N}]{3,}/gu;

const words = (text: string) => new Set(text.toLowerCase().match(WORD));

/**
 * Where a reply asks the question its card paraphrases: the question sentence sharing the most
 * words with `ask`, the later one on a tie. Null when the reply asks nothing in a sentence.
 */
export function closingQuestionSpan(
  text: string,
  ask: string,
): { readonly start: number; readonly end: number } | null {
  const askWords = words(ask);
  let best: { start: number; end: number; score: number } | null = null;
  for (const match of text.matchAll(SENTENCE)) {
    const sentence = match[0].trim();
    if (!/\?["'”’)\]]*$/.test(sentence)) continue;
    const start = match.index + match[0].indexOf(sentence);
    let score = 0;
    for (const word of words(sentence)) if (askWords.has(word)) score += 1;
    if (best === null || score >= best.score) {
      best = { start, end: start + sentence.length, score };
    }
  }
  return best === null ? null : { start: best.start, end: best.end };
}
