import { createFileRoute, redirect } from "@tanstack/react-router";

import { isThreadPopoutWindow } from "../lib/threadPopoutWindow";

// A thread in its own floating window. The root renders pop-outs outside the app shell.
export const Route = createFileRoute("/popout/$environmentId/$threadId")({
  beforeLoad: ({ context, params }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
    // Only a pop-out window renders this route; anywhere else it shows the thread normally.
    if (!isThreadPopoutWindow) {
      throw redirect({ to: "/$environmentId/$threadId", params, replace: true });
    }
  },
  component: () => null,
});
