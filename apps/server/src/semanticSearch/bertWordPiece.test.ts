import { assert, describe, it } from "@effect/vitest";

import { createBertWordPieceTokenizer } from "./bertWordPiece.ts";

// Minimal subset of BERT uncased vocab using real bert-base-uncased IDs.
const SAMPLE_VOCAB_LINES = (() => {
  const entries = new Map<number, string>([
    [0, "[PAD]"],
    [100, "[UNK]"],
    [101, "[CLS]"],
    [102, "[SEP]"],
    [1000, '"'],
    [1010, ","],
    [1012, "."],
    [1024, ":"],
    [1037, "a"],
    [1756, "中"],
    [1854, "文"],
    [2000, "to"],
    [2006, "on"],
    [2010, "his"],
    [2054, "what"],
    [2478, "using"],
    [3191, "read"],
    [4007, "ml"],
    [6462, "button"],
    [7668, "cafe"],
    [14308, "slap"],
    [15945, "volleyball"],
    [19553, "layout"],
    [2015, "##s"],
    [15678, "tele"],
    [26288, "##met"],
    [2854, "##ry"],
    [23755, "custom"],
    [16429, "##izable"],
  ]);
  const maxId = Math.max(...entries.keys());
  const lines: string[] = [];
  for (let id = 0; id <= maxId; id += 1) {
    lines.push(entries.get(id) ?? `[unused${id}]`);
  }
  return lines.join("\n");
})();

describe("bertWordPiece", () => {
  const tokenizer = createBertWordPieceTokenizer(SAMPLE_VOCAB_LINES);

  it("lowercases, strips accents, splits punctuation, and produces WordPiece subwords", () => {
    const encoded = tokenizer.encodeBatch(
      ["Customizable Café: using ML to read button layouts, telemetry."],
      32,
    );
    assert.equal(encoded.batchSize, 1);
    assert.deepEqual(Array.from(encoded.inputIds), [
      101n,
      23755n,
      16429n,
      7668n,
      1024n,
      2478n,
      4007n,
      2000n,
      3191n,
      6462n,
      19553n,
      2015n,
      1010n,
      15678n,
      26288n,
      2854n,
      1012n,
      102n,
    ]);
    assert.deepEqual(
      Array.from(encoded.attentionMask),
      Array.from({ length: encoded.seqLength }, () => 1n),
    );
    assert.deepEqual(
      Array.from(encoded.tokenTypeIds),
      Array.from({ length: encoded.seqLength }, () => 0n),
    );
  });

  it("isolates CJK characters and falls back to [UNK] for unknown words", () => {
    const encoded = tokenizer.encodeBatch(["中文 unknownword"], 16);
    assert.deepEqual(Array.from(encoded.inputIds), [101n, 1756n, 1854n, 100n, 102n]);
  });

  it("truncates to maxLength while preserving trailing [SEP] and pads batches to longest sequence", () => {
    const encoded = tokenizer.encodeBatch(["a a a a a a", "slap"], 6);
    assert.equal(encoded.batchSize, 2);
    assert.equal(encoded.seqLength, 6);
    assert.deepEqual(Array.from(encoded.inputIds), [
      101n,
      1037n,
      1037n,
      1037n,
      1037n,
      102n,
      101n,
      14308n,
      102n,
      0n,
      0n,
      0n,
    ]);
    assert.deepEqual(Array.from(encoded.attentionMask), [
      1n,
      1n,
      1n,
      1n,
      1n,
      1n,
      1n,
      1n,
      1n,
      0n,
      0n,
      0n,
    ]);
  });
});
