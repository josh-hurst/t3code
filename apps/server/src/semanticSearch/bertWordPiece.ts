export interface BertWordPieceBatch {
  readonly inputIds: BigInt64Array;
  readonly attentionMask: BigInt64Array;
  readonly tokenTypeIds: BigInt64Array;
  readonly batchSize: number;
  readonly seqLength: number;
}

export interface BertWordPieceTokenizer {
  readonly encode: (text: string, maxLength?: number) => ReadonlyArray<number>;
  readonly encodeBatch: (texts: ReadonlyArray<string>, maxLength?: number) => BertWordPieceBatch;
}

/**
 * Self-contained BERT uncased WordPiece tokenizer (`do_lower_case: true`, `strip_accents: true`,
 * `tokenize_chinese_chars: true`). Kept free of outer imports so the child worker can inline it
 * via `.toString()`, avoiding a sibling bundle artifact.
 */
export function createBertWordPieceTokenizer(vocabText: string): BertWordPieceTokenizer {
  const vocab = new Map<string, number>();
  const lines = vocabText.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const token = lines[index]!;
    if (token.length > 0) vocab.set(token, index);
  }
  const padId = vocab.get("[PAD]") ?? 0;
  const unkId = vocab.get("[UNK]") ?? 100;
  const clsId = vocab.get("[CLS]") ?? 101;
  const sepId = vocab.get("[SEP]") ?? 102;
  const maxWordChars = 200;

  const isWhitespace = (code: number): boolean =>
    code === 0x20 ||
    code === 0x09 ||
    code === 0x0a ||
    code === 0x0d ||
    code === 0x00a0 ||
    /\p{Zs}/u.test(String.fromCodePoint(code));

  const isControl = (code: number): boolean => {
    if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
    return (
      code === 0 ||
      code === 0xfffd ||
      (code >= 0x01 && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f) ||
      /\p{Cc}|\p{Cf}/u.test(String.fromCodePoint(code))
    );
  };

  const isChineseChar = (cp: number): boolean =>
    (cp >= 0x4e00 && cp <= 0x9fff) ||
    (cp >= 0x3400 && cp <= 0x4dbf) ||
    (cp >= 0x20000 && cp <= 0x2a6df) ||
    (cp >= 0x2a700 && cp <= 0x2b73f) ||
    (cp >= 0x2b740 && cp <= 0x2b81f) ||
    (cp >= 0x2b820 && cp <= 0x2ceaf) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0x2f800 && cp <= 0x2fa1f);

  const isPunctuation = (char: string, cp: number): boolean => {
    if (
      (cp >= 33 && cp <= 47) ||
      (cp >= 58 && cp <= 64) ||
      (cp >= 91 && cp <= 96) ||
      (cp >= 123 && cp <= 126)
    ) {
      return true;
    }
    return /\p{P}/u.test(char);
  };

  const cleanAndSpaceCjk = (text: string): string => {
    let out = "";
    for (const char of text) {
      const cp = char.codePointAt(0)!;
      if (cp === 0 || cp === 0xfffd || isControl(cp)) continue;
      if (isWhitespace(cp)) {
        out += " ";
      } else if (isChineseChar(cp)) {
        out += ` ${char} `;
      } else {
        out += char;
      }
    }
    return out;
  };

  const splitOnPunctuation = (token: string): string[] => {
    const pieces: string[] = [];
    let current = "";
    for (const char of token) {
      const cp = char.codePointAt(0)!;
      if (isPunctuation(char, cp)) {
        if (current.length > 0) {
          pieces.push(current);
          current = "";
        }
        pieces.push(char);
      } else {
        current += char;
      }
    }
    if (current.length > 0) pieces.push(current);
    return pieces;
  };

  const wordPiece = (word: string, output: number[], maxContentTokens: number): void => {
    const chars = Array.from(word);
    if (chars.length > maxWordChars) {
      if (output.length < maxContentTokens) output.push(unkId);
      return;
    }
    let start = 0;
    const subTokens: number[] = [];
    while (start < chars.length) {
      let end = chars.length;
      let found: number | undefined;
      while (start < end) {
        let substr = chars.slice(start, end).join("");
        if (start > 0) substr = `##${substr}`;
        const id = vocab.get(substr);
        if (id !== undefined) {
          found = id;
          break;
        }
        end -= 1;
      }
      if (found === undefined) {
        if (output.length < maxContentTokens) output.push(unkId);
        return;
      }
      subTokens.push(found);
      start = end;
    }
    for (const id of subTokens) {
      if (output.length >= maxContentTokens) break;
      output.push(id);
    }
  };

  const encode = (text: string, maxLength = 512): number[] => {
    const maxContentTokens = Math.max(0, maxLength - 2);
    const ids: number[] = [clsId];
    const cleaned = cleanAndSpaceCjk(text).trim();
    if (cleaned.length > 0) {
      for (const raw of cleaned.split(/\s+/)) {
        if (ids.length - 1 >= maxContentTokens) break;
        const normalized = raw
          .toLowerCase()
          .normalize("NFD")
          .replace(/\p{Mn}/gu, "");
        for (const piece of splitOnPunctuation(normalized)) {
          if (ids.length - 1 >= maxContentTokens) break;
          wordPiece(piece, ids, maxContentTokens + 1);
        }
      }
    }
    ids.push(sepId);
    return ids;
  };

  const encodeBatch = (texts: ReadonlyArray<string>, maxLength = 512): BertWordPieceBatch => {
    const encoded = texts.map((text) => encode(text, maxLength));
    let seqLength = 1;
    for (const ids of encoded) {
      if (ids.length > seqLength) seqLength = ids.length;
    }
    const batchSize = encoded.length;
    const total = batchSize * seqLength;
    const inputIds = new BigInt64Array(total);
    const attentionMask = new BigInt64Array(total);
    const tokenTypeIds = new BigInt64Array(total);
    if (padId !== 0) inputIds.fill(BigInt(padId));
    for (let row = 0; row < batchSize; row += 1) {
      const ids = encoded[row]!;
      const offset = row * seqLength;
      for (let col = 0; col < ids.length; col += 1) {
        inputIds[offset + col] = BigInt(ids[col]!);
        attentionMask[offset + col] = 1n;
      }
    }
    return { inputIds, attentionMask, tokenTypeIds, batchSize, seqLength };
  };

  return { encode, encodeBatch };
}
