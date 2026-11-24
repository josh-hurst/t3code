import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyHtmlRenderComposeToComposer,
  readActivatedHtmlRenderCompose,
} from "./htmlRenderCompose.logic";

describe("readActivatedHtmlRenderCompose", () => {
  const validMessage = {
    jsonrpc: "2.0",
    method: "t3/notifications/compose",
    params: { text: "  [pick] Shop.Buy — too close  " },
  };

  it("requires both frame focus and active user activation", () => {
    expect(
      readActivatedHtmlRenderCompose({
        data: validMessage,
        frameFocused: true,
        userActivationActive: true,
      }),
    ).toBe("[pick] Shop.Buy — too close");
    expect(
      readActivatedHtmlRenderCompose({
        data: validMessage,
        frameFocused: false,
        userActivationActive: true,
      }),
    ).toBeUndefined();
    expect(
      readActivatedHtmlRenderCompose({
        data: validMessage,
        frameFocused: true,
        userActivationActive: false,
      }),
    ).toBeUndefined();
    expect(
      readActivatedHtmlRenderCompose({
        data: { jsonrpc: "2.0", method: "t3/notifications/compose", params: { text: "   " } },
        frameFocused: true,
        userActivationActive: true,
      }),
    ).toBeUndefined();
  });
});

describe("applyHtmlRenderComposeToComposer", () => {
  it("appends on a new line when non-empty and focuses the composer", () => {
    let prompt = "";
    const scheduleFocus = vi.fn();
    const composer = {
      getSendContext: () => ({ answeringPendingUserInput: false, prompt }),
      insertTextAtEnd: vi.fn((addition: string) => {
        prompt += addition;
        return true;
      }),
    };

    expect(
      applyHtmlRenderComposeToComposer({ composer, text: "[pick] First", scheduleFocus }),
    ).toBe(true);
    expect(prompt).toBe("[pick] First");

    expect(
      applyHtmlRenderComposeToComposer({ composer, text: "[pick] Second", scheduleFocus }),
    ).toBe(true);
    expect(prompt).toBe("[pick] First\n[pick] Second");
    expect(scheduleFocus).toHaveBeenCalledTimes(2);
  });

  it("skips when answering a pending question, missing a composer, or insert is refused", () => {
    const scheduleFocus = vi.fn();
    expect(
      applyHtmlRenderComposeToComposer({ composer: null, text: "[pick] A", scheduleFocus }),
    ).toBe(false);

    const insertTextAtEnd = vi.fn(() => true);
    expect(
      applyHtmlRenderComposeToComposer({
        composer: {
          getSendContext: () => ({ answeringPendingUserInput: true, prompt: "" }),
          insertTextAtEnd,
        },
        text: "[pick] A",
        scheduleFocus,
      }),
    ).toBe(false);
    expect(insertTextAtEnd).not.toHaveBeenCalled();

    expect(
      applyHtmlRenderComposeToComposer({
        composer: {
          getSendContext: () => ({ answeringPendingUserInput: false, prompt: "" }),
          insertTextAtEnd: () => false,
        },
        text: "[pick] A",
        scheduleFocus,
      }),
    ).toBe(false);
    expect(scheduleFocus).not.toHaveBeenCalled();
  });
});
