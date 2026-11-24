import { describe, expect, it } from "vite-plus/test";

import {
  buildIncrementalProjectChangelogPrompt,
  buildProjectChangelogPrompt,
  changelogFolders,
  parseIncrementalProjectChangelog,
  parseProjectChangelog,
} from "./ProjectChangelog.ts";

const commits = ["aaa", "bbb", "ccc", "ddd"].map((sha) => ({ sha }));

describe("parseProjectChangelog", () => {
  it("reads each change with its commits and each commit's line, and gathers unnamed commits", () => {
    const raw = [
      "Here is the changelog:",
      "change: **Premium store** | Looks and moves sell for coins | the old shops are gone | 1, 2, 2, 9",
      "- change: Ranked queue | Pairs players by device first | 2",
      "change: No commits | Names nothing real | 12",
      "change: too few fields",
      "commit: 1 | Coin prices for looks",
      "commit: 2 | `Device pairing` in the queue",
      "commit: 9 | Names no commit",
    ].join("\n");
    expect(parseProjectChangelog(raw, commits)).toEqual({
      items: [
        {
          title: "Premium store",
          summary: "Looks and moves sell for coins | the old shops are gone",
          shas: ["aaa", "bbb"],
        },
        { title: "Ranked queue", summary: "Pairs players by device first", shas: ["bbb"] },
        { title: "Other commits", summary: "", shas: ["ccc", "ddd"] },
      ],
      labels: { aaa: "Coin prices for looks", bbb: "Device pairing in the queue" },
    });
  });

  it("is null when the reply lists no change", () => {
    expect(parseProjectChangelog("I could not read the commits.", commits)).toBeNull();
  });
});

describe("the changelog prompt", () => {
  it("numbers the commits and names the folders most of their files sit in", () => {
    expect(
      changelogFolders(["src/Client/Shop/Store.luau", "src/Client/Shop/Coin.luau", "README.md"]),
    ).toEqual(["Client/Shop", "."]);
    const prompt = buildProjectChangelogPrompt([
      {
        sha: "aaa",
        subject: "Store: coin prices",
        body: "Why.\n\nMore.",
        files: 2,
        folders: ["Shop"],
      },
      { sha: "bbb", subject: "Ranked queue", body: "", files: 1, folders: ["Ranked"] },
    ]);
    expect(prompt).toContain("1. Store: coin prices [2 files: Shop]\n   Why.\n   More.");
    expect(prompt).toContain("2. Ranked queue [1 files: Ranked]");
  });

  it("builds and merges incremental changelog updates onto an existing digest", () => {
    const existing = {
      items: [
        { title: "Premium store", summary: "Coins replace gems", shas: ["aaa", "bbb"] },
        { title: "Ranked queue", summary: "Pairs by device", shas: ["ccc"] },
      ],
      labels: { aaa: "Coin prices", bbb: "Drop gem shop", ccc: "Device pairing" },
    };
    const prompt = buildIncrementalProjectChangelogPrompt(existing, [
      { sha: "ddd", subject: "Fix coin rounding", body: "", files: 1, folders: ["Shop"] },
      { sha: "eee", subject: "Add leaderboards", body: "", files: 3, folders: ["Board"] },
      { sha: "fff", subject: "Misc tweak", body: "", files: 1, folders: ["Misc"] },
    ]);
    expect(prompt).toContain("c1 | Premium store | Coins replace gems");
    expect(prompt).toContain("1. Fix coin rounding [1 files: Shop]");
    expect(prompt).not.toContain("Drop gem shop");

    const merged = parseIncrementalProjectChangelog(
      [
        "update: c1 | Premium store | Coins replace gems; fixed rounding | 1",
        "change: Leaderboards | Global and friend boards | 2",
        "commit: 1 | Fix coin rounding",
        "commit: 2 | Global and friend boards",
      ].join("\n"),
      existing,
      [{ sha: "ddd" }, { sha: "eee" }, { sha: "fff" }],
    );
    expect(merged).toEqual({
      items: [
        { title: "Leaderboards", summary: "Global and friend boards", shas: ["eee"] },
        {
          title: "Premium store",
          summary: "Coins replace gems; fixed rounding",
          shas: ["aaa", "bbb", "ddd"],
        },
        { title: "Ranked queue", summary: "Pairs by device", shas: ["ccc"] },
        { title: "Other commits", summary: "", shas: ["fff"] },
      ],
      labels: {
        aaa: "Coin prices",
        bbb: "Drop gem shop",
        ccc: "Device pairing",
        ddd: "Fix coin rounding",
        eee: "Global and friend boards",
      },
    });
    expect(
      parseIncrementalProjectChangelog("Nothing useful.", existing, [{ sha: "ddd" }]),
    ).toBeNull();
  });
});
