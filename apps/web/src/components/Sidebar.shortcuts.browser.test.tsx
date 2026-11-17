import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { useRightPanelStore } from "~/rightPanelStore";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

vi.mock(import("~/state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+shift+]", command: "thread.next", when: "!previewFocus && !previewOpen" },
    { key: "mod+1", command: "thread.jump.1", when: "!previewFocus" },
    { key: "mod+2", command: "thread.jump.2", when: "!previewFocus" },
  ]);
  return { ...actual, primaryServerKeybindingsAtom: Atom.make(keybindings) };
});

// Both tests list the same threads: the fake socket's later snapshot does not replace the first.
// The list draws `failed` first because it needs you, then `first` because you messaged it last.
const first = {
  ...threadWithHistory("thread-b", 1),
  shell: { latestUserMessageAt: DateTime.makeUnsafe("2026-06-01T00:00:00.000Z") },
};
const second = threadWithHistory("thread-a", 1);
const failed = {
  ...threadWithHistory("thread-z", 1),
  shell: { status: "failed" as const, lastVisitedAt: null },
};

it("leaves thread shortcuts and their hints to the preview when their rules exclude it", async () => {
  using _environment = installFakeEnvironment([first, second, failed]);
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Thread ${second.id}`).first()).toBeVisible();

  const previewChrome = document.createElement("div");
  previewChrome.dataset.previewPanelMode = "browser";
  previewChrome.innerHTML = '<button type="button">Reload</button>';
  document.body.append(previewChrome);
  using _chrome = { [Symbol.dispose]: () => previewChrome.remove() };

  const press = () => userEvent.keyboard("{Control>}{Shift>}]{/Shift}{/Control}");
  const jumpHint = () => document.querySelector("[data-jump-hint]");
  const whileHoldingControl = async (assertJumpHints: () => void) => {
    // Every deadline reads as due on subscribe, so hints skip the hold delay.
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    using _clock = vi.spyOn(Date, "now").mockImplementation(() => (now += 1000));
    await userEvent.keyboard("{Control>}");
    await act(() => {});
    await vi.waitFor(assertJumpHints);
    await userEvent.keyboard("{/Control}");
  };
  const firstPath = `/${ENVIRONMENT_ID}/${first.id}`;

  await userEvent.click(page.getByRole("button", { name: "Reload" }));
  await press();
  expect(router.history.location.pathname).toBe(firstPath);
  await whileHoldingControl(() => expect(jumpHint()).toBeNull());

  const firstRef = scopeThreadRef(ENVIRONMENT_ID, first.id);
  await act(() => useRightPanelStore.getState().openBrowser(firstRef, null));
  if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
  await press();
  expect(router.history.location.pathname).toBe(firstPath);

  await act(() => useRightPanelStore.getState().close(firstRef));
  await press();
  await vi.waitFor(() =>
    expect(router.history.location.pathname).toBe(`/${ENVIRONMENT_ID}/${second.id}`),
  );
  await whileHoldingControl(() => expect(jumpHint()).not.toBeNull());
});

it("jumps by the drawn order: what needs you, then the Trail by last message sent", async () => {
  using _environment = installFakeEnvironment([first, second, failed]);
  using _platform = vi.spyOn(navigator, "platform", "get").mockReturnValue("Linux x86_64");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  await page.viewport(1400, 900);
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${second.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Thread ${failed.id}`).first()).toBeVisible();

  await userEvent.keyboard("{Control>}2{/Control}");
  await vi.waitFor(() =>
    expect(router.history.location.pathname).toBe(`/${ENVIRONMENT_ID}/${first.id}`),
  );
  await userEvent.keyboard("{Control>}1{/Control}");
  await vi.waitFor(() =>
    expect(router.history.location.pathname).toBe(`/${ENVIRONMENT_ID}/${failed.id}`),
  );
});
