import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import {
  buildProjectChangelogPrompt,
  parseProjectChangelog,
} from "../../apps/server/src/textGeneration/ProjectChangelog.ts";
import { cases } from "./cases.ts";

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "gpt-6-luna" },
    effort: { type: "string", default: "low" },
    baseline: { type: "string" },
    case: { type: "string" },
    samples: { type: "string", default: "3" },
  },
});
const { out, model, effort } = values;
const samples = Number(values.samples);
const caseIds = values.case?.split(",").map((id) => id.trim());
const fixtures = cases.filter((fixture) => !caseIds || caseIds.includes(fixture.id));
if (!out || !fixtures.length || !Number.isSafeInteger(samples) || samples < 1) {
  throw new Error(
    "Use --out <directory> [--model <codex model>] [--effort <level>] [--case <id,...>] [--samples <count>].",
  );
}
const Results = Schema.fromJsonString(
  Schema.Array(
    Schema.Struct({
      id: Schema.String,
      sample: Schema.Number,
      changes: Schema.NullOr(Schema.Array(Schema.String)),
    }),
  ),
);
const decodeSettings = Schema.decodeEffect(CodexSettings);
const decodeResults = Schema.decodeEffect(Results);
const encodeRows = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));
await Effect.runPromise(
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-changelog-eval-" });
    const service = yield* makeCodexTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    const key = [];
    for (const fixture of fixtures) {
      // Commit numbers stand in for ids, so a change reads "title | what changed | 1, 2".
      const commits = fixture.commits.map((commit, index) => ({ ...commit, sha: `${index + 1}` }));
      const prompt = buildProjectChangelogPrompt(commits);
      for (let sample = 1; sample <= samples; sample++) {
        const previous = baseline.find((row) => row.id === fixture.id && row.sample === sample);
        if (values.baseline && !previous)
          throw new Error(`Missing baseline for ${fixture.id} sample ${sample}.`);
        const { transcription } = yield* service.generateTranscriptionPostProcessing({
          cwd,
          prompt,
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model,
            options: [{ id: "reasoningEffort", value: effort }],
          },
        });
        const parsed = parseProjectChangelog(transcription, commits);
        const changes =
          parsed === null
            ? null
            : [
                ...parsed.items.map(
                  (item) => `${item.title} | ${item.summary} | ${item.shas.join(", ")}`,
                ),
                ...Object.entries(parsed.labels).map(([sha, label]) => `  ${sha}: ${label}`),
              ];
        results.push({ id: fixture.id, sample, changes, raw: transcription });
        const first = !previous || (yield* Random.nextBoolean);
        const before = previous && previous.changes;
        review.push({
          id: fixture.id,
          rubric: fixture.rubric,
          commits: fixture.commits.map((commit, index) => `${index + 1}. ${commit.subject}`),
          sample,
          A: first ? changes : before,
          B: first ? before : changes,
        });
        key.push({ id: fixture.id, sample, candidate: first ? "A" : "B" });
      }
    }
    yield* fs.makeDirectory(out, { recursive: true });
    for (const [name, rows] of [
      ["results", results],
      ["review", review],
      ["answer-key", key],
    ] as const) {
      yield* fs.writeFileString(path.join(out, name + ".json"), yield* encodeRows(rows));
    }
  }).pipe(
    Effect.provide(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-project-changelog-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
