import { createMemoryHistory } from "@tanstack/react-router";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The thread route loads ChatView lazily; its first transform would eat the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";
import { makeThreadFixture } from "../test-fixtures";
import { SidebarSearchResultRow } from "./sidebar/SidebarThreadRow";

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

it("shows the titled preview inside and outside search results from a collapsed folder", async () => {
  await page.viewport(1400, 900);
  const [first, second] = [threadWithHistory("visible", 1), threadWithHistory("search-target", 1)];
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    // Project folders belong to the classic sidebar.
    sidebarClassicEnabled: true,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const folder = page.getByRole("button", { name: /^render/ });
  await expect.element(folder).toHaveAttribute("aria-expanded", "true");
  // A removed row fades out as a clone without its test id, so match the live row only.
  const secondRow = page.getByTestId("sidebar-row-folder").filter({ hasText: second.title });
  await expect.element(secondRow).toBeInTheDocument();
  // The shift guard drops pointer presses on a row that appeared under 500ms ago; keys pass.
  folder.element().focus();
  await userEvent.keyboard("{Enter}");
  await expect.element(secondRow).not.toBeInTheDocument();
  await userEvent.fill(page.getByRole("combobox", { name: "Search threads" }), "search-target");
  const result = page.getByRole("option", { name: /Thread search-target/ });
  await expect.element(result).toBeVisible();
  const bounds = result.element().getBoundingClientRect();
  const pointer = (type: string, x: number, y: number) =>
    new PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      pointerId: 1,
      isPrimary: true,
      button: 0,
      buttons: type === "pointerup" ? 0 : 1,
      clientX: x,
      clientY: y,
    });
  using _release = {
    [Symbol.dispose]: () => document.dispatchEvent(pointer("pointerup", -100, 100)),
  };
  await act(() => {
    result.element().dispatchEvent(pointer("pointerdown", bounds.x + 10, bounds.y + 10));
    document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 10));
  });
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
  await act(() => document.dispatchEvent(pointer("pointermove", -100, 100)));
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
  await act(() => document.dispatchEvent(pointer("pointermove", bounds.x + 30, bounds.y + 10)));
  await vi.waitFor(() => {
    expect(
      document.querySelector('body > div[aria-hidden="true"].pointer-events-none')?.textContent,
    ).toBe(second.title);
  });
  await act(() =>
    document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true })),
  );
  await vi.waitFor(() => {
    expect(document.querySelector('body > div[aria-hidden="true"].pointer-events-none')).toBeNull();
  });
});

it("keeps focus in the search box when a click picks a search result", async () => {
  const onSelect = vi.fn();
  await using screen = await render(
    <>
      <input aria-label="Search threads" />
      <ul role="listbox">
        <SidebarSearchResultRow
          isSettled={false}
          thread={makeThreadFixture({ title: "Invoice export" })}
          project={null}
          projectDisplayName={null}
          environmentLabel={null}
          environmentMachine="server"
          providerEntryByInstanceId={new Map()}
          isHighlighted={false}
          isRouteActive={false}
          resultId="result-0"
          searchMatch={null}
          searchQuery="invoice"
          tide={false}
          now="2026-01-01T00:00:00.000Z"
          projectNameOnRow={null}
          onHighlight={() => {}}
          onSelect={onSelect}
          onFileDropThreads={() => {}}
        />
      </ul>
    </>,
  );
  const search = screen.getByRole("textbox", { name: "Search threads" });
  await userEvent.click(search);
  await userEvent.click(screen.getByRole("option"));
  expect(onSelect).toHaveBeenCalledOnce();
  // Picking clears the results; a focused result would drop focus, and its recovery scrolls the list.
  await expect.element(search).toHaveFocus();
});

it("keeps detached thread navigation, keyboard focus, and context menus in their windows", async () => {
  await page.viewport(1400, 900);
  const [first, second] = [threadWithHistory("visible", 1), threadWithHistory("search-target", 1)];
  using _environment = installFakeEnvironment([first, second]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    sidebarClassicEnabled: true,
    boringSidebarEnabled: true,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const previousPosition = localStorage.getItem("chat_thread_sidebar_position");
  localStorage.setItem("chat_thread_sidebar_position", JSON.stringify({ x: 0, y: 0 }));
  using _position = {
    [Symbol.dispose]() {
      if (previousPosition === null) localStorage.removeItem("chat_thread_sidebar_position");
      else localStorage.setItem("chat_thread_sidebar_position", previousPosition);
    },
  };
  const router = getRouter(
    createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${first.id}`] }),
  );
  await router.load();
  await using screen = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  const folder = page.getByRole("button", { name: /^render/ });
  await expect.element(folder).toBeVisible();
  if (folder.element().getAttribute("aria-expanded") === "false") {
    folder.element().focus();
    await userEvent.keyboard("{Enter}");
  }
  using open = vi.spyOn(window, "open");
  using _popup = {
    [Symbol.dispose]() {
      for (const result of open.mock.results) {
        if (result.type === "return") result.value?.close();
      }
    },
  };
  await userEvent.click(screen.getByRole("button", { name: "Open sidebar in a separate window" }));
  const popup = open.mock.results[0]!.value as Window;
  await vi.waitFor(() =>
    expect(
      popup.document.querySelector('[data-testid="sidebar-project-folder"] button'),
    ).not.toBeNull(),
  );
  const popupFolder = popup.document.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-project-folder"] button',
  )!;
  if (popupFolder.getAttribute("aria-expanded") === "false") await act(() => popupFolder.click());
  const row = () =>
    [...popup.document.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-folder"]')].find(
      (element) => element.textContent?.includes(second.title),
    );
  await vi.waitFor(() => expect(row(), popup.document.body.innerText).toBeDefined());
  const rows = [
    ...popup.document.querySelectorAll<HTMLElement>('[data-testid="sidebar-row-folder"]'),
  ];
  await act(() => {
    rows[0]!.focus();
    rows[0]!.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }),
    );
  });
  expect(popup.document.activeElement).toBe(rows[1]);
  await act(() => row()!.click());
  await vi.waitFor(() =>
    expect(router.state.location.pathname).toBe(`/${ENVIRONMENT_ID}/${second.id}`),
  );
  await act(() => {
    row()!.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 120 }),
    );
  });
  await vi.waitFor(() =>
    expect(popup.document.querySelector('[data-context-menu="true"]')).not.toBeNull(),
  );
  expect(document.querySelector('[data-context-menu="true"]')).toBeNull();
  popup.close();
  await expect
    .element(screen.getByRole("button", { name: "Open sidebar in a separate window" }))
    .toBeVisible();
});
