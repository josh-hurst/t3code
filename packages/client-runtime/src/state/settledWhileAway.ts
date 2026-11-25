/**
 * Threads the server settled on its own while this device was not showing the thread list.
 * Each client reports when it stops and starts showing the list; the notice gathers the stretches
 * away until the owner acts on it, so two short absences read as one.
 */
export interface SettledAwayState {
  /** When the list stopped being on screen, or null while it is. */
  readonly awayFromMs: number | null;
  /** Stretches away, each `[fromMs, toMs]`, since the owner last acted on the notice. */
  readonly away: ReadonlyArray<readonly [number, number]>;
}

/** `lastLookedAtMs` is what the client stored the last time it stopped showing the list. */
export function settledAwayStart(lastLookedAtMs: number | null): SettledAwayState {
  return { awayFromMs: lastLookedAtMs, away: [] };
}

export function settledAwayLeft(state: SettledAwayState, nowMs: number): SettledAwayState {
  return state.awayFromMs === null ? { ...state, awayFromMs: nowMs } : state;
}

export function settledAwayReturned(state: SettledAwayState, nowMs: number): SettledAwayState {
  if (state.awayFromMs === null) return state;
  // Bounded for a notice left alone through days of app switching.
  return {
    awayFromMs: null,
    away: [...state.away, [state.awayFromMs, nowMs] as const].slice(-100),
  };
}

export function settledAwayDismissed(state: SettledAwayState): SettledAwayState {
  return state.away.length === 0 ? state : { ...state, away: [] };
}

/** Top-level threads still settled that the server settled during a stretch away. */
export function threadsSettledWhileAway<
  T extends {
    readonly settledOverride: "settled" | "active" | null;
    readonly autoSettledAt?: string | null;
    readonly nestedUnder?: unknown;
  },
>(threads: readonly T[], away: SettledAwayState["away"]): T[] {
  if (away.length === 0) return [];
  return threads.filter((thread) => {
    if (!thread.autoSettledAt || thread.settledOverride !== "settled") return false;
    if (thread.nestedUnder != null) return false;
    const atMs = Date.parse(thread.autoSettledAt);
    return away.some(([fromMs, toMs]) => atMs > fromMs && atMs <= toMs);
  });
}
