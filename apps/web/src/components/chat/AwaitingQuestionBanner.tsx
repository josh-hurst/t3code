import { MessageCircleQuestionIcon } from "lucide-react";

import { Button } from "../ui/button";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

export function awaitingQuestionBannerItem(
  question: string,
  onShow: () => void,
  onDismiss: (() => void) | null,
): ComposerBannerStackItem {
  return {
    id: "awaiting-question",
    variant: "info",
    // The color other "needs you" lines at the end of the timeline use.
    icon: <MessageCircleQuestionIcon className="text-info-foreground" />,
    title: question,
    actions: (
      <Button size="xs" variant="ghost" onClick={onShow}>
        Show
      </Button>
    ),
    ...(onDismiss === null ? {} : { onDismiss, dismissLabel: "Dismiss question" }),
  };
}
