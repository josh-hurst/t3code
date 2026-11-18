import * as NodeUtil from "node:util";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { CodexSettings, ProviderInstanceId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Random from "effect/Random";
import * as Schema from "effect/Schema";
import * as ServerConfig from "../../apps/server/src/config.ts";
import { makeCodexTextGeneration } from "../../apps/server/src/textGeneration/CodexTextGeneration.ts";
import {
  buildThreadCardPrompt,
  parseThreadCard,
} from "../../apps/server/src/textGeneration/ThreadCard.ts";
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
      summary: Schema.NullOr(Schema.String),
      // Absent in results written before the summary became a card.
      topics: Schema.optional(Schema.Array(Schema.String)),
      open: Schema.optional(Schema.Array(Schema.String)),
      // Absent in results written before cards filed runs under entries.
      entries: Schema.optional(Schema.Array(Schema.String)),
      // Absent in results written before cards could adjust the inactivity timer.
      settle: Schema.optional(Schema.String),
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
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-reply-summary-eval-" });
    const service = yield* makeCodexTextGeneration(yield* decodeSettings({}));
    const baseline = values.baseline
      ? yield* fs.readFileString(values.baseline).pipe(Effect.flatMap(decodeResults))
      : [];
    const results = [];
    const review = [];
    const key = [];
    const now = yield* DateTime.now;
    for (const fixture of fixtures) {
      const prompt = buildThreadCardPrompt({
        reply: fixture.reply,
        userMessage: fixture.userMessage ?? null,
        previous: fixture.previous ?? null,
        contents: fixture.contents ?? { entries: [], previousRefs: [] },
        midRun: fixture.midRun ?? [],
        startedBy: fixture.startedBy ?? "owner",
        now: DateTime.formatIsoOffset(
          DateTime.makeZonedUnsafe(now, { timeZone: DateTime.zoneMakeLocal() }),
        ),
      });
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
        const card = parseThreadCard(transcription, DateTime.toEpochMillis(now));
        const row = {
          summary: card?.line ?? null,
          topics: card?.topics ?? [],
          open: (card?.open ?? []).map((item) =>
            item.dueAt === undefined
              ? `${item.kind}: ${item.text}`
              : `${item.kind} ${item.dueAt}: ${item.text}`,
          ),
          entries: (card?.entries ?? []).map((entry) =>
            entry.title === null
              ? `${entry.ref} | ${entry.outcome}`
              : `${entry.ref} | ${entry.title} | ${entry.outcome}`,
          ),
          settle: card?.settle ?? "none",
        };
        results.push({ id: fixture.id, sample, ...row, raw: transcription });
        const first = !previous || (yield* Random.nextBoolean);
        const before = previous && {
          summary: previous.summary,
          topics: previous.topics ?? [],
          open: previous.open ?? [],
          entries: previous.entries ?? [],
          settle: previous.settle ?? "none",
        };
        review.push({
          id: fixture.id,
          rubric: fixture.rubric,
          ...(fixture.expectEntries === undefined ? {} : { expectEntries: fixture.expectEntries }),
          ...(fixture.expectSettle === undefined ? {} : { expectSettle: fixture.expectSettle }),
          sample,
          A: first ? row : before,
          B: first ? before : row,
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
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-reply-summary-eval-state-" }).pipe(
        Layer.provideMerge(NodeServices.layer),
      ),
    ),
    Effect.scoped,
  ),
);
