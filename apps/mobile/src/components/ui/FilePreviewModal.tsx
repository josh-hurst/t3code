import * as Dialog from "./Dialog";
import { requireNativeModule } from "expo";
import { useEffect, useEffectEvent, useId } from "react";

import type {
  FilePreviewModalProps,
  FilePreviewViewerProps,
  ResolvedFilePreviewDocument,
} from "./FilePreviewModal.types";
import { FilePreviewSession } from "./FilePreviewSession";
import { ImageGalleryPreview } from "./ImageGalleryPreview";

export type {
  FilePreviewItem,
  FilePreviewSource,
  ResolvedFilePreviewSource,
} from "./FilePreviewModal.types";

const NativeControls = requireNativeModule<{
  presentFile(
    uri: string,
    name: string,
    sourceIdentifier: string,
    identifier: string,
  ): Promise<void>;
  dismissFile(identifier: string): Promise<void>;
  isFilePreviewFinished(identifier: string): boolean;
}>("T3NativeControls");

function NativeFilePreview(props: {
  readonly source: ResolvedFilePreviewDocument;
  readonly onRequestClose: () => void;
  readonly onOpenError?: (error: unknown) => void;
  readonly onPresent?: (isFinished: () => boolean) => void;
}) {
  const identifier = useId();
  const { uri, name, sourceIdentifier } = props.source;
  const onRequestClose = useEffectEvent(props.onRequestClose);
  const onPresent = useEffectEvent((isFinished: () => boolean) => props.onPresent?.(isFinished));
  const onOpenError = useEffectEvent((error: unknown) => {
    if (props.onOpenError) props.onOpenError(error);
    else Dialog.alert("Could not open preview", "The file could not be loaded. Please try again.");
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- presents the native file preview and dismisses it on cleanup
  useEffect(() => {
    let canceled = false;
    // Files download first so Quick Look can refuse a format the caller should share instead.
    onPresent(() => NativeControls.isFilePreviewFinished(identifier));
    void NativeControls.presentFile(uri, name ?? "Preview", sourceIdentifier ?? "", identifier)
      .catch((error: unknown) => {
        if (!canceled) onOpenError(error);
      })
      .finally(() => {
        if (!canceled) onRequestClose();
      });
    return () => {
      canceled = true;
      void NativeControls.dismissFile(identifier).catch(() => undefined);
    };
  }, [uri, name, sourceIdentifier, identifier]);

  return null;
}

function IosFilePreview(props: FilePreviewViewerProps) {
  const { source } = props;
  if (source.kind === "image") {
    return <ImageGalleryPreview source={source} onRequestClose={props.onRequestClose} />;
  }
  return <NativeFilePreview {...props} source={source} />;
}

/** Shows PDFs and documents in Quick Look and images in the shared gallery (Android: FilePreviewModal.android.tsx). */
export function FilePreviewModal(props: FilePreviewModalProps) {
  return <FilePreviewSession {...props} Viewer={IosFilePreview} />;
}
