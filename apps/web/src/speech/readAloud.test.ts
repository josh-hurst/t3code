import { describe, expect, it } from "vite-plus/test";

import { pickReadAloudVoice, speakableText, speechChunks } from "./readAloud";

const voice = (name: string, voiceURI: string, lang = "en-US", isDefault = false) => ({
  name,
  voiceURI,
  lang,
  default: isDefault,
});

describe("pickReadAloudVoice", () => {
  it("prefers premium voices in the user's language and never picks novelty voices", () => {
    const voices = [
      voice("Albert", "com.apple.speech.synthesis.voice.Albert", "en-US", true),
      voice("Eddy (English (US))", "com.apple.eloquence.en-US.Eddy"),
      voice("Samantha", "com.apple.voice.compact.en-US.Samantha"),
      voice("Ava (Premium)", "com.apple.voice.premium.en-US.Ava"),
      voice("Anna (Premium)", "com.apple.voice.premium.de-DE.Anna", "de-DE"),
    ];
    expect(pickReadAloudVoice(voices, ["en-US"])?.name).toBe("Ava (Premium)");
    expect(pickReadAloudVoice(voices, ["de-DE", "en-US"])?.name).toBe("Anna (Premium)");
    expect(pickReadAloudVoice(voices.slice(0, 3), ["en-GB"])?.name).toBe("Samantha");
  });
});

describe("speakableText", () => {
  it("reads prose and skips markdown syntax, code blocks, and URLs", () => {
    const markdown = [
      "## Summary",
      "",
      "I fixed **the bug** in [`server.ts:42`](/abs/server.ts:42). See https://example.com/x.",
      "",
      "```ts",
      "const x = 1;",
      "```",
      "",
      "- First *item*",
      "1. snake_case_name stays",
      "",
      "| File | Change |",
      "| --- | --- |",
      "| a.ts | added |",
    ].join("\n");
    expect(speakableText(markdown)).toBe(
      [
        "Summary",
        "",
        "I fixed the bug in server.ts:42. See",
        "",
        "First item",
        "snake_case_name stays",
        "",
        "File, Change",
        "a.ts, added",
      ].join("\n"),
    );
  });
});

describe("speechChunks", () => {
  it("splits long paragraphs at sentence boundaries", () => {
    const sentence = "This sentence is about fifty characters long, ok. ";
    const chunks = speechChunks(`${sentence.repeat(10)}\n\nShort tail.`);
    expect(chunks.length).toBe(4);
    expect(chunks.every((chunk) => chunk.length <= 220)).toBe(true);
    expect(chunks.at(-1)).toBe("Short tail.");
  });
});
