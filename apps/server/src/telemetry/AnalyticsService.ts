// Product analytics / PostHog telemetry is disabled in this fork.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { TelemetryOwner } from "./Identify.ts";

export class AnalyticsService extends Context.Service<
  AnalyticsService,
  {
    /** Whether the event was queued to send; always false with telemetry disabled. */
    readonly record: (
      event: string,
      properties?: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<boolean>;

    readonly flush: Effect.Effect<void>;

    /** No-op with telemetry disabled. */
    readonly recordOwners: (
      owners: ReadonlyArray<TelemetryOwner>,
      observedBy: "server" | "client",
    ) => Effect.Effect<void>;
  }
>()("t3/telemetry/AnalyticsService") {}

/** @public */
export const make = Effect.succeed(
  AnalyticsService.of({
    record: Effect.fn("AnalyticsService.record")(
      (_event: string, _properties?: Readonly<Record<string, unknown>>) => Effect.succeed(false),
    ),
    flush: Effect.void,
    recordOwners: Effect.fn("AnalyticsService.recordOwners")(
      (_owners: ReadonlyArray<TelemetryOwner>, _observedBy: "server" | "client") => Effect.void,
    ),
  }),
);

export const layer = Layer.effect(AnalyticsService, make);
