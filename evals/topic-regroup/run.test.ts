import { describe, expect, it } from "vite-plus/test";
import { bcubed, grade, groupingOfLabels } from "./grade.ts";

const topic = (runs: ReadonlyArray<number>) => ({ title: "T", outcome: "", runs });

describe("bcubed", () => {
  it.each([
    ["the same grouping", ["a", "a", "b", "b"], ["x", "x", "y", "y"], 1, 1],
    ["everything lumped", ["a", "a", "a", "a"], ["x", "x", "y", "y"], 0.5, 1],
    ["everything split", ["a", "b", "c", "d"], ["x", "x", "y", "y"], 1, 0.5],
    ["a run in two topics", ["a+b", "a", "b"], ["x+y", "x", "y"], 1, 1],
    ["a second topic gold does not give", ["a+b", "a", "b"], ["x", "x", "y"], 2 / 3, 1],
  ] as const)("scores %s", (_name, predicted, gold, precision, recall) => {
    const score = bcubed(groupingOfLabels(predicted), groupingOfLabels(gold));
    expect(score.precision).toBeCloseTo(precision);
    expect(score.recall).toBeCloseTo(recall);
  });
});

describe("grade", () => {
  const gold = [groupingOfLabels(["x", "x", "y", "y"])];

  it.each([
    ["a right grouping", [topic([1, 2]), topic([3, 4])], 0, { topics: 2, minF: 0.9 }, true],
    ["too many topics", [topic([1]), topic([2]), topic([3, 4])], 0, { topics: 2 }, false],
    ["a count in range", [topic([1]), topic([2]), topic([3, 4])], 0, { topics: [2, 3] }, true],
    ["low F", [topic([1, 2, 3, 4])], 0, { minF: 0.9 }, false],
    ["runs kept together", [topic([1, 2, 3, 4])], 0, { together: [[1, 4]] }, true],
    ["runs pulled apart", [topic([1, 2]), topic([3, 4])], 0, { together: [[1, 4]] }, false],
    ["too many repairs", [topic([1, 2]), topic([3, 4])], 3, { maxRepaired: 2 }, false],
    ["a title it must avoid", [topic([1, 2, 3, 4])], 0, { titleAvoids: /^T$/ }, false],
  ] as const)("judges %s", (_name, topics, repaired, pass, expected) => {
    expect(grade({ topics, runCount: 4, gold, repaired, pass }).pass).toBe(expected);
  });

  it("takes the best of several readings", () => {
    const readings = [
      groupingOfLabels(["x", "x", "y", "y"]),
      groupingOfLabels(["x", "x", "x", "x"]),
    ];
    expect(
      grade({ topics: [topic([1, 2, 3, 4])], runCount: 4, gold: readings, repaired: 0, pass: {} })
        .f,
    ).toBe(1);
  });
});
