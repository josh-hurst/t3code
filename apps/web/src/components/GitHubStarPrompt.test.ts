import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import type { toastManager } from "./ui/toast";

const { add, update, openExternal, runAtomCommand } = vi.hoisted(() => ({
  add: vi.fn<typeof toastManager.add>(),
  update: vi.fn<typeof toastManager.update>(),
  openExternal: vi.fn(async (_url: string) => {}),
  runAtomCommand: vi.fn(async () => ({ _tag: "Success" as const, value: false })),
}));
vi.mock("./ui/toast", () => ({ toastManager: { add, update, close: vi.fn() } }));
vi.mock("../localApi", () => ({ readLocalApi: () => ({ shell: { openExternal } }) }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/sourceControl", () => ({
  sourceControlEnvironment: { checkStarred: {}, star: {} },
}));
vi.mock("@t3tools/client-runtime/state/runtime", () => ({ runAtomCommand }));

const environmentId = EnvironmentId.make("environment-1");
const IDLE_MS = 30_000;

describe("recordPromptSent", () => {
  vi.useFakeTimers();

  it("is disabled and never writes localStorage, queries GitHub, or shows a prompt", async () => {
    add.mockReset();
    update.mockReset();
    openExternal.mockClear();
    runAtomCommand.mockClear();
    const store = new Map<string, string>();
    const events = new EventTarget();
    vi.stubGlobal("document", { hasFocus: () => true, activeElement: null });
    vi.stubGlobal("window", {
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => void store.set(key, value),
      },
    });

    vi.resetModules();
    const session = await import("./GitHubStarPrompt");
    for (let index = 0; index < 10; index += 1) {
      const pending = session.recordPromptSent(environmentId);
      await vi.advanceTimersByTimeAsync(IDLE_MS);
      await pending;
    }

    expect(store.size).toBe(0);
    expect(runAtomCommand).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
