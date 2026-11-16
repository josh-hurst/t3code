import type { RegroupTopic } from "../../apps/server/src/orchestration-v2/ThreadRegroup.ts";

/** Topic labels per run, run 1 first. A run can hold two labels. */
export type Grouping = ReadonlyArray<ReadonlySet<string>>;

export interface Pass {
  /** Exactly this many topics, or a range. */
  readonly topics?: number | readonly [min: number, max: number];
  readonly minF?: number;
  /** Runs (1-based) that must share a topic. */
  readonly together?: ReadonlyArray<ReadonlyArray<number>>;
  /** Runs the model may drop before `repairTopics` fills them in. */
  readonly maxRepaired?: number;
}

export const groupingOfLabels = (labels: ReadonlyArray<string>): Grouping =>
  labels.map((label) => new Set(label.split("+")));

export const groupingOfTopics = (topics: ReadonlyArray<RegroupTopic>, runCount: number): Grouping =>
  Array.from(
    { length: runCount },
    (_, index) =>
      new Set(
        topics.flatMap((topic, topicIndex) =>
          topic.runs.includes(index + 1) ? [`t${topicIndex}`] : [],
        ),
      ),
  );

const shared = (left: ReadonlySet<string>, right: ReadonlySet<string>) =>
  [...left].filter((label) => right.has(label)).length;

/** Extended B-cubed (Amigó et al. 2009) for overlapping groups, averaged over runs. */
export function bcubed(predicted: Grouping, gold: Grouping) {
  const n = gold.length;
  let precision = 0;
  let recall = 0;
  for (let i = 0; i < n; i++) {
    let pNum = 0;
    let pDen = 0;
    let rNum = 0;
    let rDen = 0;
    for (let j = 0; j < n; j++) {
      const c = shared(predicted[i]!, predicted[j]!);
      const l = shared(gold[i]!, gold[j]!);
      if (c > 0) {
        pNum += Math.min(c, l) / c;
        pDen++;
      }
      if (l > 0) {
        rNum += Math.min(c, l) / l;
        rDen++;
      }
    }
    precision += pDen === 0 ? 0 : pNum / pDen;
    recall += rDen === 0 ? 0 : rNum / rDen;
  }
  precision /= n;
  recall /= n;
  return {
    precision,
    recall,
    f: precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall),
  };
}

export function grade(input: {
  readonly topics: ReadonlyArray<RegroupTopic>;
  readonly runCount: number;
  /** One or more acceptable readings; the best one counts. */
  readonly gold: ReadonlyArray<Grouping>;
  readonly repaired: number;
  readonly pass: Pass;
}) {
  const predicted = groupingOfTopics(input.topics, input.runCount);
  const f = Math.max(...input.gold.map((reading) => bcubed(predicted, reading).f));
  const failures: Array<string> = [];
  const { pass } = input;
  const count = input.topics.length;
  if (pass.topics !== undefined) {
    const [min, max] = typeof pass.topics === "number" ? [pass.topics, pass.topics] : pass.topics;
    if (count < min || count > max) failures.push(`${count} topics, expected ${min}..${max}`);
  }
  if (pass.minF !== undefined && f < pass.minF) failures.push(`F ${f.toFixed(2)} < ${pass.minF}`);
  for (const runs of pass.together ?? []) {
    const [first, ...rest] = runs.map((run) => predicted[run - 1]!);
    if (!rest.every((labels) => shared(first!, labels) > 0)) {
      failures.push(`runs ${runs.join(" ")} not in one topic`);
    }
  }
  if (pass.maxRepaired !== undefined && input.repaired > pass.maxRepaired) {
    failures.push(`${input.repaired} runs repaired`);
  }
  return { f, topics: count, repaired: input.repaired, pass: failures.length === 0, failures };
}
