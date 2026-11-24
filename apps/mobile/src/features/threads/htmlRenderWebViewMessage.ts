import { readHtmlRenderComposeRequest } from "@t3tools/shared/htmlRender";

export const HTML_RENDER_OVERFLOW_MESSAGE_TYPE = "t3-html-render-overflow";

export type HtmlRenderWebViewMessage =
  | { readonly kind: "overflow"; readonly x: boolean; readonly y: boolean }
  | { readonly kind: "compose"; readonly text: string };

export function readHtmlRenderWebViewMessage(data: string): HtmlRenderWebViewMessage | null {
  let message: unknown;
  try {
    message = JSON.parse(data);
  } catch {
    return null;
  }
  if (
    typeof message === "object" &&
    message !== null &&
    "type" in message &&
    message.type === HTML_RENDER_OVERFLOW_MESSAGE_TYPE &&
    "x" in message &&
    typeof message.x === "boolean" &&
    "y" in message &&
    typeof message.y === "boolean"
  ) {
    return { kind: "overflow", x: message.x, y: message.y };
  }
  const compose = readHtmlRenderComposeRequest(message);
  return compose !== undefined ? { kind: "compose", text: compose.text } : null;
}
