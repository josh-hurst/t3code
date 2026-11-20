import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { StrictMode, useState } from "react";

import "~/index.css";
import { act, render } from "../../../test/render";
import { Sidebar, SidebarContent, SidebarFooter, SidebarProvider } from "../ui/sidebar";
import { ThreadSidebarWindow } from "./ThreadSidebarWindow";

it.each(["pin", "close"] as const)(
  "detaches a sidebar dropped outside the app and restores it on %s",
  async (restore) => {
    await page.viewport(1000, 700);
    function Workspace() {
      const [position, setPosition] = useState<{ x: number; y: number } | null>({ x: 0, y: 0 });
      const [count, setCount] = useState(0);
      return (
        <SidebarProvider>
          <Sidebar variant="frameless" overlay={position !== null}>
            <ThreadSidebarWindow position={position} onPositionChange={setPosition}>
              <SidebarContent>
                <button type="button" onClick={() => setCount(count + 1)}>
                  Open thread {count}
                </button>
              </SidebarContent>
            </ThreadSidebarWindow>
          </Sidebar>
        </SidebarProvider>
      );
    }
    await using screen = await render(
      <StrictMode>
        <Workspace />
      </StrictMode>,
    );
    using open = vi.spyOn(window, "open");
    using _popup = {
      [Symbol.dispose]() {
        for (const result of open.mock.results) {
          if (result.type === "return") result.value?.close();
        }
      },
    };
    const handle = screen.getByRole("button", { name: "Move Threads window" }).element();
    const rect = handle.getBoundingClientRect();
    const pointer = (type: string, x: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: type === "pointerup" ? 0 : 1,
        clientX: x,
        clientY: rect.top + 10,
      });
    await act(() => handle.dispatchEvent(pointer("pointerdown", rect.left + 10)));
    await act(() => document.dispatchEvent(pointer("pointermove", -80)));
    await act(() => document.dispatchEvent(pointer("pointerup", -80)));
    expect(open).toHaveBeenCalledOnce();
    const popup = open.mock.results[0]!.value as Window;
    await vi.waitFor(() => {
      expect(popup.document.querySelector('[data-sidebar-window="detached"]')).not.toBeNull();
    });
    expect(screen.container.querySelector('[data-sidebar-window="floating"]')).toBeNull();
    const thread = [...popup.document.querySelectorAll("button")].find(
      (button) => button.textContent === "Open thread 0",
    )!;
    await act(() => thread.click());
    await vi.waitFor(() => expect(popup.document.body.textContent).toContain("Open thread 1"));
    if (restore === "pin") {
      const pin = popup.document.querySelector<HTMLButtonElement>(
        '[aria-label="Pin sidebar beside chat"]',
      )!;
      await act(() => pin.click());
    } else {
      popup.close();
    }
    await expect.element(screen.getByRole("button", { name: "Open thread 1" })).toBeVisible();
    expect(popup.closed).toBe(true);
    expect(
      screen.container.querySelector(
        `[data-sidebar-window="${restore === "pin" ? "pinned" : "floating"}"]`,
      ),
    ).not.toBeNull();
  },
);

it("keeps the floating sidebar accessible when the browser blocks its popup", async () => {
  await page.viewport(1000, 700);
  await using screen = await render(
    <SidebarProvider>
      <Sidebar variant="frameless" overlay>
        <ThreadSidebarWindow position={{ x: 0, y: 0 }} onPositionChange={vi.fn()}>
          <SidebarContent>Threads</SidebarContent>
        </ThreadSidebarWindow>
      </Sidebar>
    </SidebarProvider>,
  );
  using _open = vi.spyOn(window, "open").mockReturnValue(null);
  await userEvent.click(screen.getByRole("button", { name: "Open sidebar in a separate window" }));
  await expect.element(screen.getByRole("button", { name: "Move Threads window" })).toBeVisible();
  expect(screen.container.querySelector('[data-sidebar-window="floating"]')).not.toBeNull();
});

it("keeps a long thread list scrollable and the footer reachable in a short window", async () => {
  await page.viewport(900, 420);
  await using screen = await render(
    <SidebarProvider>
      <Sidebar variant="frameless" overlay>
        <ThreadSidebarWindow position={{ x: 1200, y: 700 }} onPositionChange={vi.fn()}>
          <SidebarContent>
            <div className="h-[900px]">Threads</div>
          </SidebarContent>
          <SidebarFooter>Settings</SidebarFooter>
        </ThreadSidebarWindow>
      </Sidebar>
    </SidebarProvider>,
    { router: false /* The window uses viewport geometry. */ },
  );
  const viewport = screen.container.querySelector<HTMLElement>(
    '[data-slot="scroll-area-viewport"]',
  )!;
  viewport.scrollTop = viewport.scrollHeight;
  expect(viewport.scrollTop).toBeGreaterThan(0);
  const footer = screen.getByText("Settings").element().getBoundingClientRect();
  expect(footer.bottom).toBeLessThan(window.innerHeight);
  expect(footer.right).toBeLessThan(window.innerWidth);
  expect(viewport.getBoundingClientRect().bottom).toBeLessThanOrEqual(footer.top);
});
