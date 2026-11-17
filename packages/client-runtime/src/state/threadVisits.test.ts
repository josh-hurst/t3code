import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import type { VisitThreadInput } from "../operations/commands.ts";
import { claimThreadOpen } from "./threadSearch.ts";
import { createThreadVisitTracker } from "./threadVisits.ts";

const environmentId = EnvironmentId.make("env-visits");

interface Shell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly updatedAt: string;
  readonly lastVisitedAt?: string | null;
  readonly latestRun: { readonly completedAt: string | null } | null;
  readonly wokeAt?: string | null;
}

function at(seconds: number) {
  return `2026-01-01T00:00:${String(seconds).padStart(2, "0")}.000Z`;
}

// claimThreadOpen dedupes per thread in module state, so each test opens its own thread.
function setup(threadName: string, initial: Omit<Shell, "environmentId" | "id"> | null) {
  vi.useFakeTimers({ now: Date.UTC(2026, 0, 1) });
  const threadId = ThreadId.make(threadName);
  const ref = { environmentId, threadId };
  const shellAtom = Atom.make<Shell | null>(
    initial === null ? null : { environmentId, id: threadId, ...initial },
  );
  const visits: Array<VisitThreadInput> = [];
  const localVisits: Array<string> = [];
  const tracker = createThreadVisitTracker({
    threadShellAtom: () => shellAtom,
    visit: {
      label: "test-visit",
      run: async (_registry, value) => {
        visits.push(value.input);
        return AsyncResult.success(undefined);
      },
    },
    markLocalVisit: (_ref, visitedAt) => localVisits.push(visitedAt),
  });
  const registry = AtomRegistry.make();
  return {
    ref,
    visits,
    localVisits,
    mount: () => registry.mount(tracker(ref)),
    /** Leaving: the registry drops the tracker on its next tick. */
    leave: (unmount: () => void) => {
      unmount();
      vi.runOnlyPendingTimers();
    },
    update: (patch: Partial<Shell>) => {
      const current = registry.get(shellAtom);
      registry.set(shellAtom, {
        environmentId,
        id: threadId,
        updatedAt: at(0),
        latestRun: null,
        ...current,
        ...patch,
      });
    },
    [Symbol.dispose]: () => vi.useRealTimers(),
  };
}

it("records the open without marking anything read, and marks it read on leaving", () => {
  using t = setup("thread-leave", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: { completedAt: at(9) },
  });
  const unmount = t.mount();
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(0), opened: true }]);

  // A reply landing while the thread is shown stays unread until the user moves on.
  t.update({ updatedAt: at(11) });
  t.update({ updatedAt: at(20), latestRun: { completedAt: at(20) } });
  vi.advanceTimersByTime(60_000);
  expect(t.visits).toHaveLength(1);

  t.leave(unmount);
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(20) }]);
});

it("sends nothing on leaving a thread that had nothing new", () => {
  using t = setup("thread-leave-read", {
    updatedAt: at(10),
    lastVisitedAt: at(10),
    latestRun: { completedAt: at(9) },
  });
  t.leave(t.mount());
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10), opened: true }]);
});

it("does not resend the open a palette pick already sent", () => {
  using t = setup("thread-palette", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1));
  t.leave(t.mount());
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10) }]);
});

it("keeps a mark-unread made on the open thread until new activity lands", () => {
  using t = setup("thread-unread", { updatedAt: at(10), lastVisitedAt: at(10), latestRun: null });
  claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1));
  let unmount = t.mount();
  t.update({ lastVisitedAt: at(5) });
  t.leave(unmount);
  expect(t.visits).toEqual([]);

  // An authoritative snapshot can briefly replace the row with an older one.
  unmount = t.mount();
  t.update({ lastVisitedAt: at(2) });
  t.update({ updatedAt: at(5), lastVisitedAt: at(2) });
  t.update({ updatedAt: at(10), lastVisitedAt: at(2) });
  t.update({ updatedAt: at(30) });
  t.leave(unmount);
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(30) }]);
});

it("waits for the shell and records local visits for servers without tracking", () => {
  using t = setup("thread-local", null);
  const unmount = t.mount();
  t.update({ updatedAt: at(10), latestRun: null });
  t.update({ updatedAt: at(11) });
  expect(t.localVisits).toEqual([]);
  t.leave(unmount);
  expect(t.visits).toEqual([]);
  expect(t.localVisits).toEqual([at(11)]);
});

it("sends the open when the shell arrives after the thread is shown", () => {
  using t = setup("thread-shell-missing", null);
  const unmount = t.mount();
  expect(claimThreadOpen(environmentId, t.ref.threadId, Date.UTC(2026, 0, 1))).toBe(false);
  expect(t.visits).toEqual([]);

  t.update({ updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(0), opened: true }]);
  t.leave(unmount);
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(10) }]);
});

it("marks a wake seen on leaving", () => {
  using t = setup("thread-wake", { updatedAt: at(10), lastVisitedAt: at(0), latestRun: null });
  const unmount = t.mount();
  t.update({ wokeAt: at(15) });
  expect(t.visits).toHaveLength(1);
  t.leave(unmount);
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(15) }]);
});
