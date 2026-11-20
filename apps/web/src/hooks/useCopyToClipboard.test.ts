import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";

import { writeTextToClipboard } from "./useCopyToClipboard";
import { registerAppWindow } from "../lib/appWindow";

describe("writeTextToClipboard", () => {
  it.each(["main", "detached"] as const)(
    "reserves plain text while copying from the %s window",
    async (source) => {
      const write = vi.fn().mockResolvedValue(undefined);
      vi.stubGlobal("window", {});
      const navigator = { clipboard: { write, writeText: vi.fn() } };
      vi.stubGlobal(
        "navigator",
        source === "main" ? navigator : { clipboard: { writeText: vi.fn() } },
      );
      using _window = {
        [Symbol.dispose]:
          source === "detached"
            ? registerAppWindow({
                closed: false,
                document: { hasFocus: () => true },
                navigator,
              } as unknown as Window)
            : () => {},
      };
      vi.stubGlobal(
        "ClipboardItem",
        class {
          constructor(readonly data: Record<string, Blob>) {}
        },
      );
      await expect(
        writeTextToClipboard("original", undefined, {
          "text/plain": "replacement",
          "text/html": "<b>original</b>",
        }),
      ).resolves.toBe(true);
      const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
      expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
    },
  );
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps caller-built rich HTML when attaching a context fragment", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    const fragment = JSON.stringify({ version: 1, source: {}, records: [] });
    const rich = "<p><strong>Message</strong></p>";

    await expect(
      writeTextToClipboard("Message", undefined, {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-t3-context-fragment=");
  });
});
