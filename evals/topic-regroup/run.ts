import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CodexSettings,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ThreadRunLine,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { runOwnerText } from "../../apps/server/src/orchestration-v2/ThreadEntries.ts";
import {
  buildOutline,
  combineSamples,
  parseTopics,
  type RegroupTopic,
  repairTopics,
} from "../../apps/server/src/orchestration-v2/ThreadRegroup.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import { buildThreadRegroupPrompt } from "../../apps/server/src/textGeneration/ThreadRegroup.ts";
import { cases } from "./cases.ts";
import { grade, groupingOfLabels } from "./grade.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "gpt-6-luna" },
    effort: { type: "string", default: "low" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
    "dry-run": { type: "boolean", default: false },
  },
});
const { out, model, effort } = values;
const dryRun = values["dry-run"];
const samples = Number(values.samples);
const caseIds = values.case?.split(",").map((id) => id.trim());
const fixtures = cases.filter((fixture) => !caseIds || caseIds.includes(fixture.id));
if (!out || !fixtures.length || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error(
    "Use --out <directory> [--model <codex model>] [--effort <level>] [--case <id,...>] [--samples <count>] [--baseline <summary.json>] [--dry-run].",
  );
}

const Summary = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ id: Schema.String, meanF: Schema.Number })),
);
const decodeSummary = Schema.decodeEffect(Summary);
const decodeSettings = Schema.decodeEffect(CodexSettings);
const encodeRows = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

/** The run lines a thread of these runs would have stored, so the outline is built as in production. */
function runLines(fixture: (typeof cases)[number]): ReadonlyArray<ThreadRunLine> {
  const threadId = ThreadId.make(`thread:${fixture.id}`);
  return fixture.runs.map(([owner, line], index) => {
    const startedBy = owner === null ? "report" : "owner";
    const at = `2030-01-01T${String(Math.floor(index / 60)).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}:00.000Z`;
    return {
      runId: RunId.make(`run:${fixture.id}:${index + 1}`),
      threadId,
      ordinal: index + 1,
      userMessageId: MessageId.make(`message:${index + 1}:user`),
      replyMessageId: MessageId.make(`message:${index + 1}:reply`),
      line,
      ownerText: runOwnerText({ startedBy, startText: owner, midRun: [] }),
      startedBy,
      startedAt: at,
      repliedAt: at,
    };
  });
}

const labelsToTopics = (labels: ReadonlyArray<string>): ReadonlyArray<RegroupTopic> => {
  const names = [...new Set(labels.flatMap((label) => label.split("+")))];
  return names.map((name) => ({
    title: name,
    outcome: "",
    runs: labels.flatMap((label, index) => (label.split("+").includes(name) ? [index + 1] : [])),
  }));
};

await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(out, { recursive: true });
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-topic-regroup-eval-" });
    const service = dryRun ? null : yield* makeCodexTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeSummary))
      : [];
    const results: Array<unknown> = [];
    const summary: Array<Record<string, unknown>> = [];
    let calls = 0;
    const save = Effect.fnUntraced(function* (name: string, rows: ReadonlyArray<unknown>) {
      yield* fs.writeFileString(path.join(out, `${name}.json`), yield* encodeRows(rows));
    });

    for (const fixture of fixtures) {
      const outline = buildOutline(runLines(fixture));
      const runCount = outline.runIds.length;
      const prompt = buildThreadRegroupPrompt(outline.text);
      const gold = [fixture.runs.map(([, , topic]) => topic), ...(fixture.alternatives ?? [])].map(
        groupingOfLabels,
      );
      const judge = (topics: ReadonlyArray<RegroupTopic>, repaired: number) =>
        grade({ topics, runCount, gold, repaired, pass: fixture.pass });

      if (service === null) {
        // Costs nothing: the case is well formed and its own gold passes it.
        const self = judge(labelsToTopics(fixture.runs.map(([, , topic]) => topic)), 0);
        if (runCount !== fixture.runs.length || !self.pass) {
          throw new Error(`${fixture.id}: gold fails its own check (${self.failures.join("; ")}).`);
        }
        summary.push({ id: fixture.id, runs: runCount, promptChars: prompt.length, gold: self });
        continue;
      }

      const parsed: Array<ReadonlyArray<RegroupTopic>> = [];
      const graded = [];
      for (let sample = 1; sample <= samples; sample++) {
        calls++;
        const { transcription } = yield* service.generateTranscriptionPostProcessing({
          cwd,
          prompt,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model,
            options: [{ id: "reasoningEffort", value: effort }],
          },
        });
        const topics = parseTopics(transcription, runCount);
        const repaired = topics === null ? null : repairTopics(topics, runCount);
        if (repaired !== null) parsed.push(repaired.topics);
        const result =
          repaired === null
            ? { f: 0, topics: 0, repaired: runCount, pass: false, failures: ["nothing parsed"] }
            : judge(repaired.topics, repaired.repaired);
        graded.push(result);
        results.push({
          id: fixture.id,
          sample,
          ...result,
          grouping: repaired?.topics.map((topic) => `${topic.title} | ${topic.runs.join(" ")}`),
          raw: transcription,
        });
        yield* save("results", results);
      }
      const combined = parsed.length >= 2 ? judge(combineSamples(parsed, runCount), 0) : undefined;
      const meanF = graded.reduce((total, result) => total + result.f, 0) / graded.length;
      const previous = baseline.find((row) => row.id === fixture.id);
      summary.push({
        id: fixture.id,
        kind: fixture.kind,
        // A case fails when half or more of its samples fail.
        pass: graded.filter((result) => !result.pass).length * 2 < graded.length,
        samplesPassed: `${graded.filter((result) => result.pass).length}/${graded.length}`,
        meanF: Number(meanF.toFixed(3)),
        topics: graded.map((result) => result.topics),
        ...(combined === undefined
          ? {}
          : {
              combined: {
                pass: combined.pass,
                f: Number(combined.f.toFixed(3)),
                topics: combined.topics,
              },
            }),
        ...(previous === undefined ? {} : { baselineMeanF: previous.meanF }),
      });
      yield* save("summary", summary);
    }
    yield* save("summary", summary);
    yield* Effect.log(`topic-regroup: ${fixtures.length} cases, ${calls} model calls`);
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-topic-regroup-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
