import { createFileRoute, redirect } from "@tanstack/react-router";

import { ThreadPopoutView } from "../components/ThreadPopoutView";
import { resolveThreadRouteRef } from "../threadRoutes";

// A thread in its own floating window. The root renders this outside the app shell.
export const Route = createFileRoute("/popout/$environmentId/$threadId")({
  beforeLoad: ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: function ThreadPopoutRoute() {
    const threadRef = resolveThreadRouteRef(Route.useParams());
    return threadRef === null ? null : <ThreadPopoutView threadRef={threadRef} />;
  },
});
