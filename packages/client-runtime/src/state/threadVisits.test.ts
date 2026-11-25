import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import { Atom, AtomRegistry } from "effect/reactivity";
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
  // Visits the server accepted; offline ones fail without reaching it.
  const visits: Array<VisitThreadInput> = [];
  const stays: Array<VisitThreadInput["stay"]> = [];
  let looking = true;
  const lookingListeners = new Set<() => void>();
  const localVisits: Array<string> = [];
  let online = true;
  let pendingResult: Effect.Effect<void, string> | undefined;
  const attempts: Array<VisitThreadInput> = [];
  const sessionGenerationAtom = Atom.make(1);
  const tracker = createThreadVisitTracker({
    threadShellAtom: () => shellAtom,
    sessionGenerationAtom: () => sessionGenerationAtom,
    visit: {
      label: "test-visit",
      run: (_registry, value) =>
        Effect.suspend(() => {
          attempts.push(value.input);
          const pending = pendingResult;
          pendingResult = undefined;
          const { stay, ...watermark } = value.input;
          if (online) visits.push(watermark);
          if (online && stay) stays.push(stay);
          if (pending) return pending;
          if (!online) return Effect.fail("disconnected");
          return Effect.void;
        }),
    },
    markLocalVisit: (_ref, visitedAt) => localVisits.push(visitedAt),
    looking: {
      current: () => looking,
      subscribe: (onChange) => {
        lookingListeners.add(onChange);
        return () => lookingListeners.delete(onChange);
      },
    },
  });
  const registry = AtomRegistry.make();
  return {
    ref,
    visits,
    stays,
    setLooking: (value: boolean) => {
      looking = value;
      for (const listener of lookingListeners) listener();
    },
    localVisits,
    attempts,
    deferNextVisit: () => {
      const deferred = Deferred.makeUnsafe<void, string>();
      pendingResult = Deferred.await(deferred);
      return () => Deferred.doneUnsafe(deferred, Effect.fail("disconnected"));
    },
    reconnect: () => registry.set(sessionGenerationAtom, registry.get(sessionGenerationAtom) + 1),
    mount: () => registry.mount(tracker(ref)),
    /** Leaving: the registry drops the tracker on its next tick. */
    leave: (unmount: () => void) => {
      unmount();
      vi.runOnlyPendingTimers();
    },
    setOnline: (value: boolean) => {
      online = value;
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

it("records the open without marking anything read, holds after a real look, and marks it read on leaving", () => {
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
  vi.advanceTimersByTime(10_000);
  // Time with the window in the background is on screen but not looked at.
  t.setLooking(false);
  vi.advanceTimersByTime(15_000);
  t.setLooking(true);
  expect(t.visits).toHaveLength(1);
  // Fifteen seconds looked at holds the thread, without marking anything read.
  vi.advanceTimersByTime(5_000);
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(0), held: true }]);
  vi.advanceTimersByTime(30_000);
  expect(t.visits).toHaveLength(2);

  t.leave(unmount);
  expect(t.visits.slice(2)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(20), held: true }]);
  expect(t.stays).toEqual([{ forMs: 60_000, lookedMs: 45_000 }]);
});

it("holds nothing after a glance, and leaves the watermark where it was when nothing was new", () => {
  using t = setup("thread-leave-read", {
    updatedAt: at(10),
    lastVisitedAt: at(10),
    latestRun: { completedAt: at(9) },
  });
  const unmount = t.mount();
  vi.advanceTimersByTime(3_000);
  t.leave(unmount);
  expect(t.visits).toEqual([
    { threadId: t.ref.threadId, visitedAt: at(10), opened: true },
    { threadId: t.ref.threadId, visitedAt: at(10) },
  ]);
  expect(t.stays).toEqual([{ forMs: 3_000, lookedMs: 3_000 }]);
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
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(5) }]);

  // An authoritative snapshot can briefly replace the row with an older one.
  unmount = t.mount();
  t.update({ lastVisitedAt: at(2) });
  t.update({ updatedAt: at(5), lastVisitedAt: at(2) });
  t.update({ updatedAt: at(10), lastVisitedAt: at(2) });
  t.update({ updatedAt: at(30) });
  t.leave(unmount);
  expect(t.visits.slice(1)).toEqual([{ threadId: t.ref.threadId, visitedAt: at(30) }]);
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

it("retries a failed open after reconnect", async () => {
  using t = setup("thread-retry-failed", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.setOnline(false);
  t.mount();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.visits).toEqual([]);

  t.setOnline(true);
  t.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(0), opened: true }]);
});

it("keeps a mark-unread when a failed open is retried", async () => {
  using t = setup("thread-accepted-rewound-failure", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  const fail = t.deferNextVisit();
  t.mount();
  t.update({ lastVisitedAt: at(10) });
  t.update({ lastVisitedAt: at(5) });
  fail();
  await vi.advanceTimersByTimeAsync(0);
  t.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(t.attempts).toEqual([
    { threadId: t.ref.threadId, visitedAt: at(0), opened: true },
    { threadId: t.ref.threadId, visitedAt: at(5), opened: true },
  ]);
});

it.each(["unchanged shell", "new shell snapshot"] as const)(
  "retries with %s when reconnect arrives before the pending open fails",
  async (snapshot) => {
    using t = setup(`thread-reconnect-before-failure-${snapshot}`, {
      updatedAt: at(10),
      lastVisitedAt: at(0),
      latestRun: null,
    });
    t.setOnline(false);
    const fail = t.deferNextVisit();
    t.mount();
    t.setOnline(true);
    t.reconnect();
    if (snapshot === "new shell snapshot") t.update({});
    fail();
    await vi.advanceTimersByTimeAsync(0);
    expect(t.visits).toEqual([{ threadId: t.ref.threadId, visitedAt: at(0), opened: true }]);
  },
);

it("retries rejected opens only once per connection generation", async () => {
  using t = setup("thread-rejection-throttle", {
    updatedAt: at(10),
    lastVisitedAt: at(0),
    latestRun: null,
  });
  t.setOnline(false);
  t.mount();
  await vi.advanceTimersByTimeAsync(0);
  for (let second = 1; second < 10; second++) {
    await vi.advanceTimersByTimeAsync(1_000);
    t.update({});
    await vi.advanceTimersByTimeAsync(0);
  }
  const opens = () => t.attempts.filter((attempt) => attempt.opened);
  expect(opens()).toHaveLength(1);
  t.reconnect();
  await vi.advanceTimersByTimeAsync(0);
  expect(opens()).toHaveLength(2);
  t.update({ updatedAt: at(20), latestRun: { completedAt: at(20) } });
  await vi.advanceTimersByTimeAsync(30_000);
  expect(opens()).toHaveLength(2);
});
