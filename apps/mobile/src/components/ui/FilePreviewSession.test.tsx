import { act, useState } from "react";
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
