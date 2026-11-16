import { useNavigate } from "@tanstack/react-router";

import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** Opens the History page beside the History section's label, which still toggles the section. */
export function SidebarHistoryAllButton(props: { shortcutLabel: string | null }) {
  const navigate = useNavigate();
  const label = props.shortcutLabel
    ? `Every topic from every thread (${props.shortcutLabel})`
    : "Every topic from every thread";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="micro"
            variant="ghost-muted"
            className="me-1 shrink-0"
            data-testid="sidebar-history-all"
            aria-label="Open History: every topic from every thread"
            onClick={() => void navigate({ to: "/history" })}
          />
        }
      >
        All
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}
