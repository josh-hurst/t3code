// @effect-diagnostics globalTimers:off globalDate:off - The tracker runs in atom subscriptions, outside an Effect runtime.
import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";

import { parseThreadKey, threadKey } from "./entities.ts";
import { type AtomCommand, runAtomCommand } from "./runtime.ts";
import { claimThreadOpen } from "./threadSearch.ts";
import type { VisitThreadInput } from "../operations/commands.ts";

const IDLE_TRACKER: Atom.Atom<void> = Atom.make(undefined).pipe(
  Atom.withLabel("thread-visit-tracker:idle"),
);

interface VisitedShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly lastVisitedAt?: string | null | undefined;
  readonly latestRun: { readonly completedAt: string | null } | null;
  /**
   * When a scheduled wake the user is looking at took effect. A wake later
   * than `updatedAt` is an update the server never sent, so leaving records
   * the wake as seen too.
   */
  readonly wokeAt?: string | null | undefined;
}

export interface ThreadVisitTrackerOptions {
  readonly threadShellAtom: (ref: ScopedThreadRef) => Atom.Atom<VisitedShell | null>;
  readonly sessionGenerationAtom: (environmentId: EnvironmentId) => Atom.Atom<number>;
  readonly visit: AtomCommand<
    { readonly environmentId: EnvironmentId; readonly input: VisitThreadInput },
    unknown,
    unknown
  >;
  /**
   * Servers without visit tracking leave `lastVisitedAt` undefined; a client
   * that keeps its own watermark for them records the visit here instead.
   */
  readonly markLocalVisit?: (ref: ScopedThreadRef, visitedAt: string) => void;
}

/** The watermark an open sends: the thread's last visit, so opening alone marks nothing read. */
export function openVisitedAt(shell: Pick<VisitedShell, "updatedAt" | "lastVisitedAt">): string {
  return shell.lastVisitedAt ?? shell.updatedAt;
}

/**
 * Mounting records one open (it feeds search ranking) without marking anything read;
 * leaving marks read what arrived up to then. A reply landing on a screen nobody
 * watches stays unread until the user moves on.
 */
export function createThreadVisitTracker(options: ThreadVisitTrackerOptions) {
  const family = Atom.family((key: string) => {
    const ref = parseThreadKey(key);
    return Atom.make((get) => {
      const registry = get.registry;
      // Showing the thread is the open, whether or not its shell has arrived;
      // the shell only decides when the server hears about it.
      // Recorded even when the server cannot take opens, so recents follow
      // it. A palette pick already sent the open with its query.
      let openPending = claimThreadOpen(ref.environmentId, ref.threadId, Date.now());
      let shell: VisitedShell | null = null;
      // The newest activity shown while here, and what leaving must not send:
      // activity already seen, or kept unread by a mark-unread made while here.
      let seenAt: string | null = null;
      let keepUnreadThroughMs = Number.NaN;
      const sessionGenerationAtom = options.sessionGenerationAtom(ref.environmentId);
      // A failed open waits for a new session, so streaming updates cannot spin on it.
      let openFailedGeneration: number | null = null;
      let active = true;

      const sendVisit = (visitedAt: string, opened: boolean) => {
        const generation = registry.get(sessionGenerationAtom);
        void runAtomCommand(
          registry,
          options.visit,
          {
            environmentId: ref.environmentId,
            input: { threadId: ref.threadId, visitedAt, ...(opened ? { opened: true } : {}) },
          },
          { reportFailure: false },
        ).then((result) => {
          if (!opened || !active || !AsyncResult.isFailure(result)) return;
          openPending = true;
          openFailedGeneration = generation;
          sendPendingOpen();
        });
      };

      // The open rides on the first visit the server hears, however late
      // the shell arrives, so it still counts toward search ranking.
      const sendPendingOpen = () => {
        if (!openPending || shell === null || shell.lastVisitedAt === undefined) return;
        if (openFailedGeneration === registry.get(sessionGenerationAtom)) return;
        openPending = false;
        sendVisit(openVisitedAt(shell), true);
      };

      get.addFinalizer(() => {
        active = false;
        if (shell === null || seenAt === null) return;
        const seenAtMs = Date.parse(seenAt);
        if (seenAtMs <= keepUnreadThroughMs) return;
        if (shell.lastVisitedAt === undefined) {
          options.markLocalVisit?.(ref, seenAt);
          return;
        }
        const lastVisitedAtMs = shell.lastVisitedAt ? Date.parse(shell.lastVisitedAt) : NaN;
        if (!Number.isNaN(lastVisitedAtMs) && lastVisitedAtMs >= seenAtMs) return;
        sendVisit(seenAt, false);
      });

      const onShell = (next: VisitedShell | null) => {
        if (next === null) return;
        const updatedAtMs = Date.parse(next.updatedAt);
        if (Number.isNaN(updatedAtMs)) return;
        const previous = shell;
        shell = next;
        const wokeAtMs = next.wokeAt ? Date.parse(next.wokeAt) : NaN;
        const activityAt = wokeAtMs > updatedAtMs && next.wokeAt ? next.wokeAt : next.updatedAt;
        if (seenAt === null || Date.parse(activityAt) > Date.parse(seenAt)) seenAt = activityAt;

        if (next.lastVisitedAt === undefined) return;
        sendPendingOpen();
        // A watermark that moved back is a mark-unread; leaving keeps it.
        const lastVisitedAtMs = next.lastVisitedAt ? Date.parse(next.lastVisitedAt) : NaN;
        const previousVisitedAtMs = previous?.lastVisitedAt
          ? Date.parse(previous.lastVisitedAt)
          : NaN;
        if (lastVisitedAtMs < previousVisitedAtMs) keepUnreadThroughMs = Date.parse(seenAt);
      };

      // `subscribe`, not `get`: a rebuild would reset the open and the seen
      // watermark, and run the finalizer as if the user had left.
      get.subscribe(options.threadShellAtom(ref), onShell, { immediate: true });
      get.subscribe(sessionGenerationAtom, sendPendingOpen);
    }).pipe(Atom.withLabel(`thread-visit-tracker:${key}`));
  });
  return (ref: ScopedThreadRef | null) => (ref === null ? IDLE_TRACKER : family(threadKey(ref)));
}
