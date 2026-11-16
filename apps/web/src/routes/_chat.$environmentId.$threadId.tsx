import { createFileRoute } from "@tanstack/react-router";

/** `m`: a message to open the thread at, such as where a History topic started. */
export interface ThreadRouteSearch {
  readonly m?: string;
}

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  validateSearch: (raw: Record<string, unknown>): ThreadRouteSearch =>
    typeof raw.m === "string" && raw.m.length > 0 ? { m: raw.m.slice(0, 128) } : {},
  component: () => null,
});
