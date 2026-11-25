import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  settledAwayDismissed,
  settledAwayLeft,
  settledAwayReturned,
  settledAwayStart,
  threadsSettledWhileAway,
} from "./settledWhileAway.ts";

const at = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const thread = (id: string, autoSettledAt: number | null, extra: object = {}) => ({
  id,
  settledOverride: "settled" as const,
  autoSettledAt: autoSettledAt === null ? null : at(autoSettledAt),
  ...extra,
});

describe("settledWhileAway", () => {
  it("lists server settles made while the list was off screen, across absences, until dismissed", () => {
    const threads = [
      thread("before", 50),
      thread("first-absence", 150),
      thread("while-looking", 250),
      thread("second-absence", 350),
      thread("by-owner", null),
      thread("woken", 160, { settledOverride: "active" }),
      thread("nested", 170, { nestedUnder: "first-absence" }),
    ];
    const ids = (state: ReturnType<typeof settledAwayStart>) =>
      threadsSettledWhileAway(threads, state.away).map((row) => row.id);

    let state = settledAwayStart(100);
    expect(ids(state)).toEqual([]);
    state = settledAwayReturned(state, 200);
    expect(ids(state)).toEqual(["first-absence"]);
    state = settledAwayReturned(settledAwayLeft(state, 300), 400);
    expect(ids(state)).toEqual(["first-absence", "second-absence"]);
    // A repeated leave keeps the first time away.
    state = settledAwayReturned(
      settledAwayLeft(settledAwayLeft(settledAwayDismissed(state), 300), 340),
      400,
    );
    expect(ids(state)).toEqual(["second-absence"]);
    expect(ids(settledAwayDismissed(state))).toEqual([]);
    expect(ids(settledAwayReturned(settledAwayStart(null), 400))).toEqual([]);
  });
});
