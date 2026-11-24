import { useGT } from "gt-react";
import { ArchiveIcon } from "lucide-react";

import { Button } from "./ui/button";

/** Archive action for a project row in a picker, shown only on the highlighted row. */
export function ProjectArchiveButton(props: {
  readonly name: string;
  readonly onArchive: () => void;
}) {
  const gt = useGT();
  return (
    <span className="flex opacity-0 in-data-highlighted:opacity-100 pointer-coarse:opacity-100">
      <Button
        size="icon-xs"
        variant="ghost-muted"
        tabIndex={-1}
        aria-hidden="true"
        title={gt("Archive {name}", { name: props.name })}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.preventDefault()}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          props.onArchive();
        }}
      >
        <ArchiveIcon className="size-3.5" />
      </Button>
    </span>
  );
}
