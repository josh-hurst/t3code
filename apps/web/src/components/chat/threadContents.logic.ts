import type { ThreadEntry } from "@t3tools/contracts";

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The Contents heading's count: "4 topics · 1 open", where open counts topics still owing. */
export function contentsCount(
  entries: ReadonlyArray<{ readonly open: ReadonlyArray<unknown> }>,
): string {
  const open = entries.filter((entry) => entry.open.length > 0).length;
  return open === 0
    ? plural(entries.length, "topic")
    : `${plural(entries.length, "topic")} · ${open} open`;
}

/**
 * Why "Split this thread into topics" would do nothing, or null when it can run. The server
 * accepts the request either way and quietly skips it, so the palette says why instead.
 */
export function splitTopicsBlocker(input: {
  readonly summariesEnabled: boolean;
  readonly entries: ReadonlyArray<Pick<ThreadEntry, "runs">> | null;
}): string | null {
  if (!input.summariesEnabled) {
    return "Topics come from reply summaries, which are off for this server. Turn on Settings → Threads → Text generation → Summarize latest reply.";
  }
  if (input.entries === null || input.entries.length === 0) {
    return "This thread has no topics yet.";
  }
  const runs = new Set(input.entries.flatMap((entry) => entry.runs.map((run) => run.runId)));
  if (runs.size < 2) {
    return "A thread needs at least two summarized replies before it can be split.";
  }
  return null;
}
