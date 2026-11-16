type TideCommand =
  | "thread.nextNeedsYou"
  | "thread.clearTrail"
  | "sidebar.focusProject"
  | "project.markPublished";

type TideCommandHandlers = Readonly<Partial<Record<TideCommand, () => void>>>;

let registered: TideCommandHandlers | null = null;

/** The sidebar owns the list these commands act on; the command palette runs them through here. */
export function registerTideCommands(handlers: TideCommandHandlers): () => void {
  registered = handlers;
  return () => {
    if (registered === handlers) registered = null;
  };
}

/** False means no sidebar is mounted, or it does not offer the command. */
export function runTideCommand(command: TideCommand): boolean {
  const handler = registered?.[command];
  if (handler === undefined) return false;
  handler();
  return true;
}
