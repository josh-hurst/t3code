import { describe, expect, it } from "vite-plus/test";

import { parseRunHeadlines } from "./ThreadRegroup.ts";

describe("parseRunHeadlines", () => {
  it.each([
    [
      "one line per run",
      "r1: Fixed login redirect\nr2: Added CSV export",
      2,
      ["Fixed login redirect", "Added CSV export"],
    ],
    [
      "bullets, quotes and a missing run",
      '- r2: "Raised upload limit to 20 MB."\n',
      3,
      [null, "Raised upload limit to 20 MB", null],
    ],
    ["a number out of range and a repeat", "r3: Extra\nr1: First\nr1: Second", 2, ["First", null]],
    ["no headline at all", "Here are your headlines.", 2, null],
  ])("%s", (_name, raw, count, expected) => {
    expect(parseRunHeadlines(raw, count)).toEqual(expected);
  });
});
