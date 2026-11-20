import { expect, it } from "@effect/vitest";
import { RelayMobileClientId, RelayMobileRegistrationScope } from "@t3tools/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";
import { routes } from "./routes.ts";

it.effect(
  "only registers the owner's iOS topic and tells the client when to refresh its access token",
  () =>
    Effect.gen(function* () {
      const settings = {
        origin: "https://push.example.test",
        bundleId: "dev.example.t3",
        accountId: "owner",
      };
      const registered: string[] = [];
      const app = yield* HttpRouter.toHttpEffect(
        routes(settings).pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(RelayTokens.RelayTokens, {
                resolveDpopAccessTokenScopes: () => null,
                verifyDpopAccessToken: ({ token }) =>
                  Effect.succeed(
                    token === "expired"
                      ? null
                      : {
                          sub: token === "other-owner" ? "someone-else" : "owner",
                          client_id: RelayMobileClientId,
                          iss: "https://relay.example.test",
                          aud: "https://relay.example.test",
                          iat: 0,
                          exp: 60,
                          jti: "example",
                          cnf: { jkt: "key" },
                          scope: token === "unscoped" ? [] : [RelayMobileRegistrationScope],
                        },
                  ),
              }),
              Layer.mock(DpopProofs.DpopProofReplay, {
                verifyAndConsume: ({ proof, url }) =>
                  proof === "valid" && url === settings.origin + "/v1/mobile/devices"
                    ? Effect.succeed("key")
                    : Effect.fail(new DpopProofs.DpopProofRejected({ code: "replayed" })),
              }),
              Layer.mock(MobileRegistrations.MobileRegistrations, {
                registerDevice: ({ userId }) =>
                  Effect.sync(() => {
                    registered.push(userId);
                    return { ok: true as const };
                  }),
              }),
              Layer.mock(AgentActivityPublisher.AgentActivityPublisher, {}),
              Layer.mock(EnvironmentLinks.EnvironmentLinks, {}),
              Layer.mock(EnvironmentPublishSignatures.EnvironmentPublishSignatures, {}),
            ),
          ),
        ),
      );
      const send = (token: string, proof: string, bundleId = settings.bundleId) =>
        app.pipe(
          Effect.provideService(
            HttpServerRequest.HttpServerRequest,
            HttpServerRequest.fromWeb(
              new Request(settings.origin + "/v1/mobile/devices", {
                method: "POST",
                headers: {
                  authorization: "DPoP " + token,
                  dpop: proof,
                  "content-type": "application/json",
                },
                body: JSON.stringify({
                  deviceId: "phone",
                  label: "Phone",
                  platform: "ios",
                  iosMajorVersion: 18,
                  apsEnvironment: "sandbox",
                  bundleId,
                  preferences: {
                    notificationsEnabled: true,
                    liveActivitiesEnabled: true,
                    notifyOnInput: true,
                    notifyOnApproval: true,
                    notifyOnCompletion: true,
                    notifyOnFailure: true,
                  },
                }),
              }),
            ),
          ),
        );
      expect((yield* send("other-owner", "valid")).status).toBe(401);
      expect((yield* send("unscoped", "valid")).status).toBe(401);
      expect((yield* send("owner", "replayed")).status).toBe(401);
      expect((yield* send("owner", "valid", "dev.example.other")).status).toBe(400);
      expect((yield* send("owner", "valid")).status).toBe(200);
      expect(registered).toEqual(["owner"]);
      const expired = yield* send("expired", "valid");
      expect(expired.status).toBe(401);
      expect(yield* Effect.promise(() => HttpServerResponse.toWeb(expired).json())).toMatchObject({
        _tag: "RelayAuthInvalidError",
        reason: "invalid_bearer",
      });
    }),
);
