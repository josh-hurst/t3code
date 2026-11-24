import { describe, expect, it } from "vite-plus/test";

import {
  HTML_RENDER_OVERFLOW_MESSAGE_TYPE,
  readHtmlRenderWebViewMessage,
} from "./htmlRenderWebViewMessage";

describe("readHtmlRenderWebViewMessage", () => {
  it("decodes overflow reports and compose notifications from WebView payloads", () => {
    expect(
      readHtmlRenderWebViewMessage(
        JSON.stringify({ type: HTML_RENDER_OVERFLOW_MESSAGE_TYPE, x: true, y: false }),
      ),
    ).toEqual({ kind: "overflow", x: true, y: false });
    expect(
      readHtmlRenderWebViewMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "t3/notifications/compose",
          params: { text: "  [pick] Shop.Buy — too close to the edge  " },
        }),
      ),
    ).toEqual({ kind: "compose", text: "[pick] Shop.Buy — too close to the edge" });
    expect(readHtmlRenderWebViewMessage("not-json")).toBeNull();
    expect(
      readHtmlRenderWebViewMessage(
        JSON.stringify({
          jsonrpc: "2.0",
          method: "t3/notifications/compose",
          params: { text: "   " },
        }),
      ),
    ).toBeNull();
    expect(readHtmlRenderWebViewMessage(JSON.stringify({ type: "other" }))).toBeNull();
  });
});
