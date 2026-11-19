import { act, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";
import {
  AssetWorkspaceAssetNotFoundError,
  EnvironmentId,
  SOURCE_CONTROL_MEDIA_ASSET,
  ThreadId,
} from "@t3tools/contracts";

const harness = vi.hoisted(() => ({
  refreshAssetUrl:
    vi.fn<(environmentId: string, resource: { url: string }) => Promise<string | null>>(),
  alert: vi.fn(),
  previews: [] as unknown[],
  mounts: 0,
  presentationFinished: false,
}));

vi.mock("../../state/assets", () => ({ refreshAssetUrl: harness.refreshAssetUrl }));
vi.mock("../../lib/localAttachmentPreview", () => ({ loadLocalAttachmentPreview: vi.fn() }));
vi.mock("../../lib/attachmentDownload", () => ({
  downloadAndShareAttachment: vi.fn(),
  nativeViewerErrorMessage: () => "",
  shareLocalAttachment: vi.fn(),
}));
vi.mock("../../lib/previewPresentation", () => ({ usePreviewPresentation: () => {} }));
vi.mock("./Dialog", () => ({ alert: harness.alert }));

import type { FilePreviewItem, FilePreviewViewerProps } from "./FilePreviewModal.types";
import { FilePreviewSession } from "./FilePreviewSession";

function Viewer(props: FilePreviewViewerProps) {
  useState(() => harness.mounts++);
  harness.previews.push(props.source);
  const { onPresent } = props;
  // Stands in for the native presentation starting.
  useEffect(() => onPresent?.(() => harness.presentationFinished), [onPresent]);
  return null;
}

const environmentId = EnvironmentId.make("environment");
const image = (url: string): FilePreviewItem => ({
  kind: "image",
  environmentId,
  resource: { _tag: SOURCE_CONTROL_MEDIA_ASSET, cwd: "/repo", url },
});

async function openGallery(selected: FilePreviewItem, gallery: readonly FilePreviewItem[]) {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.previews.length = 0;
  harness.mounts = 0;
  harness.alert.mockClear();
  const root = createRoot(document.createElement("div"));
  const onRequestClose = vi.fn();
  await act(async () =>
    root.render(
      <FilePreviewSession
        source={{ ...selected, gallery }}
        onRequestClose={onRequestClose}
        Viewer={Viewer}
      />,
    ),
  );
  return { onRequestClose, [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
}

it("opens once every image has resolved", async () => {
  const slow = Promise.withResolvers<string>();
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) =>
    resource.url.endsWith("slow.png") ? slow.promise : "https://signed.test/a.png",
  );
  const selected = image("https://github.com/a.png");
  await using _preview = await openGallery(selected, [
    image("https://github.com/slow.png"),
    selected,
  ]);

  expect(harness.previews).toEqual([]);
  await act(async () => slow.resolve("https://signed.test/slow.png"));
  expect(harness.previews.at(-1)).toMatchObject({
    selectedIndex: 1,
    images: [{ uri: "https://signed.test/slow.png" }, { uri: "https://signed.test/a.png" }],
  });
  expect(harness.mounts).toBe(1);
});

it("leaves out a sibling that cannot be resolved", async () => {
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/a.png");
  await using preview = await openGallery(selected, [
    image("https://github.com/missing.png"),
    selected,
    image("https://github.com/c.png"),
  ]);

  expect(preview.onRequestClose).not.toHaveBeenCalled();
  expect(harness.alert).not.toHaveBeenCalled();
  expect(harness.previews.at(-1)).toMatchObject({
    selectedIndex: 0,
    images: [{ uri: "https://signed.test/a.png" }, { uri: "https://signed.test/c.png" }],
  });
});

it("closes the preview when the selected image cannot be resolved", async () => {
  harness.refreshAssetUrl.mockImplementation(async (_environmentId, resource) => {
    if (resource.url.endsWith("missing.png")) throw new Error("not found");
    return `https://signed.test/${resource.url.split("/").pop()}`;
  });
  const selected = image("https://github.com/missing.png");
  await using preview = await openGallery(selected, [image("https://github.com/a.png"), selected]);

  expect(preview.onRequestClose).toHaveBeenCalledOnce();
  expect(harness.alert).toHaveBeenCalledOnce();
});

it("names the checked path when the server cannot find the file", async () => {
  const resource = {
    _tag: "media-file" as const,
    threadId: ThreadId.make("thread"),
    path: "v2/extended/duo-color-3-extended-FINAL.png",
  };
  const checkedPath = "/repo/v2/extended/duo-color-3-extended-FINAL.png";
  harness.refreshAssetUrl.mockRejectedValue(
    new AssetWorkspaceAssetNotFoundError({ resource, checkedPath }),
  );
  const selected: FilePreviewItem = { kind: "image", environmentId, resource };
  await using preview = await openGallery(selected, [selected]);

  expect(preview.onRequestClose).toHaveBeenCalledOnce();
  expect(harness.alert).toHaveBeenCalledWith(
    "Could not open preview",
    expect.stringContaining(checkedPath),
  );
  expect(harness.alert.mock.calls[0]?.[1]).not.toMatch(/reconnect/i);
});

it.each([
  // Handed to native but not yet started there, or still on screen.
  ["image", false, 1],
  ["image", true, 2],
  // A PDF is still resolving here, so its viewer never presented and a re-render must not restart it.
  ["pdf", true, 1],
] as const)(
  "a re-tap of the open %s restarts the preview only once its native viewer closed (closed: %s)",
  async (kind, finished, starts) => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    harness.presentationFinished = finished;
    harness.mounts = 0;
    harness.refreshAssetUrl.mockReset();
    if (kind === "image") harness.refreshAssetUrl.mockResolvedValue("https://signed.test/a.png");
    else harness.refreshAssetUrl.mockReturnValue(new Promise(() => {}));
    const selected: FilePreviewItem = { ...image("https://github.com/a.png"), kind };
    const root = createRoot(document.createElement("div"));
    await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
    const render = () =>
      act(async () =>
        root.render(
          <FilePreviewSession
            source={{ ...selected, gallery: [selected] }}
            onRequestClose={() => {}}
            Viewer={Viewer}
          />,
        ),
      );
    await render();
    await render();
    expect(harness.refreshAssetUrl).toHaveBeenCalledTimes(starts);
  },
);

it("does not carry a presented viewer over to a different item that is still resolving", async () => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  harness.presentationFinished = true;
  harness.refreshAssetUrl.mockReset();
  harness.refreshAssetUrl.mockImplementation((_environmentId, resource) =>
    resource.url.endsWith("a.png")
      ? Promise.resolve("https://signed.test/a.png")
      : new Promise(() => {}),
  );
  const shown = image("https://github.com/a.png");
  const resolving: FilePreviewItem = { ...image("https://github.com/b.pdf"), kind: "pdf" };
  const root = createRoot(document.createElement("div"));
  await using _root = { [Symbol.asyncDispose]: () => act(async () => root.unmount()) };
  const render = (item: FilePreviewItem) =>
    act(async () =>
      root.render(
        <FilePreviewSession
          source={{ ...item, gallery: [item] }}
          onRequestClose={() => {}}
          Viewer={Viewer}
        />,
      ),
    );
  await render(shown);
  await render(resolving);
  await render(resolving);
  expect(
    harness.refreshAssetUrl.mock.calls.filter(([, r]) => r.url.endsWith("b.pdf")),
  ).toHaveLength(1);
});
