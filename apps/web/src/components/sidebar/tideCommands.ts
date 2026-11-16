type TideCommand = "thread.nextNeedsYou" | "thread.clearTrail" | "sidebar.focusProject";

type TideCommandHandlers = Readonly<Record<TideCommand, () => void>>;

let registered: TideCommandHandlers | null = null;

/** The sidebar owns the list these commands act on; the command palette runs them through here. */
export function registerTideCommands(handlers: TideCommandHandlers): () => void {
  registered = handlers;
  return () => {
    if (registered === handlers) registered = null;
  };
}

/** False means no sidebar is mounted. */
export function runTideCommand(command: TideCommand): boolean {
  if (registered === null) return false;
  registered[command]();
  return true;
}
