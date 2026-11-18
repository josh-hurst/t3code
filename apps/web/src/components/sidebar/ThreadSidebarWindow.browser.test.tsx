import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { Sidebar, SidebarContent, SidebarFooter, SidebarProvider } from "../ui/sidebar";
import { ThreadSidebarWindow } from "./ThreadSidebarWindow";

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
