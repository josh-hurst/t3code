import type { PinnedHuggingFaceFile } from "../modelStore.ts";

// MIT-licensed BAAI/bge-small-en-v1.5 quantized ONNX export (Xenova/bge-small-en-v1.5).
const BGE_SMALL_EN_V15_REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
export const BGE_SMALL_EN_V15_MODEL_ID = `Xenova/bge-small-en-v1.5@${BGE_SMALL_EN_V15_REVISION}:q8`;
export const BGE_SMALL_EN_V15_DIMENSIONS = 384;
export const BGE_SMALL_EN_V15_MAX_LENGTH = 512;
export const BGE_SMALL_EN_V15_QUERY_PREFIX =
  "Represent this sentence for searching relevant passages: ";

export const BGE_SMALL_EN_V15_ONNX: PinnedHuggingFaceFile = {
  id: "Xenova/bge-small-en-v1.5",
  revision: BGE_SMALL_EN_V15_REVISION,
  filename: "onnx/model_quantized.onnx",
  size: 34_014_426,
  sha256: "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
};

export const BGE_SMALL_EN_V15_VOCAB: PinnedHuggingFaceFile = {
  id: "Xenova/bge-small-en-v1.5",
  revision: BGE_SMALL_EN_V15_REVISION,
  filename: "vocab.txt",
  size: 231_508,
  sha256: "07eced375cec144d27c900241f3e339478dec958f92fddbc551f295c992038a3",
};

// Matches the prebuilt N-API binaries bundled in onnxruntime-node@1.31.1.
const SUPPORTED_PLATFORMS = new Set([
  "darwin-arm64",
  "linux-x64",
  "linux-arm64",
  "win32-x64",
  "win32-arm64",
]);

export function isSemanticSearchPlatformSupported(
  platform: string,
  architecture: string,
  libc: "gnu" | "musl" | undefined,
): boolean {
  return (
    (platform !== "linux" || libc === "gnu") &&
    SUPPORTED_PLATFORMS.has(`${platform}-${architecture}`)
  );
}
