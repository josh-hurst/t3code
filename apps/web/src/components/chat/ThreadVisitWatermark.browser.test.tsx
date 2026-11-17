import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../../rpc/atomRegistry";

const mocks = vi.hoisted(() => ({
  visitRun: vi.fn(),
}));

const shellKey = (ref: ScopedThreadRef) => `${ref.environmentId}:${ref.threadId}`;

vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    environmentThreadShells: {
      ...actual.environmentThreadShells,
      threadShellAtom: ((ref: ScopedThreadRef) => shellAtom(shellKey(ref))) as never,
    },
    threadEnvironment: {
      ...actual.threadEnvironment,
      visit: { label: "visit", run: mocks.visitRun } as never,
    },
  };
});

import { ThreadVisitWatermark } from "./ThreadVisitWatermark";

// Kept alive so a shell set before its tracker mounts is still there when it does.
const shellAtom = Atom.family((_key: string) => Atom.make<unknown>(null).pipe(Atom.keepAlive));

const ENVIRONMENT = EnvironmentId.make("environment-visit-watermark");
const threadA: ScopedThreadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("a") };
const threadB: ScopedThreadRef = { environmentId: ENVIRONMENT, threadId: ThreadId.make("b") };

function setShell(ref: ScopedThreadRef, updatedAt: string) {
  appAtomRegistry.set(shellAtom(shellKey(ref)), {
    environmentId: ref.environmentId,
    id: ref.threadId,
    updatedAt,
    lastVisitedAt: "2026-01-01T00:00:00.000Z",
    latestRun: null,
  });
}

function visits() {
  return mocks.visitRun.mock.calls.map(([, value]) => (value as { input: unknown }).input);
}

it("marks the thread read when you switch away, not when it opens", async () => {
  mocks.visitRun.mockReset();
  mocks.visitRun.mockResolvedValue(AsyncResult.success(undefined));
  setShell(threadA, "2026-01-02T00:00:00.000Z");
  setShell(threadB, "2026-01-03T00:00:00.000Z");

  await using screen = await render(
    <AppAtomRegistryProvider>
      <ThreadVisitWatermark threadRef={threadA} />
    </AppAtomRegistryProvider>,
  );
  expect(visits()).toEqual([
    { threadId: threadA.threadId, visitedAt: "2026-01-01T00:00:00.000Z", opened: true },
  ]);

  await screen.rerender(
    <AppAtomRegistryProvider>
      <ThreadVisitWatermark threadRef={threadB} />
    </AppAtomRegistryProvider>,
  );
  await vi.waitFor(() =>
    expect(visits()).toContainEqual({
      threadId: threadA.threadId,
      visitedAt: "2026-01-02T00:00:00.000Z",
    }),
  );
  expect(visits()).not.toContainEqual(
    expect.objectContaining({ threadId: threadB.threadId, visitedAt: "2026-01-03T00:00:00.000Z" }),
  );
});
