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

/** Whether the user can see the app right now: a focused window, or an app in the foreground. */
export interface ThreadVisitLooking {
  readonly current: () => boolean;
  readonly subscribe: (onChange: () => void) => () => void;
}

/** Looking at a thread this long holds it from settling early; less is a glance. */
const THREAD_HELD_AFTER_LOOKED_MS = 15_000;

const ALWAYS_LOOKING: ThreadVisitLooking = { current: () => true, subscribe: () => () => {} };

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
  /** Without it, the whole stay counts as looked at. */
  readonly looking?: ThreadVisitLooking;
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
      // Time looked at decides whether the visit holds the thread from settling early:
      // a glance or a misclick does not. The server also logs each stay on leaving.
      const looking = options.looking ?? ALWAYS_LOOKING;
      const shownAtMs = Date.now();
      let lookedMs = 0;
      let lookingSinceMs: number | null = looking.current() ? shownAtMs : null;
      const lookedUntil = (nowMs: number) =>
        lookedMs + (lookingSinceMs === null ? 0 : nowMs - lookingSinceMs);
      const stayUntil = (nowMs: number): NonNullable<VisitThreadInput["stay"]> => ({
        forMs: Math.max(0, Math.round(nowMs - shownAtMs)),
        lookedMs: Math.max(0, Math.round(lookedUntil(nowMs))),
      });
      // Pending once looked at long enough; sent with the first visit the server can take.
      let heldPending = false;
      let heldSent = false;
      let heldTimer: ReturnType<typeof setTimeout> | undefined;

      const sendVisit = (
        visitedAt: string,
        extra: {
          readonly opened?: boolean;
          readonly held?: boolean;
          readonly stay?: NonNullable<VisitThreadInput["stay"]>;
        } = {},
      ) => {
        const generation = registry.get(sessionGenerationAtom);
        void runAtomCommand(
          registry,
          options.visit,
          {
            environmentId: ref.environmentId,
            input: {
              threadId: ref.threadId,
              visitedAt,
              ...(extra.opened ? { opened: true } : {}),
              ...(extra.held ? { held: true } : {}),
              ...(extra.stay ? { stay: extra.stay } : {}),
            },
          },
          { reportFailure: false },
        ).then((result) => {
          if (!extra.opened || !active || !AsyncResult.isFailure(result)) return;
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
        sendVisit(openVisitedAt(shell), { opened: true });
      };

      // A failed hold is not retried: leaving after a long enough look holds the thread again.
      const sendPendingHeld = () => {
        if (!heldPending || shell === null || shell.lastVisitedAt === undefined) return;
        heldPending = false;
        heldSent = true;
        sendVisit(openVisitedAt(shell), { held: true });
      };

      const armHeld = () => {
        clearTimeout(heldTimer);
        heldTimer = undefined;
        if (heldPending || heldSent || lookingSinceMs === null) return;
        heldTimer = setTimeout(
          () => {
            heldPending = true;
            sendPendingHeld();
          },
          Math.max(0, THREAD_HELD_AFTER_LOOKED_MS - lookedUntil(Date.now())),
        );
      };
      armHeld();
      const stopLooking = looking.subscribe(() => {
        const nowMs = Date.now();
        if (!looking.current()) {
          if (lookingSinceMs !== null) lookedMs += nowMs - lookingSinceMs;
          lookingSinceMs = null;
        } else if (lookingSinceMs === null) {
          lookingSinceMs = nowMs;
        }
        armHeld();
      });

      get.addFinalizer(() => {
        active = false;
        stopLooking();
        clearTimeout(heldTimer);
        if (shell === null) return;
        const seenAtMs = seenAt === null ? NaN : Date.parse(seenAt);
        // Activity seen while here, unless a mark-unread made here keeps it unread.
        const seen = seenAt !== null && !(seenAtMs <= keepUnreadThroughMs) ? seenAt : null;
        if (shell.lastVisitedAt === undefined) {
          if (seen !== null) options.markLocalVisit?.(ref, seen);
          return;
        }
        const lastVisitedAtMs = shell.lastVisitedAt ? Date.parse(shell.lastVisitedAt) : NaN;
        const marksRead = seen !== null && !(lastVisitedAtMs >= seenAtMs);
        // The stay always goes; a watermark that does not move forward changes no read state.
        // A long enough look holds the thread from when the user left, not when they arrived.
        const stay = stayUntil(Date.now());
        sendVisit(marksRead ? seen : openVisitedAt(shell), {
          stay,
          held: stay.lookedMs >= THREAD_HELD_AFTER_LOOKED_MS,
        });
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
        sendPendingHeld();
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
