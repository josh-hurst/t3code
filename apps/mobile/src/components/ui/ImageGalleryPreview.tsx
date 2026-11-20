import { useGT } from "gt-react-native";
import { createContext, useContext } from "react";
import { Platform, View } from "react-native";
import ImageViewing from "react-native-image-viewing";
import { SafeAreaView } from "react-native-safe-area-context";

import { useMediaActions } from "../../state/mediaActions";
import { MediaPreviewHeader } from "../MediaPreviewHeader";
import type { FilePreviewImages } from "./FilePreviewModal.types";

type ImageGalleryPreviewProps = {
  readonly source: FilePreviewImages;
  readonly onRequestClose: () => void;
};

const ImageGalleryPreviewContext = createContext<ImageGalleryPreviewProps | null>(null);

function ImageGalleryPreviewHeader(header: { readonly imageIndex: number }) {
  const props = useContext(ImageGalleryPreviewContext)!;
  const source = props.source.images[header.imageIndex];
  const gt = useGT();
  const mediaActions = useMediaActions(source?.actionsSource, props.onRequestClose);
  return (
    <View className="bg-black/70">
      {/* Measures itself: the screen underneath reports insets that include its own header. */}
      <SafeAreaView edges={["top"]}>
        <MediaPreviewHeader
          title={source?.name ?? gt("Image")}
          media={mediaActions}
          closeAccessibilityLabel={gt("Close image")}
          onClose={props.onRequestClose}
        />
      </SafeAreaView>
    </View>
  );
}

/** Pages through a gallery full screen. Quick Look's swipe-down dismissal is broken on iOS 27. */
export function ImageGalleryPreview(props: ImageGalleryPreviewProps) {
  const { source } = props;
  const viewer = (
    <ImageViewing
      images={source.images.map((image) => (image.uri ? { uri: image.uri } : {}))}
      keyExtractor={(_, index) => source.images[index]?.uri ?? `pending:${index}`}
      // Stays fixed: react-native-image-viewing remounts the Modal and replays its fade when it changes.
      imageIndex={source.selectedIndex}
      visible
      presentationStyle="fullScreen"
      onRequestClose={props.onRequestClose}
      // On Android the swipe responder swallows pinch-to-zoom.
      swipeToCloseEnabled={Platform.OS === "ios"}
      doubleTapToZoomEnabled
      {...(source.images[source.selectedIndex]?.actionsSource
        ? { HeaderComponent: ImageGalleryPreviewHeader }
        : {})}
    />
  );
  return <ImageGalleryPreviewContext value={props}>{viewer}</ImageGalleryPreviewContext>;
}
