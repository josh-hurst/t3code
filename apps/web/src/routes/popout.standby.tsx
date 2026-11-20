import { createFileRoute, redirect } from "@tanstack/react-router";

// A pop-out pre-loaded while hidden; the main window points it at a thread to show it.
export const Route = createFileRoute("/popout/standby")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: () => null,
});
