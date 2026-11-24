import {
  rankNewThreadProjectEntries,
  type SidebarProjectPickerEntry,
} from "../sidebarProjectGrouping";
import { useQuietThreadShells } from "../state/entities";
import { useClientSettings } from "./useSettings";

export function useRankedNewThreadProjectEntries(
  entries: ReadonlyArray<SidebarProjectPickerEntry>,
): SidebarProjectPickerEntry[] {
  const threads = useQuietThreadShells();
  const recentThreadCount = useClientSettings((s) => s.newThreadProjectRankingThreads);
  return rankNewThreadProjectEntries(entries, threads, recentThreadCount);
}
