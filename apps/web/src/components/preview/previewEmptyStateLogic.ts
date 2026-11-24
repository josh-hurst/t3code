import type { ProjectScript } from "@t3tools/contracts";
import { runnableProjectScripts } from "@t3tools/shared/projectScripts";

export function getConfiguredPreviewUrls(
  scripts: ReadonlyArray<ProjectScript> | undefined,
): ReadonlyArray<string> {
  return (
    (scripts ? runnableProjectScripts(scripts) : []).flatMap((script) =>
      script.previewUrl ? [script.previewUrl] : [],
    ) ?? []
  );
}
