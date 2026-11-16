import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  historyChipKeys,
  historyListInputs,
  publishTargets,
  validateHistorySearch,
} from "./historyPage.logic";

const local = EnvironmentId.make("environment:local");
const remote = EnvironmentId.make("environment:remote");
const members = [
  { environmentId: local, projectId: ProjectId.make("project:game") },
  { environmentId: local, projectId: ProjectId.make("project:game-worktree") },
];

describe("History page", () => {
  it("reads its URL defensively", () => {
    expect(validateHistorySearch({ project: " key ", open: 1, q: "  " })).toEqual({
      project: "key",
      open: "1",
    });
    expect(validateHistorySearch({ open: "yes", q: "x".repeat(150) }).q).toHaveLength(100);
  });

  it("asks only environments holding the group's projects, and never with an empty list", () => {
    expect(
      historyListInputs({
        environmentIds: [local, remote],
        members,
        stillOpen: true,
        query: " shop button ",
      }),
    ).toEqual([
      {
        environmentId: local,
        input: {
          projectIds: members.map((member) => member.projectId),
          stillOpen: true,
          query: "shop button",
        },
      },
    ]);
    expect(
      historyListInputs({
        environmentIds: [local, remote],
        members: null,
        stillOpen: false,
        query: "",
      }),
    ).toEqual([
      { environmentId: local, input: {} },
      { environmentId: remote, input: {} },
    ]);
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
