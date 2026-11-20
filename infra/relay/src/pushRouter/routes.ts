import {
  RelayAgentActivityPublishRequest,
  RelayAuthInvalidError,
  type RelayAuthInvalidReason,
  RelayDeviceRegistrationRequest,
  RelayDeviceUnregistrationParams,
  RelayLiveActivityRegistrationRequest,
  RelayMobileClientId,
  RelayMobileRegistrationScope,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import * as AgentActivityPublisher from "../agentActivity/AgentActivityPublisher.ts";
import * as MobileRegistrations from "../agentActivity/MobileRegistrations.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as EnvironmentPublishSignatures from "../environments/EnvironmentPublishSignatures.ts";

export const routes = (settings: { origin: string; accountId: string; bundleId: string }) =>
  HttpRouter.use((router) =>
    Effect.gen(function* () {
      const registrations = yield* MobileRegistrations.MobileRegistrations;
      const publisher = yield* AgentActivityPublisher.AgentActivityPublisher;
      const links = yield* EnvironmentLinks.EnvironmentLinks;
      const signatures = yield* EnvironmentPublishSignatures.EnvironmentPublishSignatures;
      const tokens = yield* RelayTokens.RelayTokens;
      const proofs = yield* DpopProofs.DpopProofReplay;
      const unauthorized = HttpServerResponse.empty({ status: 401 });
      const badRequest = HttpServerResponse.empty({ status: 400 });
      const rejectRegistration = Effect.fn("pushRouter.rejectRegistration")(function* (
        reason: RelayAuthInvalidReason,
      ) {
        const traceId = yield* Effect.currentParentSpan.pipe(
          Effect.map((span) => span.traceId),
          Effect.orElseSucceed(() => "unavailable"),
        );
        const error = new RelayAuthInvalidError({ code: "auth_invalid", reason, traceId });
        return yield* Effect.fail(HttpServerResponse.jsonUnsafe(error, { status: 401 }));
      });

      const authenticate = Effect.gen(function* () {
        const req = yield* HttpServerRequest.HttpServerRequest;
        const token = /^DPoP ([^ ]+)$/i.exec(req.headers.authorization ?? "")?.[1];
        if (!token) return yield* rejectRegistration("missing_bearer");
        const claims = yield* tokens.verifyDpopAccessToken({ token });
        if (!claims) return yield* rejectRegistration("invalid_bearer");
        if (
          claims.sub !== settings.accountId ||
          claims.client_id !== RelayMobileClientId ||
          !claims.scope.includes(RelayMobileRegistrationScope)
        ) {
          return yield* rejectRegistration("not_authorized");
        }
        yield* proofs
          .verifyAndConsume({
            proof: req.headers.dpop,
            method: req.method,
            url: settings.origin + req.url,
            expectedAccessToken: token,
            expectedThumbprint: claims.cnf.jkt,
            now: yield* DateTime.now,
          })
          .pipe(Effect.catchTags({ DpopProofRejected: () => rejectRegistration("invalid_dpop") }));
        return claims.sub;
      });
      const body = <A>(schema: Schema.ConstraintDecoder<A>) =>
        HttpServerRequest.schemaBodyJson(schema).pipe(Effect.mapError(() => badRequest));
      const respond = <A, E, R>(op: Effect.Effect<A, E, R>) =>
        op.pipe(
          Effect.map((value) => HttpServerResponse.jsonUnsafe(value)),
          Effect.catch((error) =>
            HttpServerResponse.isHttpServerResponse(error)
              ? Effect.succeed(error)
              : Effect.logError("Push router request failed", {
                  errorType: error instanceof Error ? error.name : "unknown",
                }).pipe(Effect.as(HttpServerResponse.empty({ status: 503 }))),
          ),
        );

      yield* router.add(
        "GET",
        "/v1/mobile/push-health",
        HttpServerResponse.jsonUnsafe({ ok: true }),
      );
      yield* router.add(
        "POST",
        "/v1/mobile/devices",
        respond(
          Effect.gen(function* () {
            const userId = yield* authenticate;
            const payload = yield* body(RelayDeviceRegistrationRequest);
            if (
              payload.platform !== "ios" ||
              payload.bundleId !== settings.bundleId ||
              !payload.apsEnvironment
            )
              return yield* Effect.fail(badRequest);
            return yield* registrations.registerDevice({ userId, payload });
          }),
        ),
      );
      yield* router.add(
        "POST",
        "/v1/mobile/live-activities",
        respond(
          Effect.gen(function* () {
            const userId = yield* authenticate;
            return yield* registrations.registerLiveActivity({
              userId,
              payload: yield* body(RelayLiveActivityRegistrationRequest),
            });
          }),
        ),
      );
      yield* router.add(
        "DELETE",
        "/v1/mobile/devices/:deviceId",
        respond(
          Effect.gen(function* () {
            const userId = yield* authenticate;
            const { deviceId } = yield* HttpRouter.schemaParams(
              RelayDeviceUnregistrationParams,
            ).pipe(Effect.mapError(() => badRequest));
            return yield* registrations.unregisterDevice({ userId, deviceId });
          }),
        ),
      );
      yield* router.add(
        "POST",
        "/v1/environments/:environmentId/threads/:threadId/agent-activity",
        respond(
          Effect.gen(function* () {
            const { environmentId, threadId } = yield* HttpRouter.schemaParams(
              Schema.Struct({ environmentId: Schema.String, threadId: Schema.String }),
            );
            const link = yield* links.getForUser({ userId: settings.accountId, environmentId });
            if (!link) return yield* Effect.fail(unauthorized);
            const request = yield* body(RelayAgentActivityPublishRequest);
            const target = {
              environmentId,
              threadId,
              environmentPublicKey: link.environmentPublicKey,
            };
            yield* signatures.verify({ ...target, request }).pipe(
              Effect.catchTags({
                EnvironmentPublishSignatureInvalid: () => Effect.fail(unauthorized),
                EnvironmentPublishSignatureExpired: () => Effect.fail(unauthorized),
              }),
            );
            return yield* publisher.publish({ ...target, state: request.state });
          }),
        ),
      );
    }),
  );
