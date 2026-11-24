// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - native ONNX inference runs in an isolated killable child process.
import * as NodeChildProcess from "node:child_process";
import * as NodeOS from "node:os";
import * as NodeSea from "node:sea";
import { createBertWordPieceTokenizer } from "./bertWordPiece.ts";
import { BGE_SMALL_EN_V15_DIMENSIONS, BGE_SMALL_EN_V15_MAX_LENGTH } from "./model.ts";

const loaderEntry = `
  const { createRequire, findPackageJSON } = await import("node:module");
  const { readFileSync } = await import("node:fs");
  const { dirname, join } = await import("node:path");
  const loadOrt = () => {
    const packagePath = findPackageJSON("onnxruntime-node", baseUrl);
    if (!packagePath) throw new Error("onnxruntime-node is unavailable.");
    return createRequire(packagePath)(join(dirname(packagePath), "dist/index.js"));
  };
`;

const workerEntry = `
  const createBertWordPieceTokenizer = ${createBertWordPieceTokenizer.toString()};
  let ort;
  let session;
  let tokenizer;
  let outputName;
  let dimensions = ${BGE_SMALL_EN_V15_DIMENSIONS};
  let maxLength = ${BGE_SMALL_EN_V15_MAX_LENGTH};

  const runEncodedBatch = async (encodedRows) => {
    const batchSize = encodedRows.length;
    let seqLength = 1;
    for (const row of encodedRows) {
      if (row.ids.length > seqLength) seqLength = row.ids.length;
    }
    const total = batchSize * seqLength;
    const inputIdsArr = new BigInt64Array(total);
    const attentionMaskArr = new BigInt64Array(total);
    const tokenTypeIdsArr = new BigInt64Array(total);
    for (let row = 0; row < batchSize; row += 1) {
      const ids = encodedRows[row].ids;
      const offset = row * seqLength;
      for (let col = 0; col < ids.length; col += 1) {
        inputIdsArr[offset + col] = BigInt(ids[col]);
        attentionMaskArr[offset + col] = 1n;
      }
    }
    const dims = [batchSize, seqLength];
    const inputIds = new ort.Tensor("int64", inputIdsArr, dims);
    const attentionMask = new ort.Tensor("int64", attentionMaskArr, dims);
    const tokenTypeIds = new ort.Tensor("int64", tokenTypeIdsArr, dims);
    let outputs;
    try {
      const feeds = { input_ids: inputIds, attention_mask: attentionMask };
      if (session.inputNames.includes("token_type_ids")) {
        feeds.token_type_ids = tokenTypeIds;
      }
      outputs = await session.run(feeds);
      const hidden = outputs[outputName];
      const data = hidden.data;
      const hiddenDims = hidden.dims;
      const seqLen = hiddenDims.length === 3 ? hiddenDims[1] : 1;
      const hiddenSize = hiddenDims[hiddenDims.length - 1];
      const vectors = new Float32Array(batchSize * hiddenSize);
      for (let row = 0; row < batchSize; row += 1) {
        // CLS pooling: token 0 of each sequence, L2-normalized.
        const srcOffset = row * seqLen * hiddenSize;
        const dstOffset = row * hiddenSize;
        let normSq = 0;
        for (let d = 0; d < hiddenSize; d += 1) {
          const val = data[srcOffset + d];
          normSq += val * val;
        }
        const invNorm = normSq > 0 ? 1 / Math.sqrt(normSq) : 0;
        for (let d = 0; d < hiddenSize; d += 1) {
          vectors[dstOffset + d] = data[srcOffset + d] * invNorm;
        }
      }
      return { vectors, hiddenSize };
    } finally {
      inputIds.dispose();
      attentionMask.dispose();
      tokenTypeIds.dispose();
      if (outputs) {
        for (const tensor of Object.values(outputs)) {
          if (tensor && typeof tensor.dispose === "function") tensor.dispose();
        }
      }
    }
  };

  process.on("message", async (message) => {
    try {
      if (message.kind === "load") {
        ort = loadOrt();
        if (typeof message.dimensions === "number") dimensions = message.dimensions;
        if (typeof message.maxLength === "number") maxLength = message.maxLength;
        tokenizer = createBertWordPieceTokenizer(readFileSync(message.vocabPath, "utf8"));
        session = await ort.InferenceSession.create(message.modelPath, {
          executionProviders: ["cpu"],
          graphOptimizationLevel: "all",
          enableCpuMemArena: false,
          enableMemPattern: false,
          intraOpNumThreads: message.intraOpNumThreads ?? 2,
          interOpNumThreads: 1,
          logSeverityLevel: 3,
        });
        outputName = session.outputNames.includes("last_hidden_state")
          ? "last_hidden_state"
          : session.outputNames[0];
        process.send({
          type: "t3-semantic-reply",
          id: message.id,
          ok: true,
          rssBytes: process.memoryUsage().rss,
        });
      } else if (message.kind === "embed") {
        const texts = message.texts;
        const microBatchSize = message.microBatchSize ?? 8;
        const maxBatchTokens = message.maxBatchTokens ?? 1024;
        if (!Array.isArray(texts) || texts.length === 0) {
          process.send({
            type: "t3-semantic-reply",
            id: message.id,
            ok: true,
            vectors: new Float32Array(0),
            dimensions,
            rssBytes: process.memoryUsage().rss,
          });
          return;
        }
        // Sort by token length and cap batch tokens so one long chunk never pads an entire batch to 512.
        const encoded = texts.map((text, index) => ({
          index,
          ids: tokenizer.encode(text, maxLength),
        }));
        if (encoded.length > 1) {
          encoded.sort((a, b) => a.ids.length - b.ids.length);
        }
        const out = new Float32Array(texts.length * dimensions);
        let outDims = dimensions;
        let cursor = 0;
        while (cursor < encoded.length) {
          const slice = [encoded[cursor]];
          let maxLen = encoded[cursor].ids.length;
          cursor += 1;
          while (cursor < encoded.length && slice.length < microBatchSize) {
            const candidateLen = Math.max(maxLen, encoded[cursor].ids.length);
            if (candidateLen * (slice.length + 1) > maxBatchTokens) break;
            slice.push(encoded[cursor]);
            maxLen = candidateLen;
            cursor += 1;
          }
          const { vectors, hiddenSize } = await runEncodedBatch(slice);
          outDims = hiddenSize;
          for (let i = 0; i < slice.length; i += 1) {
            out.set(
              vectors.subarray(i * hiddenSize, (i + 1) * hiddenSize),
              slice[i].index * hiddenSize,
            );
          }
        }
        process.send({
          type: "t3-semantic-reply",
          id: message.id,
          ok: true,
          vectors: out,
          dimensions: outDims,
          rssBytes: process.memoryUsage().rss,
        });
      }
    } catch (error) {
      process.send({
        type: "t3-semantic-reply",
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.stack ?? error.message : String(error),
      });
    }
  });
  process.on("disconnect", () => process.kill(process.pid, "SIGKILL"));
`;

type WorkerReply = {
  readonly type: "t3-semantic-reply";
  readonly id: number;
  readonly ok: boolean;
  readonly vectors?: Float32Array;
  readonly dimensions?: number;
  readonly rssBytes?: number;
  readonly error?: string;
};

export async function runNativeSemanticWorker() {
  if (!process.send) throw new Error("Semantic embedding worker requires an IPC channel.");
  const run = new Function("baseUrl", `return (async () => {${loaderEntry}${workerEntry}})();`) as (
    baseUrl: string,
  ) => Promise<void>;
  await run(import.meta.url);
}

function semanticWorkerArgs(): ReadonlyArray<string> {
  if (NodeSea.isSea()) return ["__semantic-embed-worker"];
  const loader = `const baseUrl = ${JSON.stringify(import.meta.url)};${loaderEntry}`;
  return ["--input-type=module", "-e", loader + workerEntry];
}

export interface NativeSemanticWorker {
  readonly embed: (
    texts: ReadonlyArray<string>,
    options?: { readonly microBatchSize?: number },
  ) => Promise<{ readonly vectors: ReadonlyArray<Float32Array>; readonly rssBytes: number }>;
  readonly dispose: () => Promise<void>;
}

export async function spawnNativeSemanticWorker(input: {
  readonly modelPath: string;
  readonly vocabPath: string;
  readonly dimensions?: number;
  readonly maxLength?: number;
  readonly intraOpNumThreads?: number;
  readonly signal?: AbortSignal;
}): Promise<NativeSemanticWorker> {
  input.signal?.throwIfAborted();
  const child = NodeChildProcess.spawn(process.execPath, [...semanticWorkerArgs()], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
    serialization: "advanced",
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "1",
    },
  });

  // Indexing must not take CPU from agent turns; a refused priority change is harmless.
  if (child.pid !== undefined) {
    try {
      NodeOS.setPriority(child.pid, NodeOS.constants.priority.PRIORITY_BELOW_NORMAL);
    } catch {}
  }

  let stopped = false;
  let nextId = 1;
  let pending: {
    readonly id: number;
    readonly resolve: (reply: WorkerReply) => void;
    readonly reject: (error: Error) => void;
  } | null = null;
  const exited = Promise.withResolvers<void>();

  const fail = (error: Error) => {
    stopped = true;
    const current = pending;
    pending = null;
    current?.reject(error);
  };

  child.on("error", (error) => {
    fail(error);
    exited.resolve();
  });
  child.on("exit", (code, exitSignal) => {
    fail(new Error(`Semantic embedding worker exited (${exitSignal ?? code}).`));
    input.signal?.removeEventListener("abort", stop);
    exited.resolve();
  });
  child.on("message", (message: unknown) => {
    if (
      typeof message !== "object" ||
      message === null ||
      !("type" in message) ||
      message.type !== "t3-semantic-reply"
    ) {
      return;
    }
    const reply = message as WorkerReply;
    const current = pending;
    if (current === null || current.id !== reply.id) return;
    pending = null;
    if (reply.ok) current.resolve(reply);
    else current.reject(new Error(reply.error ?? "Semantic embedding worker failed."));
  });

  function stop() {
    fail(new Error("Semantic embedding worker stopped."));
    child.kill("SIGKILL");
  }

  input.signal?.addEventListener("abort", stop, { once: true });
  if (input.signal?.aborted) stop();

  const send = (payload: Record<string, unknown>): Promise<WorkerReply> => {
    if (stopped) return Promise.reject(new Error("Semantic embedding worker stopped."));
    if (pending !== null) return Promise.reject(new Error("Semantic embedding worker is busy."));
    const id = nextId++;
    const deferred = Promise.withResolvers<WorkerReply>();
    pending = { id, resolve: deferred.resolve, reject: deferred.reject };
    child.send({ ...payload, id }, (error) => {
      if (error) {
        if (pending?.id === id) pending = null;
        deferred.reject(error);
      }
    });
    return deferred.promise;
  };

  const dispose = async () => {
    stop();
    await exited.promise;
  };

  try {
    await send({
      kind: "load",
      modelPath: input.modelPath,
      vocabPath: input.vocabPath,
      dimensions: input.dimensions ?? BGE_SMALL_EN_V15_DIMENSIONS,
      maxLength: input.maxLength ?? BGE_SMALL_EN_V15_MAX_LENGTH,
      intraOpNumThreads: input.intraOpNumThreads ?? 2,
    });
  } catch (error) {
    await dispose();
    throw error;
  }

  return {
    embed: async (texts, options) => {
      if (texts.length === 0) return { vectors: [], rssBytes: 0 };
      const reply = await send({
        kind: "embed",
        texts: [...texts],
        microBatchSize: options?.microBatchSize ?? 16,
      });
      if (!(reply.vectors instanceof Float32Array) || typeof reply.dimensions !== "number") {
        throw new Error("Invalid semantic embedding worker response.");
      }
      const dims = reply.dimensions;
      const result: Float32Array[] = [];
      for (let index = 0; index < texts.length; index += 1) {
        const start = index * dims;
        result.push(reply.vectors.slice(start, start + dims));
      }
      return { vectors: result, rssBytes: reply.rssBytes ?? 0 };
    },
    dispose,
  };
}
