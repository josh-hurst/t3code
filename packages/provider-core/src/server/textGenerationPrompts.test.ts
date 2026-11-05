import { describe, expect, it } from "vite-plus/test";

import { buildThreadTitlePrompt } from "./textGenerationPrompts.ts";
import { normalizeCliError } from "./textGenerationUtils.ts";

describe("normalizeCliError", () => {
  it("does not expose CLI failure details in the public error message", () => {
    const result = normalizeCliError(
      "codex",
      "generateCommitMessage",
      new Error("request failed with access_token=secret-token"),
      "Failed to generate a commit message",
    );

    expect(result.detail).toBe("Failed to generate a commit message");
    expect(result.message).not.toContain("secret-token");
  });
});

describe("buildThreadTitlePrompt", () => {
  it("names the thread's project so memories about other projects don't leak into titles", () => {
    const { prompt } = buildThreadTitlePrompt({
      message: "The coaster gamepass prompt fires twice",
      projectName: " theme-park ",
    });
    expect(prompt).toContain('This thread belongs to the project "theme-park".');
    expect(buildThreadTitlePrompt({ message: "Fix it", projectName: "  " }).prompt).not.toContain(
      "belongs to the project",
    );
  });
});
