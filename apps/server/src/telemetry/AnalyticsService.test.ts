import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../config.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as AnalyticsService from "./AnalyticsService.ts";

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("AnalyticsService test", (it) => {
  it.effect(
    "is disabled and sends no HTTP requests or files even when telemetry env vars are set",
    () =>
      Effect.gen(function* () {
        const requests: Array<string> = [];
        const client = HttpClient.make((request) =>
          Effect.sync(() => {
            requests.push(request.url);
            return HttpClientResponse.fromWeb(request, new Response(null, { status: 204 }));
          }),
        );
        const layerServerConfig = ServerConfig.ServerConfig.layerTest(process.cwd(), {
          prefix: "t3-telemetry-disabled-",
        });
        const runtimeLayer = AnalyticsService.layer.pipe(
          Layer.provideMerge(layerServerConfig),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                T3CODE_TELEMETRY_ENABLED: true,
                T3CODE_POSTHOG_KEY: "phc_test_key",
                T3CODE_POSTHOG_HOST: "http://localhost",
              }),
            ),
          ),
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(HostProcess.Platform, "linux"),
              Layer.succeed(HostProcess.Architecture, "arm64"),
              Layer.succeed(HttpClient.HttpClient, client),
              ManagedPolicy.layerTest({
                schemaVersion: 1,
                organization: "Example Corp",
                limits: { telemetry: true },
              }),
            ),
          ),
        );

        yield* Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          const analytics = yield* AnalyticsService.AnalyticsService;

          assert.isFalse(yield* analytics.record("test.event", { index: 1 }));
          yield* analytics.recordOwners([{ source: "connect", ownerId: "a".repeat(64) }], "server");
          yield* analytics.flush;
          yield* TestClock.adjust("5 minutes");

          assert.isFalse(yield* fileSystem.exists(config.anonymousIdPath));
        }).pipe(Effect.provide(runtimeLayer));

        assert.deepEqual(requests, []);
      }),
  );
});
