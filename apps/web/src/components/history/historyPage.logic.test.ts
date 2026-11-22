import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { historyChipKeys, publishTargets, validateHistorySearch } from "./historyPage.logic";

const local = EnvironmentId.make("environment:local");
const remote = EnvironmentId.make("environment:remote");
const members = [
  { environmentId: local, projectId: ProjectId.make("project:game") },
  { environmentId: local, projectId: ProjectId.make("project:game-worktree") },
];

describe("History page", () => {
  it("reads its URL defensively", () => {
    expect(validateHistorySearch({ project: " key ", open: 1, q: "  ", view: "changes" })).toEqual({
      project: "key",
      open: "1",
      view: "changes",
    });
    expect(validateHistorySearch({ view: "other" })).toEqual({});
    expect(validateHistorySearch({ open: "yes", q: "x".repeat(150) }).q).toHaveLength(100);
  });

  it("sends Mark published to no environment that lacks the group's projects", () => {
    expect(publishTargets(members, [remote])).toEqual([]);
  });

  it("keeps a chip for every project shown so far and for the chosen one, in sidebar order", () => {
    expect(
      historyChipKeys({
        orderedKeys: ["a", "b", "c", "d"],
        seenKeys: new Set(["c", "a"]),
        chosenKey: "d",
      }),
    ).toEqual(["a", "c", "d"]);
  });
});
